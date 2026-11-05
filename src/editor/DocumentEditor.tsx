import { useEffect, useLayoutEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import { EditorState, Selection, TextSelection } from '@tiptap/pm/state';
import { Fragment, Slice, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { editorExtensions, findDocumentMatches, LocalImage, RawSource, searchKey } from './extensions';
import { documentLineEnding, importMarkdown } from './markdownDocument';
import { exportMarkdown } from './exportMarkdown';
import { type MarkdownOutlineEntry } from '../markdown/renderMarkdown';
import { updatePreviewImages, type ImageResolutionMap } from '../markdown/resolveImages';
import { documentMetadata, rawSourcePreview } from './editorMetadata';

export type DocumentEditorSnapshot = { doc: ProseMirrorNode; markdown: string };
export type DocumentEditorHandle = {
  flush: () => string | null;
  capture: () => DocumentEditorSnapshot | null;
  markSaved: (snapshot: DocumentEditorSnapshot) => void;
  editor: Editor | null;
};
type Props = {
  ref?: Ref<DocumentEditorHandle>;
  content: string;
  savedContent?: string;
  active: boolean;
  disabled: boolean;
  images: ImageResolutionMap;
  query: string;
  searchIndex: number;
  searchNavigation?: number;
  onChange: (markdown: string) => void;
  onTransaction?: (state: { dirty: boolean }) => void;
  onImageSources?: (sources: string[]) => void;
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

function anchorHref(target: EventTarget | null): string | null {
  const anchor = target instanceof Element ? target.closest('a[data-md-href], a[href]') : null;
  const href = anchor?.getAttribute('data-md-href') ?? anchor?.getAttribute('href');
  return href?.trim() ? href : null;
}

export function DocumentEditor(props: Props) {
  const callbacks = useRef(props);
  callbacks.current = props;
  const openLink = (event: MouseEvent): boolean => {
    const href = anchorHref(event.target);
    if (href === null) return false;
    event.preventDefault();
    if (!event.ctrlKey && !event.metaKey) return false;
    callbacks.current.onOpenLink(href);
    return true;
  };
  const lastMarkdown = useRef(props.content);
  const original = useRef(props.content);
  const originalDoc = useRef<ProseMirrorNode | null>(null);
  const savedDoc = useRef<ProseMirrorNode | null>(null);
  const savedMarkdown = useRef(props.savedContent ?? props.content);
  const serializedDoc = useRef<ProseMirrorNode | null>(null);
  const composing = useRef(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const maxTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const previousOutline = useRef('');
  const previousImages = useRef('');
  const previousSearch = useRef('');
  const previousSearchNavigation = useRef(props.searchNavigation);
  const initialJson = useMemo(() => importMarkdown(props.content), []);
  const importing = useRef(false);
  const imageListeners = useRef(new Set<() => void>());
  const [error, setError] = useState('');
  const loadFailed = useRef(false);

  const extensions = useMemo(() => editorExtensions({
    image: LocalImage.extend({
      addNodeView() {
        return ({ node }) => {
          const dom = document.createElement('span');
          dom.className = 'document-image';
          dom.contentEditable = 'false';
          let current = node;
          let renderedNode: ProseMirrorNode | null = null;
          let renderedResult: unknown;
          const render = () => {
            const result = callbacks.current.images[String(current.attrs.src)];
            if (renderedNode === current && renderedResult === result) return;
            renderedNode = current;
            renderedResult = result;
            if (result?.ok) {
              const img = dom.firstElementChild instanceof HTMLImageElement ? dom.firstElementChild : document.createElement('img');
              if (img.getAttribute('src') !== result.src) img.src = result.src;
              img.alt = current.attrs.alt ?? '';
              img.title = current.attrs.title ?? '';
              img.dataset.localSrc = current.attrs.src;
              if (dom.firstElementChild !== img) dom.replaceChildren(img);
            } else {
              const placeholder = dom.firstElementChild instanceof HTMLSpanElement ? dom.firstElementChild : document.createElement('span');
              placeholder.className = 'image-placeholder';
              placeholder.dataset.testid = 'missing-image';
              placeholder.textContent = result && !result.ok ? `图片缺失：${current.attrs.src}` : current.attrs.alt || current.attrs.src || '图片';
              placeholder.title = result && !result.ok ? result.message : '正在加载图片';
              placeholder.dataset.localSrc = current.attrs.src;
              if (dom.firstElementChild !== placeholder) dom.replaceChildren(placeholder);
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
        return ({ node, editor, getPos, view }) => {
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
          let renderedHtml: string | undefined;
          let renderedImages: ImageResolutionMap | undefined;
          let renderedIds = '';
          const render = () => {
            const metadata = documentMetadata(view.state.doc);
            const ids = metadata.rawHeadingIds.get(getPos() ?? -1) ?? [];
            const idKey = JSON.stringify(ids);
            const html = rawSourcePreview(current, metadata.context);
            if (html === renderedHtml && callbacks.current.images === renderedImages && idKey === renderedIds) return;
            if (html !== renderedHtml) preview.innerHTML = html;
            if (html !== renderedHtml || callbacks.current.images !== renderedImages) updatePreviewImages(preview, callbacks.current.images);
            renderedHtml = html;
            renderedImages = callbacks.current.images;
            renderedIds = idKey;
            Array.from(preview.querySelectorAll<HTMLElement>('[data-heading-id]'))
              .filter(heading => /^H[1-6]$/.test(heading.tagName))
              .forEach((heading, index) => {
                if (!ids[index]) return;
                heading.id = ids[index];
                heading.dataset.headingId = ids[index];
              });
            if (!preview.textContent?.trim() && !preview.querySelector('img,hr')) preview.textContent = '源码片段';
          };
          let headingRevealed = false;
          const revealHeading = () => {
            headingRevealed = true;
            dom.dataset.headingReveal = 'true';
          };
          const clearHeadingReveal = () => {
            if (!headingRevealed) return;
            headingRevealed = false;
            delete dom.dataset.headingReveal;
          };
          const select = () => {
            const pos = getPos();
            if (typeof pos === 'number') {
              editor.chain().setTextSelection(pos + 1).focus().run();
              // The initial selection may already be here, so selectionUpdate
              // is not guaranteed to fire for an explicit activation.
              selectionChanged();
            }
          };
          const selectionChanged = () => {
            clearHeadingReveal();
            const pos = getPos();
            const { from, to } = editor.state.selection;
            dom.dataset.active = String(typeof pos === 'number' && from >= pos + 1 && to <= pos + current.nodeSize - 1);
          };
          preview.addEventListener('mousedown', event => {
            if ((event.ctrlKey || event.metaKey) && anchorHref(event.target) !== null) event.preventDefault();
          });
          preview.addEventListener('click', event => {
            event.preventDefault();
            if (openLink(event)) { event.stopPropagation(); return; }
            select();
          });
          preview.addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            if (event.defaultPrevented || event.isComposing || view.composing || event.keyCode === 229) return;
            const href = event.key === 'Enter' ? anchorHref(event.target) : null;
            event.preventDefault();
            if (href === null) {
              select();
              return;
            }
            event.stopPropagation();
            callbacks.current.onOpenLink(href);
          });
          editor.on('selectionUpdate', selectionChanged);
          editor.on('transaction', clearHeadingReveal);
          dom.addEventListener('vellora-reveal-heading', revealHeading);
          imageListeners.current.add(render);
          render();
          return { dom, contentDOM, update(next) {
            if (next.type !== current.type) return false;
            current = next; render(); selectionChanged(); return true;
          }, ignoreMutation: mutation => mutation.type !== 'selection' && !contentDOM.contains(mutation.target),
          destroy() {
            editor.off('selectionUpdate', selectionChanged);
            editor.off('transaction', clearHeadingReveal);
            dom.removeEventListener('vellora-reveal-heading', revealHeading);
            imageListeners.current.delete(render);
          } };
        };
      },
    }),
  }), []);

  const report = (editor: Editor) => {
    const metadata = documentMetadata(editor.state.doc);
    const outline = metadata.headings.map(({ id, text, level }) => ({ id, text, level }));
    const outlineKey = JSON.stringify(outline);
    if (outlineKey !== previousOutline.current) {
      previousOutline.current = outlineKey;
      callbacks.current.onOutline(outline);
    }
    const sources = [...new Set(metadata.images)];
    const imageKey = JSON.stringify(sources);
    if (imageKey !== previousImages.current) {
      previousImages.current = imageKey;
      callbacks.current.onImageSources?.(sources);
    }
    const search = searchKey.getState(editor.state);
    const count = findDocumentMatches(editor.state.doc, search?.query ?? '').length;
    const activeIndex = count ? Math.max(0, search?.activeIndex ?? 0) % count : -1;
    const searchValue = `${count}:${activeIndex}`;
    if (searchValue !== previousSearch.current) {
      previousSearch.current = searchValue;
      callbacks.current.onSearch({ count, activeIndex });
    }
    // Unchanged raw nodes still need fresh references / global heading IDs when
    // another block changes. Each view skips DOM updates when its output agrees.
    imageListeners.current.forEach(render => render());
  };

  const syncSearch = (editor: Editor, imported = false) => {
    const { query, searchIndex, active } = callbacks.current;
    const count = findDocumentMatches(editor.state.doc, query).length;
    const activeIndex = count ? Math.max(0, searchIndex) % count : -1;
    const previous = searchKey.getState(editor.state);
    const navigate = imported || previous?.query !== query || previous?.activeIndex !== activeIndex ||
      previousSearchNavigation.current !== callbacks.current.searchNavigation;
    previousSearchNavigation.current = callbacks.current.searchNavigation;
    editor.view.dispatch(editor.state.tr.setMeta(searchKey, { query, activeIndex }).setMeta('addToHistory', false));
    report(editor);
    if (active && count && navigate) {
      const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      editor.view.dom.querySelector('[data-active-search="true"]')?.scrollIntoView?.({
        block: 'center', behavior: reducedMotion ? 'auto' : 'smooth',
      });
    }
  };

  const serialize = (editor: Editor): string | null => {
    if (composing.current || editor.view.composing) return null;
    if (loadFailed.current) return callbacks.current.content;
    try {
      const doc = editor.state.doc;
      if (doc === serializedDoc.current) return lastMarkdown.current;
      // A source edit can import the same PM tree with different Markdown bytes.
      // Undo must restore that latest source spelling, even when it equals the
      // saved tree structurally.
      const markdown = doc.eq(originalDoc.current!) ? original.current :
        doc.eq(savedDoc.current!) ? savedMarkdown.current :
          exportMarkdown(editor).replace(/\r\n|\r|\n/g, documentLineEnding(original.current));
      lastMarkdown.current = markdown;
      serializedDoc.current = doc;
      setError('');
      return markdown;
    } catch {
      const message = '内容转换失败，更改仍保留在编辑器中。';
      setError(message);
      callbacks.current.onError(message);
      return null;
    }
  };

  const clearTimers = () => {
    clearTimeout(idleTimer.current); clearTimeout(maxTimer.current);
    idleTimer.current = undefined; maxTimer.current = undefined;
  };
  const notifyTransaction = (editor: Editor) => {
    const doc = editor.state.doc;
    const dirty = !savedDoc.current || !doc.eq(savedDoc.current) ||
      (original.current !== savedMarkdown.current && !!originalDoc.current && doc.eq(originalDoc.current));
    callbacks.current.onTransaction?.({ dirty });
  };
  const publish = (editor: Editor) => {
    clearTimers();
    const value = serialize(editor);
    if (value !== null) callbacks.current.onChange(value);
  };
  const schedule = (editor: Editor) => {
    if (composing.current) return;
    clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => publish(editor), 100);
    maxTimer.current ??= setTimeout(() => publish(editor), 500);
  };

  const editor: Editor | null = useEditor({
    extensions, content: initialJson, enableInputRules: false, enablePasteRules: false,
    injectCSS: false, shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { class: 'markdown-body document-editor', 'data-testid': 'markdown-body',
        'aria-label': '文档内容', role: 'textbox', 'aria-multiline': 'true', spellcheck: 'false' },
      handlePaste: (_view, event) => {
        event.preventDefault();
        return editor ? pastePlainText(editor, event.clipboardData?.getData('text/plain') ?? '') : true;
      },
      handleDOMEvents: {
        compositionstart: () => { composing.current = true; clearTimers(); return false; },
        compositionend: () => {
          composing.current = false;
          if (editor) schedule(editor);
          return false;
        },
        click: (_view, event) => openLink(event),
      },
      handleKeyDown: (view, event): boolean => {
        if (view.composing || event.isComposing) return false;
        if (event.key === 'Enter' && event.altKey) {
          const { $from } = view.state.selection;
          const link = $from.marks().find(mark => mark.type.name === 'link') ??
            $from.nodeAfter?.marks.find(mark => mark.type.name === 'link');
          if (!link) return false;
          callbacks.current.onOpenLink(link.attrs.href);
          return true;
        }
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
      originalDoc.current ??= editor.schema.nodeFromJSON(initialJson);
      savedDoc.current ??= editor.schema.nodeFromJSON(importMarkdown(savedMarkdown.current));
      report(editor);
    },
    onUpdate: ({ editor }) => {
      if (importing.current) return;
      notifyTransaction(editor);
      schedule(editor);
      report(editor);
    },
  });

  const flush = () => {
    if (!editor) return lastMarkdown.current;
    if (composing.current || editor.view.composing) return null;
    clearTimers();
    // Flush ProseMirror's pending DOM mutation before an immediate save / mode switch.
    (editor.view as typeof editor.view & { domObserver?: { flush: () => void } }).domObserver?.flush();
    return serialize(editor);
  };
  useImperativeHandle(props.ref, () => ({ editor, flush, capture: () => {
    const markdown = flush();
    return editor && markdown !== null ? { doc: editor.state.doc, markdown } : null;
  }, markSaved: snapshot => {
    savedDoc.current = snapshot.doc;
    savedMarkdown.current = snapshot.markdown;
    if (editor) notifyTransaction(editor);
  } }), [editor]);

  useEffect(() => () => clearTimers(), []);
  useEffect(() => {
    if (!editor) return;
    originalDoc.current ??= editor.schema.nodeFromJSON(initialJson);
    savedDoc.current ??= editor.schema.nodeFromJSON(importMarkdown(savedMarkdown.current));
    if (props.savedContent !== undefined && props.savedContent !== savedMarkdown.current) {
      savedMarkdown.current = props.savedContent;
      savedDoc.current = editor.schema.nodeFromJSON(importMarkdown(props.savedContent));
      serializedDoc.current = null;
      notifyTransaction(editor);
    }
  }, [editor, props.savedContent]);

  useEffect(() => {
    if (!editor || !props.active || props.content === lastMarkdown.current) return;
    importing.current = true;
    try {
      const doc = editor.schema.nodeFromJSON(importMarkdown(props.content));
      doc.check();
      clearTimers();
      const { anchor, head } = editor.state.selection;
      const nearest = (pos: number) => Selection.near(doc.resolve(Math.min(Math.max(0, pos), doc.content.size))).from;
      const selection = TextSelection.create(doc, nearest(anchor), nearest(head));
      editor.view.updateState(EditorState.create({ schema: editor.schema, doc, selection, plugins: editor.state.plugins }));
      original.current = props.content;
      originalDoc.current = doc;
      serializedDoc.current = doc;
      lastMarkdown.current = props.content;
      notifyTransaction(editor);
      loadFailed.current = false;
      setError(''); syncSearch(editor, true);
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
  }, [editor, props.query, props.searchIndex, props.searchNavigation, props.active]);

  if (!editor) return null;

  return <div className="document-editor-shell" hidden={!props.active}>
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
  </div>;
}
