import { createRef } from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { Editor } from '@tiptap/core';
import { DocumentEditor, type DocumentEditorHandle } from './DocumentEditor';
import * as markdownRenderer from '../markdown/renderMarkdown';
import { closeHistory } from '@tiptap/pm/history';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function mount(content: string) {
  const ref = createRef<DocumentEditorHandle>();
  const props = { ref, content, active: true, disabled: false, images: {}, query: '', searchIndex: 0,
    onChange: vi.fn(), onTransaction: vi.fn(), onImageSources: vi.fn(), onSearch: vi.fn(),
    onOutline: vi.fn(), onOpenLink: vi.fn(), onError: vi.fn(), onRecover: vi.fn() };
  const view = render(<DocumentEditor {...props} />);
  await waitFor(() => expect(props.onOutline).toHaveBeenCalled());
  act(() => ref.current!.editor!.view.setProps({ handleScrollToSelection: () => true }));
  return { ref, props, view, editor: ref.current!.editor! };
}

function replaceRaw(editor: Editor, includes: string, replacement: string) {
  let range: { from: number; to: number } | undefined;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'rawSource' && node.textContent.includes(includes)) range = { from: pos + 1, to: pos + node.nodeSize - 1 };
  });
  if (!range) throw new Error('Raw source fixture not found: ' + includes);
  act(() => editor.view.dispatch(editor.state.tr.insertText(replacement, range!.from, range!.to)));
}

test.each([false, true])('resolves reference links and images across raw fragments; definitions first=%s', async first => {
  const definitions = '[doc]: ./target.md "Target"\n[img]: ./first.png';
  const fragment = '<span>说明</span> [文档][DOC] ![图片][img]';
  const { view, props } = await mount('# Title\n\n' + (first ? definitions + '\n\n' + fragment : fragment + '\n\n' + definitions));
  expect(view.container.querySelector('.raw-source-preview a')?.getAttribute('data-md-href')).toBe('./target.md');
  expect(view.container.querySelector('.raw-source-preview [data-local-src]')?.getAttribute('data-local-src')).toBe('./first.png');
  expect(props.onImageSources).toHaveBeenLastCalledWith(['./first.png']);
  expect(props.onTransaction).not.toHaveBeenCalledWith(expect.objectContaining({ dirty: true }));
});

test('editing or deleting definitions refreshes unchanged fragment previews and image sources', async () => {
  const { editor, view, props } = await mount('# Title\n\n<span>说明</span> [文档][doc] ![图片][img]\n\n[doc]: ./first.md\n[img]: ./first.png');
  replaceRaw(editor, '[doc]:', '[doc]: ./second.md\n[img]: ./second.png');
  expect(view.container.querySelector('.raw-source-preview a')?.getAttribute('data-md-href')).toBe('./second.md');
  expect(props.onImageSources).toHaveBeenLastCalledWith(['./second.png']);
  replaceRaw(editor, '[doc]:', '');
  expect(view.container.querySelector('.raw-source-preview a')).toBeNull();
  expect(view.container.querySelector('.raw-source-preview [data-local-src]')).toBeNull();
  expect(props.onImageSources).toHaveBeenLastCalledWith([]);
});

test('reference normalization and first-definition precedence use the existing parser', async () => {
  const { view } = await mount('# Title\n\n[  D o C  ]: ./first.md\n\n<span>x</span> [link][d   o c]\n\n[D O C]: ./second.md');
  expect(view.container.querySelector('.raw-source-preview a')?.getAttribute('data-md-href')).toBe('./first.md');
});

test('raw references keep URLs inert and retain existing image and HTML sanitization', async () => {
  const { view } = await mount('# Title\n\n<span onclick="evil()">x</span> [external][doc] ![image][img]\n\n[doc]: https://example.com\n[img]: ./image.png');
  const link = view.container.querySelector('.raw-source-preview a');
  expect(link?.getAttribute('data-md-href')).toBe('https://example.com');
  expect(link?.getAttribute('href')).toBe('#');
  expect(view.container.querySelector('[onclick]')).toBeNull();
  expect(view.container.querySelector('.raw-source-preview img[src]')).toBeNull();
});

test('raw and native headings share outline order and globally unique IDs', async () => {
  const { editor, view, props } = await mount('# 标题 <em>A</em>\n\n## 标题 A\n\n### 标题 <strong>A</strong>\n\n<h2 id="custom-anchor">自定义</h2>\n\nbody');
  const ids = () => [...view.container.querySelectorAll('[data-heading-id]')].map(node => node.id);
  expect(ids()).toEqual(['heading-标题-a', 'heading-标题-a-2', 'heading-标题-a-3']);
  expect(props.onOutline).toHaveBeenLastCalledWith([
    { id: 'heading-标题-a', text: '标题 A', level: 1 },
    { id: 'heading-标题-a-2', text: '标题 A', level: 2 },
    { id: 'heading-标题-a-3', text: '标题 A', level: 3 },
  ]);
  expect(view.container.querySelector('#custom-anchor')?.textContent).toBe('自定义');
  const first = editor.state.doc.firstChild!;
  act(() => editor.view.dispatch(editor.state.tr.insertText('不同', 3, 5)));
  expect(ids()).toEqual(['heading-不同-a', 'heading-标题-a', 'heading-标题-a-2']);
  act(() => editor.commands.undo());
  expect(editor.state.doc.firstChild!.eq(first)).toBe(true);
  expect(ids()).toEqual(['heading-标题-a', 'heading-标题-a-2', 'heading-标题-a-3']);
});

test('ordinary typing and searching reuse raw preview parsing and preserve untouched DOM', async () => {
  const { editor, view, props } = await mount('# Title\n\n<span>x</span> [link][doc]\n\n[doc]: ./first.md\n\nbody');
  const link = view.container.querySelector('.raw-source-preview a');
  expect(link).not.toBeNull();
  const renderMarkdown = vi.spyOn(markdownRenderer, 'renderMarkdownDocument');
  act(() => editor.view.dispatch(editor.state.tr.insertText('X', editor.state.doc.content.size - 1)));
  view.rerender(<DocumentEditor {...props} query="body" searchIndex={0} />);
  expect(renderMarkdown).not.toHaveBeenCalled();
  expect(view.container.querySelector('.raw-source-preview a')).toBe(link);
});

test('source outlines and editable headings preserve the same Unicode, empty and repeated anchors', async () => {
  const source = '# ＡＢＣ\n\n## ABC\n\n### 中文 标题！\n\n#### **中文** 标题！\n\n##### !!!\n\n######\n\n# [链接](https://example.com) `代码`\n\nbody';
  const expected = ['heading-abc', 'heading-abc-2', 'heading-中文-标题', 'heading-中文-标题-2',
    'heading-heading', 'heading-heading-2', 'heading-链接-代码'];
  const { view, ref } = await mount(source);
  expect([...view.container.querySelectorAll('[data-heading-id]')].map(node => node.id)).toEqual(expected);
  expect(markdownRenderer.extractMarkdownOutline(source).map(heading => heading.id)).toEqual(expected);
  expect(ref.current!.flush()).toBe(source);
});

test('image refreshes preserve native and raw preview nodes and recover a missing raw image', async () => {
  const { view, props, ref } = await mount('# Title\n\n![normal](a.png)\n\n<span>说明</span> [link](./target.md) ![raw](a.png)');
  const first = { 'a.png': { ok: true as const, src: 'data:image/png;base64,AAAA', mime: 'image/png' } };
  view.rerender(<DocumentEditor {...props} images={first} />);
  const images = [...view.container.querySelectorAll('img[data-local-src]')];
  const link = view.container.querySelector('.raw-source-preview a');
  expect(images).toHaveLength(2);
  view.rerender(<DocumentEditor {...props} images={{ 'a.png': { ...first['a.png'] } }} />);
  [...view.container.querySelectorAll('img[data-local-src]')].forEach((image, index) => expect(image).toBe(images[index]));
  expect(view.container.querySelector('.raw-source-preview a')).toBe(link);
  view.rerender(<DocumentEditor {...props} images={{ 'a.png': { ...first['a.png'], src: 'data:image/png;base64,BBBB' } }} />);
  [...view.container.querySelectorAll('img[data-local-src]')].forEach((image, index) => expect(image).toBe(images[index]));
  expect(view.container.querySelector('.raw-source-preview a')).toBe(link);
  view.rerender(<DocumentEditor {...props} images={{ 'a.png': { ok: false, code: 'IMAGE_NOT_FOUND', message: 'missing' } }} />);
  expect(view.container.querySelectorAll('.image-placeholder')).toHaveLength(2);
  view.rerender(<DocumentEditor {...props} images={first} />);
  expect(view.container.querySelector('.raw-source-preview img')).toBe(images[1]);
  expect(view.container.querySelector('.raw-source-preview a')).toBe(link);
  expect(ref.current!.flush()).toBe(props.content);
});

test('resolved fragment links retain the explicit open action', async () => {
  const { view, props } = await mount('# Title\n\n<span>x</span> [link][doc]\n\n[doc]: https://example.com');
  const link = view.container.querySelector('.raw-source-preview a')!;
  fireEvent.click(link);
  expect(props.onOpenLink).not.toHaveBeenCalled();
  fireEvent.click(link, { ctrlKey: true });
  expect(props.onOpenLink).toHaveBeenCalledWith('https://example.com');
});

test('source reimport refreshes the shared context without retaining old definitions', async () => {
  const { view, props } = await mount('# Title\n\n<span>x</span> [link][doc]\n\n[doc]: ./first.md');
  view.rerender(<DocumentEditor {...props} active={false} />);
  view.rerender(<DocumentEditor {...props} content={props.content.replace('./first.md', './second.md')} />);
  expect(view.container.querySelector('.raw-source-preview a')?.getAttribute('data-md-href')).toBe('./second.md');
});

test('the document flush preserves BOM and CRLF around a protected header and tasks', async () => {
  const protectedSource = '\uFEFF---\r\ntitle: Report\r\n...\r\n\r\n- [ ] todo\r\n- [X] done';
  const original = protectedSource + '\r\n\r\nbody\r\n';
  const { editor, ref } = await mount(original);
  act(() => editor.view.dispatch(editor.state.tr.insertText('X', editor.state.doc.content.size - 1)));
  expect(ref.current!.flush()).toContain(protectedSource);
  expect(ref.current!.flush()).toContain('bodyX');
  act(() => editor.commands.undo());
  expect(ref.current!.flush()).toBe(original);
});

test.each([false, true])('ordinary reference links follow definition edits, save/reopen and undo; definitions first=%s', async first => {
  const block = '[link][doc] [doc][] [doc] ![image][img]';
  const definitions = '[doc]: ./old.md "Old"\n[img]: ./old.png';
  const content = (first ? definitions + '\n\n' + block : block + '\n\n' + definitions) + '\n\nbody';
  const { editor, ref, view, props } = await mount(content);
  replaceRaw(editor, '[doc]:', '[doc]: ./new.md "New"\n[img]: ./new.png');
  const links = [...view.container.querySelectorAll('.raw-source-preview a')];
  expect(links).toHaveLength(3);
  expect(links.map(link => link.getAttribute('data-md-href'))).toEqual(Array(3).fill('./new.md'));
  expect(links[0].getAttribute('title')).toBe('New');
  expect(props.onImageSources).toHaveBeenLastCalledWith(['./new.png']);
  fireEvent.click(links[0], { ctrlKey: true });
  expect(props.onOpenLink).toHaveBeenCalledExactlyOnceWith('./new.md');
  const saved = ref.current!.flush()!;
  expect(saved).toContain(block);
  expect(saved).toContain('[doc]: ./new.md "New"');
  expect(saved).not.toContain('./old.md');
  act(() => editor.view.dispatch(closeHistory(editor.state.tr)));
  replaceRaw(editor, '[doc]:', '');
  expect(view.container.querySelector('.raw-source-preview a')).toBeNull();
  expect(props.onImageSources).toHaveBeenLastCalledWith([]);
  act(() => editor.commands.undo());
  expect(view.container.querySelector('.raw-source-preview a')?.getAttribute('data-md-href')).toBe('./new.md');
  act(() => editor.commands.undo());
  expect(ref.current!.flush()).toBe(content);
  expect(view.container.querySelector('.raw-source-preview a')?.getAttribute('data-md-href')).toBe('./old.md');
  view.unmount();
  const reopened = await mount(saved);
  expect(reopened.view.container.querySelector('.raw-source-preview a')?.getAttribute('data-md-href')).toBe('./new.md');
  expect(reopened.props.onImageSources).toHaveBeenLastCalledWith(['./new.png']);
});

test('ordinary references retain parser normalization and first-definition precedence', async () => {
  const { view, editor, ref } = await mount('[link][d   o c]\n\n[  D o C  ]: ./first.md\n\nbetween\n\n[D O C]: ./second.md');
  expect(view.container.querySelector('.raw-source-preview a')?.getAttribute('data-md-href')).toBe('./first.md');
  replaceRaw(editor, '[  D o C  ]:', '[  D o C  ]: ./changed.md');
  expect(view.container.querySelector('.raw-source-preview a')?.getAttribute('data-md-href')).toBe('./changed.md');
  expect(ref.current!.flush()).toContain('[link][d   o c]');
  replaceRaw(editor, '[  D o C  ]:', '');
  expect(view.container.querySelector('.raw-source-preview a')?.getAttribute('data-md-href')).toBe('./second.md');
});

test.each([
  '<a href="./next.md"><strong>下一页</strong></a>',
  '<a href="https://example.com"><strong>下一页</strong></a>',
  '<span>前缀</span> [**下一页**](./next.md)',
  '<a data-md-href="./next.md" href="./wrong.md"><strong>下一页</strong></a>',
])('modifier clicks route preview links once without moving selection: %s', async source => {
  const { view, props, editor } = await mount('# Title\n\n' + source);
  const target = view.container.querySelector('.raw-source-preview a strong')!;
  const expected = source.includes('https:') ? 'https://example.com' : './next.md';
  const selection = editor.state.selection.toJSON();
  const doc = editor.state.doc;
  for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
    props.onOpenLink.mockClear();
    expect(fireEvent.click(target, modifier)).toBe(false);
    expect(props.onOpenLink).toHaveBeenCalledExactlyOnceWith(expected);
    expect(editor.state.selection.toJSON()).toEqual(selection);
    expect(editor.state.doc).toBe(doc);
    expect(editor.can().undo()).toBe(false);
  }
  props.onOpenLink.mockClear();
  fireEvent.click(target);
  expect(props.onOpenLink).not.toHaveBeenCalled();
  expect(editor.state.selection.$from.parent.type.name).toBe('rawSource');
});

test.each(['javascript:alert(1)', 'data:text/html,unsafe', 'file:///secret.md', 'vbscript:msgbox(1)', null])(
  'does not restore sanitized or missing HTML hrefs: %s', async href => {
    const { view, props } = await mount('<a' + (href ? ' href="' + href + '"' : '') + '>link</a>');
    const anchor = view.container.querySelector('.raw-source-preview a')!;
    expect(anchor.hasAttribute('href')).toBe(false);
    fireEvent.click(anchor, { ctrlKey: true });
    expect(props.onOpenLink).not.toHaveBeenCalled();
  },
);
