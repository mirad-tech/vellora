import { useEffect, useLayoutEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import { EditorState, NodeSelection, TextSelection } from '@tiptap/pm/state';
import { Fragment, Slice } from '@tiptap/pm/model';
import { TableMap } from '@tiptap/pm/tables';
import { editorExtensions, findDocumentMatches, LocalImage, RawSource, searchKey } from './extensions';
import { documentLineEnding, headingId, importMarkdown } from './markdownDocument';
import { exportMarkdown } from './exportMarkdown';
import { renderMarkdownDocument, type MarkdownOutlineEntry } from '../markdown/renderMarkdown';
import { applyImageResolutions, type ImageResolutionMap } from '../markdown/resolveImages';

export type DocumentEditorHandle = { flush: () => string | null; editor: Editor | null };
type Props = {
  ref?: Ref<DocumentEditorHandle>;
  content: string;
  active: boolean;
  disabled: boolean;
  images: ImageResolutionMap;
  query: string;
  searchIndex: number;
  onChange: (markdown: string) => void;
  onOutline: (outline: MarkdownOutlineEntry[]) => void;
  onSearch: (result: { count: number; activeIndex: number }) => void;
  onOpenLink: (href: string) => void;
  onError: (message: string) => void;
  onRecover: (markdown: string) => void;
};

function pastePlainText(editor: Editor, text: string): boolean {
  const normalized = text.replace(/\r\n|\r/g, '\n');
  const { state, view } = editor;
  if (state.selection.$from.parent.type.spec.code) {
    view.dispatch(state.tr.insertText(normalized));
  } else if (editor.isActive('table')) {
    const content = normalized.split('\n').flatMap((line, index) => [
      ...(index ? [state.schema.nodes.hardBreak.create()] : []),
      ...(line ? [state.schema.text(line, state.storedMarks ?? state.selection.$from.marks())] : []),
    ]);
    view.dispatch(state.tr.replaceSelection(new Slice(Fragment.fromArray(content), 0, 0)).scrollIntoView());
  } else {
    const marks = state.storedMarks ?? state.selection.$from.marks();
    const paragraphs = normalized.split('\n').map(line => state.schema.nodes.paragraph.create(null,
      line ? state.schema.text(line, marks) : null));
    view.dispatch(state.tr.replaceSelection(new Slice(Fragment.fromArray(paragraphs), 1, 1)).scrollIntoView());
  }
  return true;
}

export function DocumentEditor(props: Props) {
  const callbacks = useRef(props);
  callbacks.current = props;
  const lastMarkdown = useRef(props.content);
  const original = useRef(props.content);
  const originalJson = useRef('');
  const initialJson = useMemo(() => importMarkdown(props.content), []);
  const importing = useRef(false);
  const imageListeners = useRef(new Set<() => void>());
  const [revision, setRevision] = useState(0);
  const [menu, setMenu] = useState<'format' | 'link' | 'image' | null>(null);
  const [field, setField] = useState({ href: '', title: '', alt: '' });
  const [error, setError] = useState('');
  const [position, setPosition] = useState({ left: 16, top: 100 });
  const [focused, setFocused] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const toolsRef = useRef<HTMLDivElement>(null);
  const loadFailed = useRef(false);

  const extensions = useMemo(() => editorExtensions({
    image: LocalImage.extend({
      addNodeView() {
        return ({ node }) => {
          const dom = document.createElement('span');
          dom.className = 'document-image';
          dom.contentEditable = 'false';
          let current = node;
          const render = () => {
            const result = callbacks.current.images[String(current.attrs.src)];
            dom.replaceChildren();
            if (result?.ok) {
              const img = document.createElement('img');
              img.src = result.src;
              img.alt = current.attrs.alt ?? '';
              img.title = current.attrs.title ?? '';
              img.dataset.localSrc = current.attrs.src;
              dom.append(img);
            } else {
              const placeholder = document.createElement('span');
              placeholder.className = 'image-placeholder';
              placeholder.dataset.testid = 'missing-image';
              placeholder.textContent = result && !result.ok ? `图片缺失：${current.attrs.src}` : current.attrs.alt || current.attrs.src || '图片';
              placeholder.title = result && !result.ok ? result.message : '正在加载图片';
              placeholder.dataset.localSrc = current.attrs.src;
              dom.append(placeholder);
            }
          };
          imageListeners.current.add(render);
          render();
          return { dom, update(next) {
            if (next.type !== current.type) return false;
            current = next; render(); return true;
          }, ignoreMutation: () => true, destroy() { imageListeners.current.delete(render); } };
        };
      },
    }),
    rawSource: RawSource.extend({
      addNodeView() {
        return ({ node, editor, getPos }) => {
          const dom = document.createElement('div');
          dom.className = 'raw-source-shell';
          const preview = document.createElement('div');
          preview.className = 'raw-source-preview';
          preview.contentEditable = 'false';
          preview.setAttribute('role', 'button');
          preview.setAttribute('aria-label', '编辑源码片段');
          preview.tabIndex = 0;
          const contentDOM = document.createElement('pre');
          contentDOM.className = 'raw-source-content';
          contentDOM.setAttribute('aria-label', '源码片段');
          contentDOM.spellcheck = false;
          dom.append(preview, contentDOM);
          let current = node;
          const render = () => {
            const result = renderMarkdownDocument(current.textContent);
            const html = result.status === 'ready' ? applyImageResolutions(result.html, callbacks.current.images) : '';
            preview.innerHTML = html;
            if (!preview.textContent?.trim() && !preview.querySelector('img,hr')) preview.textContent = '源码片段';
          };
          const select = () => {
            const pos = getPos();
            if (typeof pos === 'number') editor.chain().setTextSelection(pos + 1).focus().run();
          };
          const selectionChanged = () => {
            const pos = getPos();
            const { from, to } = editor.state.selection;
            dom.dataset.active = String(typeof pos === 'number' && from >= pos + 1 && to <= pos + current.nodeSize - 1);
          };
          preview.addEventListener('click', event => { event.preventDefault(); select(); });
          preview.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(); }
          });
          editor.on('selectionUpdate', selectionChanged);
          imageListeners.current.add(render);
          render();
          return { dom, contentDOM, update(next) {
            if (next.type !== current.type) return false;
            current = next; render(); selectionChanged(); return true;
          }, ignoreMutation: mutation => mutation.type !== 'selection' && !contentDOM.contains(mutation.target),
          destroy() { editor.off('selectionUpdate', selectionChanged); imageListeners.current.delete(render); } };
        };
      },
    }),
  }), []);

  const report = (editor: Editor) => {
    const seen = new Map<string, number>();
    const outline: MarkdownOutlineEntry[] = [];
    editor.state.doc.descendants(node => {
      if (node.type.name === 'heading') outline.push({ id: headingId(node.textContent, seen),
        text: node.textContent, level: node.attrs.level });
    });
    callbacks.current.onOutline(outline);
    const search = searchKey.getState(editor.state);
    const count = findDocumentMatches(editor.state.doc, search?.query ?? '').length;
    callbacks.current.onSearch({ count, activeIndex: count ? Math.max(0, search?.activeIndex ?? 0) % count : -1 });
  };

  const syncSearch = (editor: Editor) => {
    const { query, searchIndex, active } = callbacks.current;
    const count = findDocumentMatches(editor.state.doc, query).length;
    const activeIndex = count ? Math.max(0, searchIndex) % count : -1;
    editor.view.dispatch(editor.state.tr.setMeta(searchKey, { query, activeIndex }).setMeta('addToHistory', false));
    report(editor);
    if (active && count) editor.view.dom.querySelector('[data-active-search="true"]')?.scrollIntoView?.({ block: 'center' });
  };

  const serialize = (editor: Editor): string | null => {
    if (loadFailed.current) return callbacks.current.content;
    try {
      const json = JSON.stringify(editor.getJSON());
      // Undoing to the imported document restores the original bytes and dirty state.
      const markdown = json === originalJson.current ? original.current :
        exportMarkdown(editor).replace(/\r\n|\r|\n/g, documentLineEnding(original.current));
      lastMarkdown.current = markdown;
      setError('');
      return markdown;
    } catch {
      const message = '内容转换失败，更改仍保留在编辑器中。';
      setError(message);
      callbacks.current.onError(message);
      return null;
    }
  };

  const editor: Editor | null = useEditor({
    extensions, content: initialJson, enableInputRules: false, enablePasteRules: false,
    injectCSS: false,
    editorProps: {
      attributes: { class: 'markdown-body document-editor', 'data-testid': 'markdown-body',
        'aria-label': '文档内容', role: 'textbox', 'aria-multiline': 'true', spellcheck: 'false' },
      handlePaste: (_view, event) => {
        event.preventDefault();
        return editor ? pastePlainText(editor, event.clipboardData?.getData('text/plain') ?? '') : true;
      },
      handleClick: (view, pos, event) => {
        if (!(event.target as HTMLElement).closest('a')) return false;
        event.preventDefault();
        // WebView2 can deliver selectionchange after the contextual menu opens.
        // Commit the clicked caret position before the menu reads link attributes.
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
        return true;
      },
      handleKeyDown: (view, event): boolean => {
        if (view.composing || event.isComposing) return false;
        if (event.key === 'Escape') { setMenu(null); return true; }
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          if (view.state.selection.$from.parent.type.name === 'rawSource') {
            const pos = view.state.selection.$from.after();
            const tr = view.state.tr.insert(pos, view.state.schema.nodes.paragraph.create());
            view.dispatch(tr.setSelection(TextSelection.create(tr.doc, pos + 1)));
            return true;
          }
          return editor?.commands.exitCode() ?? false;
        }
        if (event.key === 'Enter' && editor?.isActive('table')) return editor.commands.setHardBreak();
        return false;
      },
    },
    onCreate: ({ editor }) => {
      originalJson.current = JSON.stringify(editor.schema.nodeFromJSON(initialJson).toJSON());
      report(editor);
    },
    onUpdate: ({ editor }) => {
      if (importing.current) return;
      const value = serialize(editor);
      if (value !== null) callbacks.current.onChange(value);
      report(editor);
      setRevision(value => value + 1);
    },
    onSelectionUpdate: () => { setRevision(value => value + 1); setMenu(null); },
    onFocus: () => setFocused(true),
    onBlur: ({ event }) => {
      if (!container.current?.contains(event.relatedTarget as globalThis.Node)) setFocused(false);
    },
  });

  useImperativeHandle(props.ref, () => ({ editor, flush: () => {
    if (!editor) return lastMarkdown.current;
    // Flush ProseMirror's pending DOM mutation before an immediate save / mode switch.
    (editor.view as typeof editor.view & { domObserver?: { flush: () => void } }).domObserver?.flush();
    return serialize(editor);
  } }), [editor]);

  useEffect(() => {
    if (!editor || !props.active || props.content === lastMarkdown.current) return;
    importing.current = true;
    try {
      const doc = editor.schema.nodeFromJSON(importMarkdown(props.content));
      doc.check();
      editor.view.updateState(EditorState.create({ schema: editor.schema, doc, plugins: editor.state.plugins }));
      original.current = props.content;
      originalJson.current = JSON.stringify(editor.getJSON());
      lastMarkdown.current = props.content;
      loadFailed.current = false;
      setError(''); syncSearch(editor);
    } catch {
      loadFailed.current = true;
      editor.setEditable(false, false);
      setError('无法载入文档，请使用源码编辑。');
    } finally { importing.current = false; }
  }, [editor, props.active, props.content]);

  useEffect(() => { editor?.setEditable(props.active && !props.disabled && !loadFailed.current, false); }, [editor, props.active, props.disabled]);
  useEffect(() => { imageListeners.current.forEach(render => render()); }, [props.images]);
  useLayoutEffect(() => {
    if (!editor) return;
    syncSearch(editor);
  }, [editor, props.query, props.searchIndex, props.active]);

  useEffect(() => {
    if (!editor || !props.active) return;
    const locate = () => {
      try {
        const bounds = editor.view.coordsAtPos(editor.state.selection.from);
        const size = toolsRef.current?.getBoundingClientRect();
        const height = size?.height ?? 40;
        const width = size?.width ?? 290;
        const preferredTop = bounds.top - height - 8 >= 54 ? bounds.top - height - 8 : bounds.bottom + 8;
        const next = { left: Math.max(12, Math.min(bounds.left, window.innerWidth - width - 12)),
          top: Math.max(54, Math.min(preferredTop, window.innerHeight - height - 12)) };
        setPosition(current => current.left === next.left && current.top === next.top ? current : next);
      } catch { /* jsdom has no text layout; the browser supplies caret coordinates. */ }
    };
    locate();
    window.addEventListener('scroll', locate, true);
    window.addEventListener('resize', locate);
    return () => { window.removeEventListener('scroll', locate, true); window.removeEventListener('resize', locate); };
  }, [editor, revision, props.active, menu, focused]);

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as globalThis.Node)) { setMenu(null); setFocused(false); }
    };
    window.addEventListener('pointerdown', dismiss);
    return () => window.removeEventListener('pointerdown', dismiss);
  }, []);

  if (!editor) return null;
  const selectedText = editor.state.selection instanceof TextSelection && !editor.state.selection.empty;
  const inCode = editor.isActive('codeBlock') || editor.isActive('rawSource');
  const selectedImage = editor.state.selection instanceof NodeSelection && editor.state.selection.node.type.name === 'image';
  const act = (operation: () => unknown) => { operation(); setMenu(null); setFocused(true); };
  const openLinkMenu = () => {
    const attrs = editor.isActive('link') ? editor.getAttributes('link') :
      editor.state.selection.$from.nodeAfter?.marks.find(mark => mark.type.name === 'link')?.attrs ?? {};
    setField({ href: attrs.href ?? '', title: attrs.title ?? '', alt: '' }); setMenu('link');
  };
  const openImageMenu = () => {
    const attrs = editor.getAttributes('image');
    setField({ href: attrs.src ?? '', title: attrs.title ?? '', alt: attrs.alt ?? '' }); setMenu('image');
  };
  const alignColumn = (align: string) => {
    const { $from } = editor.state.selection;
    for (let depth = $from.depth; depth > 0; depth -= 1) {
      if ($from.node(depth).type.name !== 'table') continue;
      const table = $from.node(depth);
      const start = $from.start(depth);
      const cell = $from.before(depth + 2) - start;
      const map = TableMap.get(table);
      const col = map.findCell(cell).left;
      let tr = editor.state.tr;
      for (let row = 0; row < map.height; row += 1) {
        const pos = start + map.map[row * map.width + col];
        tr = tr.setNodeMarkup(pos, undefined, { ...tr.doc.nodeAt(pos)!.attrs, align });
      }
      editor.view.dispatch(tr); break;
    }
    editor.commands.focus();
  };

  return <div ref={container} className="document-editor-shell" hidden={!props.active}>
    {error ? <div role="alert" className="editor-error">{error}<button type="button" onClick={() => {
      const value = serialize(editor); if (value !== null) props.onChange(value);
    }}>重试转换</button><button type="button" onClick={() => {
      try {
        const recovered = loadFailed.current ? props.content : exportMarkdown(editor, true)
          .replace(/\r\n|\r|\n/g, documentLineEnding(original.current));
        lastMarkdown.current = recovered;
        setError(''); props.onRecover(recovered);
      } catch { setError('源码恢复失败，更改仍保留。请撤销后重试。'); }
    }}>源码恢复</button></div> : null}
    <EditorContent editor={editor} />
    {props.active && !props.disabled && (focused || menu) ? <div ref={toolsRef} className="editor-tools" style={position}
      role="toolbar" aria-label="格式操作" onKeyDown={event => {
        if (event.key === 'Escape') { event.stopPropagation(); setMenu(null); editor.commands.focus(); }
      }}>
      <div className="editor-tool-row" onMouseDown={event => { if ((event.target as HTMLElement).closest('button')) event.preventDefault(); }}>
        {selectedText && !inCode ? <>
          <button type="button" aria-label="加粗" aria-pressed={editor.isActive('bold')} onClick={() => act(() => editor.chain().focus().toggleBold().run())}>B</button>
          <button type="button" aria-label="斜体" aria-pressed={editor.isActive('italic')} onClick={() => act(() => editor.chain().focus().toggleItalic().run())}>I</button>
          <button type="button" aria-label="删除线" aria-pressed={editor.isActive('strike')} onClick={() => act(() => editor.chain().focus().toggleStrike().run())}>S</button>
          <button type="button" aria-label="行内代码" aria-pressed={editor.isActive('code')} onClick={() => act(() => editor.chain().focus().toggleCode().run())}>{'<>'}</button>
        </> : null}
        {!inCode ? <button type="button" onClick={openLinkMenu}>链接</button> : null}
        {selectedImage ? <button type="button" onClick={openImageMenu}>图片</button> : null}
        <button type="button" aria-expanded={menu === 'format'} onClick={() => setMenu(menu === 'format' ? null : 'format')}>格式</button>
      </div>
      {menu === 'format' ? <div className="editor-format-menu">
        {!editor.isActive('table') && !editor.isActive('rawSource') ? <>
          <button type="button" onClick={() => act(() => editor.chain().focus().setParagraph().run())}>正文</button>
          {([1, 2, 3, 4, 5, 6] as const).map(level => <button type="button" key={level} onClick={() => act(() => editor.chain().focus().toggleHeading({ level }).run())}>H{level}</button>)}
          <button type="button" onClick={() => act(() => editor.chain().focus().toggleBulletList().run())}>无序列表</button>
          <button type="button" onClick={() => act(() => editor.chain().focus().toggleOrderedList().run())}>有序列表</button>
          <button type="button" onClick={() => act(() => editor.chain().focus().toggleBlockquote().run())}>引用</button>
          <button type="button" onClick={() => act(() => editor.chain().focus().toggleCodeBlock().run())}>代码块</button>
          <button type="button" onClick={() => act(() => editor.chain().focus().setHorizontalRule().run())}>分隔线</button>
          <button type="button" onClick={() => act(() => editor.chain().focus().insertTable({ rows: 3, cols: 2, withHeaderRow: true }).run())}>表格</button>
          <button type="button" onClick={openImageMenu}>图片</button>
        </> : null}
        {editor.isActive('listItem') ? <>
          <button type="button" onClick={() => act(() => editor.chain().focus().sinkListItem('listItem').run())}>增加缩进</button>
          <button type="button" onClick={() => act(() => editor.chain().focus().liftListItem('listItem').run())}>减少缩进</button>
        </> : null}
        {editor.isActive('codeBlock') ? <label>语言<input aria-label="代码语言" value={editor.getAttributes('codeBlock').language ?? ''}
          onChange={event => editor.commands.updateAttributes('codeBlock', { language: event.target.value.replace(/[\r\n]/g, '') || null })} /></label> : null}
        {inCode ? <button type="button" onClick={() => act(() => {
          const pos = editor.state.selection.$from.after();
          const tr = editor.state.tr.insert(pos, editor.schema.nodes.paragraph.create());
          editor.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, pos + 1))); editor.commands.focus();
        })}>在下方继续输入</button> : null}
        {editor.isActive('table') ? <>
          <button type="button" onClick={() => act(() => editor.chain().focus().addRowBefore().run())}>上方插入行</button>
          <button type="button" onClick={() => act(() => editor.chain().focus().addRowAfter().run())}>下方插入行</button>
          <button type="button" onClick={() => act(() => editor.chain().focus().deleteRow().run())}>删除行</button>
          <button type="button" onClick={() => act(() => editor.chain().focus().addColumnBefore().run())}>左侧插入列</button>
          <button type="button" onClick={() => act(() => editor.chain().focus().addColumnAfter().run())}>右侧插入列</button>
          <button type="button" onClick={() => act(() => editor.chain().focus().deleteColumn().run())}>删除列</button>
          <button type="button" onClick={() => act(() => alignColumn('left'))}>左对齐</button>
          <button type="button" onClick={() => act(() => alignColumn('center'))}>居中</button>
          <button type="button" onClick={() => act(() => alignColumn('right'))}>右对齐</button>
          <button type="button" onClick={() => act(() => editor.chain().focus().deleteTable().run())}>删除表格</button>
        </> : null}
      </div> : null}
      {menu === 'link' || menu === 'image' ? <form className="editor-attribute-form" onSubmit={event => {
        event.preventDefault();
        if (menu === 'link') act(() => editor.chain().focus().extendMarkRange('link').setLink({ href: field.href })
          .updateAttributes('link', { title: field.title || null }).run());
        else act(() => selectedImage ? editor.chain().focus().updateAttributes('image', { src: field.href, alt: field.alt, title: field.title }).run()
          : editor.chain().focus().setImage({ src: field.href, alt: field.alt, title: field.title }).run());
      }}>
        <label>{menu === 'link' ? '链接地址' : '相对路径'}<input aria-label={menu === 'link' ? '链接地址' : '图片相对路径'} required value={field.href} onChange={event => setField({ ...field, href: event.target.value })} /></label>
        {menu === 'image' ? <label>替代文字<input aria-label="图片替代文字" value={field.alt} onChange={event => setField({ ...field, alt: event.target.value })} /></label> : null}
        <label>标题<input aria-label="标题" value={field.title} onChange={event => setField({ ...field, title: event.target.value })} /></label>
        <div className="editor-tool-row"><button type="submit">应用</button>
          {menu === 'link' ? <><button type="button" onClick={() => props.onOpenLink(field.href)}>打开链接</button>
            <button type="button" onClick={() => act(() => editor.chain().focus().extendMarkRange('link').unsetLink().run())}>移除链接</button></> : null}
          <button type="button" onClick={() => { setMenu(null); editor.commands.focus(); }}>取消</button></div>
      </form> : null}
    </div> : null}
  </div>;
}
