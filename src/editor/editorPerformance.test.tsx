import { createRef } from 'react';
import { act, cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { DocumentEditor, type DocumentEditorHandle } from './DocumentEditor';
import { findDocumentMatches } from './extensions';
import hljs from 'highlight.js/lib/core';
import { searchKey } from './extensions';
import { useSourceOutline } from '../markdown/useSourceOutline';
import * as markdownRenderer from '../markdown/renderMarkdown';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

test('source outline skips closed panels, coalesces input and waits for composition', () => {
  vi.useFakeTimers();
  const extract = vi.spyOn(markdownRenderer, 'extractMarkdownOutline');
  const composing = { current: false };
  const { result, rerender } = renderHook(({ content, enabled }) => useSourceOutline(content, enabled, 1, composing.current), {
    initialProps: { content: '# First', enabled: false },
  });
  rerender({ content: '# Latest', enabled: false });
  expect(extract).not.toHaveBeenCalled();
  rerender({ content: '# Latest', enabled: true });
  expect(result.current[0].text).toBe('Latest');
  extract.mockClear();
  for (let index = 0; index < 6; index++) {
    rerender({ content: '# Heading ' + index, enabled: true });
    act(() => vi.advanceTimersByTime(80));
  }
  expect(extract).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(20));
  expect(result.current[0].text).toBe('Heading 5');
  expect(extract).toHaveBeenCalledTimes(1);
  composing.current = true;
  rerender({ content: '# 中文', enabled: true });
  act(() => vi.advanceTimersByTime(600));
  expect(extract).toHaveBeenCalledTimes(1);
  composing.current = false;
  rerender({ content: '# 中文', enabled: true });
  act(() => vi.advanceTimersByTime(100));
  expect(result.current[0].text).toBe('中文');
  rerender({ content: '# Unpublished', enabled: true });
  rerender({ content: '# Unpublished', enabled: false });
  act(() => vi.advanceTimersByTime(600));
  expect(result.current[0].text).toBe('中文');
});

async function mount(content = '# Title\n\nbody') {
  const ref = createRef<DocumentEditorHandle>();
  const props = { ref, content, active: true, disabled: false, images: {}, query: '', searchIndex: 0,
    onChange: vi.fn(), onTransaction: vi.fn(), onImageSources: vi.fn(), onSearch: vi.fn(),
    onOutline: vi.fn(), onOpenLink: vi.fn(), onError: vi.fn(), onRecover: vi.fn() };
  const view = render(<DocumentEditor {...props} />);
  await waitFor(() => expect(ref.current?.editor).toBeTruthy());
  // Tiptap's create event is queued after mounting.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  return { ref, props, view, editor: ref.current!.editor! };
}

test('notifies dirty immediately and exports once after 100 ms idle; flush captures immediate input', async () => {
  const { ref, props, editor } = await mount();
  vi.useFakeTimers();
  const serialize = vi.spyOn(editor.markdown!, 'serialize');
  act(() => { editor.commands.insertContent('A'); });
  expect(props.onTransaction).toHaveBeenLastCalledWith({ dirty: true });
  expect(props.onChange).not.toHaveBeenCalled();
  expect(serialize).not.toHaveBeenCalled();
  act(() => { vi.advanceTimersByTime(99); });
  expect(props.onChange).not.toHaveBeenCalled();
  act(() => { vi.advanceTimersByTime(1); });
  expect(props.onChange).toHaveBeenCalledTimes(1);
  expect(serialize).toHaveBeenCalledTimes(1);
  act(() => { editor.commands.insertContent('B'); });
  act(() => { expect(ref.current!.flush()).toContain('ABTitle'); });
  expect(serialize).toHaveBeenCalledTimes(2);
  act(() => { vi.advanceTimersByTime(500); });
  expect(serialize).toHaveBeenCalledTimes(2);
});

test('exports continuous input at 500 ms and preserves edits made after a captured save', async () => {
  const { ref, props, editor } = await mount('body');
  vi.useFakeTimers();
  for (let i = 0; i < 6; i += 1) {
    act(() => { editor.commands.insertContent(String(i)); vi.advanceTimersByTime(80); });
  }
  expect(props.onChange).not.toHaveBeenCalled();
  act(() => { vi.advanceTimersByTime(20); });
  expect(props.onChange).toHaveBeenCalledTimes(1);
  let saved: ReturnType<DocumentEditorHandle['capture']>;
  act(() => { saved = ref.current!.capture(); editor.commands.insertContent('later'); });
  act(() => { ref.current!.markSaved(saved!); });
  expect(props.onTransaction.mock.lastCall?.[0].dirty).toBe(true);
  act(() => { editor.view.dispatch(editor.state.tr.delete(7, 12)); });
  expect(ref.current!.flush()).toBe(saved!.markdown);
  expect(props.onTransaction.mock.lastCall?.[0].dirty).toBe(false);
});

test('composition defers timed export and flush until composition ends', async () => {
  const { ref, props, editor, view } = await mount('body');
  vi.useFakeTimers();
  const serialize = vi.spyOn(editor.markdown!, 'serialize');
  fireEvent.compositionStart(view.getByRole('textbox'));
  act(() => { editor.commands.insertContent('中文'); vi.advanceTimersByTime(600); });
  expect(serialize).not.toHaveBeenCalled();
  expect(ref.current!.flush()).toBeNull();
  fireEvent.compositionEnd(view.getByRole('textbox'));
  act(() => { vi.advanceTimersByTime(120); });
  expect(props.onChange.mock.lastCall?.[0]).toContain('中文body');
});

test('body edits do not republish identical outline/images and cached searches retain match identity', async () => {
  const { props, editor } = await mount('# Title\n\nbody ![alt](local.png)\n\n<!-- invisible -->');
  expect(props.onImageSources).toHaveBeenLastCalledWith(['local.png']);
  const outlineCalls = props.onOutline.mock.calls.length;
  const imageCalls = props.onImageSources.mock.calls.length;
  act(() => { editor.commands.setTextSelection(editor.state.doc.content.size - 2); editor.commands.insertContent(' text'); });
  expect(props.onOutline).toHaveBeenCalledTimes(outlineCalls);
  expect(props.onImageSources).toHaveBeenCalledTimes(imageCalls);
  expect(findDocumentMatches(editor.state.doc, 'body')).toBe(findDocumentMatches(editor.state.doc, 'body'));
});

test('unmodified source toggles preserve selection/history and modified source clamps selection', async () => {
  const { ref, props, editor, view } = await mount('one\n\nsecond paragraph');
  act(() => { editor.commands.setTextSelection(12); editor.commands.insertContent('X'); });
  const markdown = ref.current!.flush()!;
  const position = editor.state.selection.from;
  view.rerender(<DocumentEditor {...props} content={markdown} active={false} />);
  view.rerender(<DocumentEditor {...props} content={markdown} />);
  expect(editor.state.selection.from).toBe(position);
  expect(editor.can().undo()).toBe(true);
  view.rerender(<DocumentEditor {...props} content={markdown} active={false} />);
  view.rerender(<DocumentEditor {...props} content="short" />);
  expect(editor.state.selection.from).toBe(6);
  expect(editor.can().undo()).toBe(false);
});

test('reuses code highlighting on body/selection/search changes and refreshes edited code only', async () => {
  const { editor } = await mount('body\n\n```js\nconst a = 1;\n```\n\n```js\nconst b = 2;\n```');
  const highlight = vi.spyOn(hljs, 'highlight');
  act(() => { editor.commands.setTextSelection(2); editor.commands.insertContent(' text'); });
  act(() => { editor.view.dispatch(editor.state.tr.setMeta(searchKey, { query: 'const', activeIndex: 0 })); });
  const initial = searchKey.getState(editor.state)!;
  act(() => { editor.view.dispatch(editor.state.tr.setMeta(searchKey, { query: 'const', activeIndex: 1 })); });
  expect(searchKey.getState(editor.state)!.syntax).toBe(initial.syntax);
  expect(highlight).not.toHaveBeenCalled();
  const codePosition = editor.state.doc.child(0).nodeSize + 1;
  act(() => { editor.view.dispatch(editor.state.tr.insertText('// ', codePosition)); });
  expect(highlight).toHaveBeenCalledTimes(1);
  expect(Array.from(editor.view.dom.querySelectorAll('pre code .hljs-comment'), element => element.textContent).join('')).toBe('// const a = 1;');
  act(() => { editor.view.dispatch(editor.state.tr.setNodeMarkup(codePosition - 1, undefined, { language: 'unknown' })); });
  expect(editor.view.dom.querySelector('pre code .hljs-comment')).toBeNull();
  expect(editor.view.dom.querySelectorAll('[data-search-hit]').length).toBe(2);
});

test('heading anchors survive replacement with an equivalent new heading node', async () => {
  const { editor } = await mount('# Title\n\nbody');
  act(() => {
    editor.view.dispatch(editor.state.tr.replaceWith(0, editor.state.doc.firstChild!.nodeSize,
      editor.schema.nodes.heading.create({ level: 1 }, editor.schema.text('Title'))));
  });
  expect(editor.view.dom.querySelector('h1')?.getAttribute('data-heading-id')).toBe('heading-title');
});

test('undo restores saved bytes and flush does not reserialize an unchanged snapshot', async () => {
  const { editor, ref, props } = await mount('original\r\n');
  const serialize = vi.spyOn(editor.markdown!, 'serialize');
  act(() => { editor.commands.insertContent('new '); });
  const snapshot = ref.current!.capture()!;
  act(() => { ref.current!.markSaved(snapshot); });
  expect(props.onTransaction.mock.lastCall?.[0].dirty).toBe(false);
  act(() => { editor.commands.undo(); });
  expect(ref.current!.flush()).toBe('original\r\n');
  expect(props.onTransaction.mock.lastCall?.[0].dirty).toBe(true);
  act(() => { editor.commands.redo(); });
  expect(ref.current!.flush()).toBe(snapshot.markdown);
  expect(props.onTransaction.mock.lastCall?.[0].dirty).toBe(false);
  expect(serialize).toHaveBeenCalledTimes(1);
});

test.each([
  ['## H\n\nbody\n', 'H\n---\n\nbody\n'],
  ['**bold**\n', '__bold__\n'],
  ['body\n', 'body\n\n'],
])('equivalent source edits stay dirty and survive visual undo: %j', async (saved, source) => {
  const { editor, ref, props, view } = await mount(saved);
  view.rerender(<DocumentEditor {...props} content={source} active={false} />);
  view.rerender(<DocumentEditor {...props} content={source} />);
  expect(props.onTransaction.mock.lastCall?.[0].dirty).toBe(true);
  expect(ref.current!.flush()).toBe(source);
  act(() => { editor.commands.insertContent('extra'); editor.commands.undo(); });
  expect(props.onTransaction.mock.lastCall?.[0].dirty).toBe(true);
  expect(ref.current!.flush()).toBe(source);
  act(() => { ref.current!.markSaved(ref.current!.capture()!); });
  expect(props.onTransaction.mock.lastCall?.[0].dirty).toBe(false);
  expect(ref.current!.flush()).toBe(source);
  view.rerender(<DocumentEditor {...props} content={saved} active={false} />);
  view.rerender(<DocumentEditor {...props} content={saved} />);
  expect(props.onTransaction.mock.lastCall?.[0].dirty).toBe(true);
  expect(ref.current!.flush()).toBe(saved);
});

test('an older save cannot clear an equivalent source edit imported while saving', async () => {
  const { ref, props, view } = await mount('## H\n');
  const oldSave = ref.current!.capture()!;
  const source = 'H\n---\n';
  view.rerender(<DocumentEditor {...props} content={source} active={false} />);
  view.rerender(<DocumentEditor {...props} content={source} />);
  act(() => ref.current!.markSaved(oldSave));
  expect(props.onTransaction.mock.lastCall?.[0].dirty).toBe(true);
  expect(ref.current!.flush()).toBe(source);
});

test('mode visibility does not navigate search, move selection, steal focus or change history', async () => {
  const { editor, props, view } = await mount('one **search**\n\nsearch two');
  const scroll = vi.fn();
  const previous = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = scroll;
  try {
    act(() => editor.commands.insertContent('X'));
    const markdown = props.ref.current!.flush()!;
    view.rerender(<DocumentEditor {...props} content={markdown} query="search" />);
    expect(scroll).toHaveBeenCalledTimes(1);
    const selection = editor.state.selection.toJSON();
    const focus = document.activeElement;
    view.rerender(<DocumentEditor {...props} content={markdown} query="search" active={false} />);
    view.rerender(<DocumentEditor {...props} content={markdown} query="search" />);
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(editor.state.selection.toJSON()).toEqual(selection);
    expect(document.activeElement).toBe(focus);
    expect(editor.can().undo()).toBe(true);
    view.rerender(<DocumentEditor {...props} content={markdown} query="search" searchIndex={1} />);
    expect(scroll).toHaveBeenCalledTimes(2);
  } finally { HTMLElement.prototype.scrollIntoView = previous; }
});

test('search decorations preserve Unicode positions, marks and literal HTML without editing the document', async () => {
  const { editor, props, view } = await mount('İa **Search** 中文 search <script>literal</script>');
  const doc = editor.state.doc;
  for (const [query, count] of [['search', 2], ['中文', 1], ['missing', 0], ['<script>', 1]] as const) {
    view.rerender(<DocumentEditor {...props} query={query} />);
    expect(findDocumentMatches(doc, query)).toHaveLength(count);
    expect(editor.state.doc).toBe(doc);
    expect(editor.can().undo()).toBe(false);
    expect(editor.view.dom.querySelector('script')).toBeNull();
  }
  expect(findDocumentMatches(doc, 'a')[0]).toEqual({ from: 2, to: 3 });
});

test('repeated search navigation keeps only the current match and reveals raw source without editing it', async () => {
  const { editor, props, view } = await mount('needle **needle**\n\n```js\nconst needle = 1;\n```\n\n<!-- needle -->');
  const doc = editor.state.doc;
  const selection = editor.state.selection.toJSON();
  for (const index of [0, 1, 2, 3, 2, 1, 0, 3]) {
    view.rerender(<DocumentEditor {...props} query="needle" searchIndex={index} />);
    const hits = editor.view.dom.querySelectorAll('[data-active-search="true"]');
    expect(hits).toHaveLength(1);
    expect(hits[0].getAttribute('data-search-hit')).toBe(String(index));
    const state = searchKey.getState(editor.state)!;
    expect(state.active.every(Boolean)).toBe(true);
    expect(editor.view.dom.querySelector('.raw-source-shell')?.getAttribute('data-search-reveal')).toBe(index === 3 ? 'true' : null);
    expect(editor.state.doc).toBe(doc);
    expect(editor.state.selection.toJSON()).toEqual(selection);
    expect(editor.can().undo()).toBe(false);
  }
  view.rerender(<DocumentEditor {...props} />);
  expect(editor.view.dom.querySelector('[data-active-search]')).toBeNull();
  expect(editor.view.dom.querySelector('[data-search-reveal]')).toBeNull();
});

test('large searches retain all matches with bounded highlights and navigation beyond the limit', async () => {
  const content = 'a '.repeat(150000).trim();
  const { editor, ref, props, view } = await mount(content);
  act(() => editor.view.setProps({ handleScrollToSelection: () => true }));
  const doc = editor.state.doc;
  const selection = editor.state.selection.toJSON();
  const matches = findDocumentMatches(doc, 'a');
  expect(matches).toHaveLength(150000);
  expect(matches[0]).toEqual({ from: 1, to: 2 });
  expect(matches.at(-1)).toEqual({ from: 299999, to: 300000 });
  for (const index of [0, 1000, 149999, 150000, 1001, 0]) {
    view.rerender(<DocumentEditor {...props} query="a" searchIndex={index} />);
    const activeIndex = index % matches.length;
    expect(props.onSearch).toHaveBeenLastCalledWith({ count: 150000, activeIndex });
    const active = editor.view.dom.querySelectorAll('[data-active-search="true"]');
    expect(active).toHaveLength(1);
    expect(active[0].getAttribute('data-search-hit')).toBe(String(activeIndex));
    expect(editor.view.dom.querySelectorAll('.search-hit:not([data-active-search])').length).toBeLessThanOrEqual(1000);
    expect(editor.view.dom.querySelectorAll('[data-search-hit]').length).toBeLessThanOrEqual(1001);
    expect(searchKey.getState(editor.state)!.active[0].from).toBe(matches[activeIndex].from);
    expect(editor.state.doc).toBe(doc);
    expect(editor.state.selection.toJSON()).toEqual(selection);
    expect(editor.can().undo()).toBe(false);
    expect(ref.current!.flush()).toBe(content);
  }
  expect(props.onTransaction).not.toHaveBeenCalledWith({ dirty: true });
  act(() => editor.view.dispatch(editor.state.tr.insertText('b', 1, 2)));
  expect(props.onSearch).toHaveBeenLastCalledWith({ count: 149999, activeIndex: 0 });
  expect(findDocumentMatches(editor.state.doc, 'a')[0]).toEqual({ from: 3, to: 4 });
  expect(searchKey.getState(editor.state)!.active[0].from).toBe(3);
  act(() => editor.commands.undo());
  expect(props.onSearch).toHaveBeenLastCalledWith({ count: 150000, activeIndex: 0 });
  view.rerender(<DocumentEditor {...props} />);
  expect(editor.view.dom.querySelector('[data-search-hit]')).toBeNull();
  expect(editor.view.dom.querySelector('[data-active-search]')).toBeNull();
  expect(ref.current!.flush()).toBe(content);
}, 20000);
