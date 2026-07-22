import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from 'react';

import {
  chooseMarkdownFile,
  confirmClose,
  getInitialDocument,
  inspectMarkdownLink,
  onCloseRequested,
  onDragDropPaths,
  onOpenFilePath,
  openExternalUrl,
  openMarkdownFile,
  openMarkdownLink,
  resolveLocalImage,
  saveMarkdownFile,
  setUnsavedChanges
} from './api/tauri';
import {
  renderMarkdownDocument,
  type MarkdownEditableBlockKind
} from './markdown/renderMarkdown';
import {
  applyImageResolutions,
  collectLocalImageResolutionGroups,
  resolveImageGroupsWithLimit,
  type ImageResolutionMap
} from './markdown/resolveImages';
import {
  isEditableBlockRoundTripSafe,
  rebuildEditableBlockSource,
  serializeEditableBlock
} from './markdown/editableMarkdown';
import { applySearchHighlights } from './markdown/searchHtml';
import type { MarkdownDocument } from './types';

type ViewState =
  | { status: 'empty' }
  | { status: 'loading' }
  | { status: 'ready'; document: MarkdownDocument }
  | { status: 'error'; message: string };

type EditorMode = 'read' | 'edit';
type SaveState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'saved' }
  | { status: 'error'; message: string };

type PendingExternalLink = { url: string } | null;

type QuickEditState = {
  blockId: string;
  kind: MarkdownEditableBlockKind;
  start: number;
  end: number;
  originalSource: string;
  originalHtml: string;
  originalDraft: string;
  candidateDraft: string;
  lineEnding: '\r\n' | '\n';
};

const IMAGE_RESOLVE_DEBOUNCE_MS = 300;

function isReadyDirty(state: ViewState, draft: string): boolean {
  return state.status === 'ready' && draft !== state.document.content;
}

function isMarkdownFilePath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.markdown');
}

function detectLineEnding(content: string): '\r\n' | '\n' {
  const firstLineFeed = content.indexOf('\n');
  return firstLineFeed > 0 && content[firstLineFeed - 1] === '\r' ? '\r\n' : '\n';
}

function removeQuickEditAttributes(element: HTMLElement | null): void {
  if (!element) return;
  element.removeAttribute('contenteditable');
  element.removeAttribute('data-testid');
  element.removeAttribute('aria-label');
  element.removeAttribute('spellcheck');
  element.classList.remove('quick-edit-active');
}

function placeCaret(element: HTMLElement, clientX: number, clientY: number): void {
  const documentWithCaret = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const pointRange =
    clientX > 0 && clientY > 0 ? documentWithCaret.caretRangeFromPoint?.(clientX, clientY) : null;
  const selection = window.getSelection();
  if (!selection) return;

  const range =
    pointRange && element.contains(pointRange.startContainer)
      ? pointRange
      : (() => {
          const endRange = document.createRange();
          endRange.selectNodeContents(element);
          endRange.collapse(false);
          return endRange;
        })();
  selection.removeAllRanges();
  selection.addRange(range);
}

function insertPlainTextAtCaret(element: HTMLElement, value: string): void {
  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  if (!selection || !range || !element.contains(range.commonAncestorContainer)) return;

  range.deleteContents();
  const fragment = document.createDocumentFragment();
  let lastNode: Node | null = null;
  value.replace(/\r\n|\r/g, '\n').split('\n').forEach((line, index) => {
    if (index > 0) {
      const breakNode = document.createElement('br');
      fragment.append(breakNode);
      lastNode = breakNode;
    }
    if (line.length > 0) {
      const textNode = document.createTextNode(line);
      fragment.append(textNode);
      lastNode = textNode;
    }
  });
  if (!lastNode) return;
  range.insertNode(fragment);
  range.setStartAfter(lastNode);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

export default function App() {
  const [viewState, setViewState] = useState<ViewState>({ status: 'empty' });
  const [draftContent, setDraftContent] = useState('');
  const [editorMode, setEditorMode] = useState<EditorMode>('read');
  const [saveState, setSaveState] = useState<SaveState>({ status: 'idle' });
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchActiveIndex, setSearchActiveIndex] = useState(0);
  const [imageMap, setImageMap] = useState<ImageResolutionMap>({});
  const [pendingExternal, setPendingExternal] = useState<PendingExternalLink>(null);
  const [discardDialog, setDiscardDialog] = useState<
    null | { reason: 'open' | 'close' | 'switch'; proceed: () => void }
  >(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [documentOpenPending, setDocumentOpenPending] = useState(false);
  const [quickEdit, setQuickEdit] = useState<QuickEditState | null>(null);

  const readerRef = useRef<HTMLDivElement | null>(null);
  const quickEditRef = useRef<HTMLElement | null>(null);
  const quickEditStateRef = useRef<QuickEditState | null>(quickEdit);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const imageRequestId = useRef(0);
  const documentRequestId = useRef(0);
  const documentOpenPendingRef = useRef(false);
  const viewStateRef = useRef(viewState);
  const draftRef = useRef(draftContent);
  const initialLoadStarted = useRef(false);

  const effectiveDraftContent = quickEdit?.candidateDraft ?? draftContent;
  viewStateRef.current = viewState;
  draftRef.current = effectiveDraftContent;
  quickEditStateRef.current = quickEdit;

  const hasUnsaved = isReadyDirty(viewState, effectiveDraftContent);

  /** Sync dirty flag immediately (do not wait for useEffect) to avoid close races. */
  const syncUnsaved = useCallback((dirty: boolean) => {
    void setUnsavedChanges(dirty);
  }, []);

  const updateDraft = useCallback(
    (value: string) => {
      if (documentOpenPendingRef.current) return;
      setDraftContent(value);
      draftRef.current = value;
      const dirty = isReadyDirty(viewStateRef.current, value);
      syncUnsaved(dirty);
      setSaveState({ status: 'idle' });
    },
    [syncUnsaved]
  );

  const commitQuickEdit = useCallback(() => {
    const current = quickEditStateRef.current;
    if (!current) return;
    removeQuickEditAttributes(quickEditRef.current);
    quickEditRef.current = null;
    draftRef.current = current.candidateDraft;
    setDraftContent(current.candidateDraft);
    quickEditStateRef.current = null;
    setQuickEdit(null);
  }, []);

  const beginDocumentRequest = useCallback(() => {
    const requestId = ++documentRequestId.current;
    commitQuickEdit();
    documentOpenPendingRef.current = true;
    setDocumentOpenPending(true);
    return requestId;
  }, [commitQuickEdit]);

  const finishDocumentRequest = useCallback((requestId: number) => {
    if (requestId !== documentRequestId.current) return;
    documentOpenPendingRef.current = false;
    setDocumentOpenPending(false);
  }, []);

  // Keep backend in sync on non-edit transitions (open / save / apply).
  useEffect(() => {
    void setUnsavedChanges(hasUnsaved);
  }, [hasUnsaved]);

  const rendered = useMemo(() => renderMarkdownDocument(draftContent), [draftContent]);

  const baseHtml = rendered.status === 'ready' ? rendered.html : '';
  const outline = rendered.status === 'ready' ? rendered.outline : [];

  const htmlWithImages = useMemo(
    () => applyImageResolutions(baseHtml, imageMap),
    [baseHtml, imageMap]
  );

  const searchResult = useMemo(
    () => applySearchHighlights(htmlWithImages, searchOpen ? searchQuery : '', searchActiveIndex),
    [htmlWithImages, searchOpen, searchQuery, searchActiveIndex]
  );
  const readerHtml = useMemo(() => ({ __html: searchResult.html }), [searchResult.html]);

  useEffect(() => {
    if (rendered.status !== 'ready' || viewState.status !== 'ready') {
      setImageMap({});
      return;
    }

    const documentPath = viewState.document.path;
    const requestId = ++imageRequestId.current;
    const timer = window.setTimeout(() => {
      const groups = collectLocalImageResolutionGroups(baseHtml);
      if (groups.length === 0) {
        setImageMap({});
        return;
      }
      void resolveImageGroupsWithLimit(groups, (src) => resolveLocalImage(documentPath, src), 4, () =>
        requestId !== imageRequestId.current
      ).then((map) => {
        if (requestId === imageRequestId.current) {
          setImageMap(map);
        }
      });
    }, IMAGE_RESOLVE_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [baseHtml, rendered.status, viewState]);

  useEffect(() => {
    if (!searchOpen) return;
    const active = readerRef.current?.querySelector<HTMLElement>('[data-active-search="true"]');
    if (active && typeof active.scrollIntoView === 'function') {
      active.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [searchResult.activeIndex, searchResult.count, searchOpen, searchResult.html]);

  const applyDocument = useCallback(
    (document: MarkdownDocument) => {
      setViewState({ status: 'ready', document });
      setDraftContent(document.content);
      draftRef.current = document.content;
      viewStateRef.current = { status: 'ready', document };
      setEditorMode('read');
      quickEditStateRef.current = null;
      setQuickEdit(null);
      setSaveState({ status: 'idle' });
      setStatusMessage(document.name);
      setSearchQuery('');
      setSearchActiveIndex(0);
      setImageMap({});
      syncUnsaved(false);
    },
    [syncUnsaved]
  );

  const confirmIfDirty = useCallback(
    (reason: 'open' | 'close' | 'switch', proceed: () => void) => {
      if (!isReadyDirty(viewStateRef.current, draftRef.current)) {
        proceed();
        return;
      }
      setDiscardDialog({ reason, proceed });
    },
    []
  );

  /** Restore non-ready UI after a failed open; a ready document is preserved in place. */
  const restoreAfterFailedOpen = useCallback(
    (prevView: ViewState, message?: string) => {
      if (prevView.status === 'ready') {
        // The ready document remains visible while opening. Preserve any edits or save
        // that happened while the request was pending instead of restoring a stale snapshot.
        const currentView = viewStateRef.current;
        const currentDraft = draftRef.current;
        if (currentView.status === 'ready') {
          syncUnsaved(isReadyDirty(currentView, currentDraft));
        }
        if (message) setStatusMessage(message);
        return;
      }
      if (prevView.status === 'loading' || prevView.status === 'empty') {
        setViewState({ status: 'empty' });
        syncUnsaved(false);
        return;
      }
      setViewState(prevView);
      if (message) setStatusMessage(message);
    },
    [syncUnsaved]
  );

  const applyOpenResult = useCallback(
    (requestId: number, document: MarkdownDocument) => {
      if (requestId !== documentRequestId.current) return;
      finishDocumentRequest(requestId);
      applyDocument(document);
    },
    [applyDocument, finishDocumentRequest]
  );

  const openPath = useCallback(
    (path: string) => {
      confirmIfDirty('open', () => {
        const requestId = beginDocumentRequest();
        const prevView = viewStateRef.current;
        if (prevView.status !== 'ready') {
          setViewState({ status: 'loading' });
        }
        void openMarkdownFile(path).then((result) => {
          if (requestId !== documentRequestId.current) return;
          if (result.ok) {
            applyOpenResult(requestId, result.document);
            return;
          }
          if (result.code === 'CANCELED') {
            restoreAfterFailedOpen(prevView);
            return;
          }
          restoreAfterFailedOpen(prevView, result.message);
          if (prevView.status !== 'ready') {
            setViewState({ status: 'error', message: result.message });
          }
        }).finally(() => finishDocumentRequest(requestId));
      });
    },
    [
      applyOpenResult,
      beginDocumentRequest,
      confirmIfDirty,
      finishDocumentRequest,
      restoreAfterFailedOpen
    ]
  );

  const handleChooseFile = useCallback(() => {
    if (documentOpenPendingRef.current) return;
    confirmIfDirty('open', () => {
      const requestId = beginDocumentRequest();
      const prevView = viewStateRef.current;
      if (prevView.status !== 'ready') {
        setViewState({ status: 'loading' });
      }
      void chooseMarkdownFile().then((result) => {
        if (requestId !== documentRequestId.current) return;
        if (result.ok) {
          applyOpenResult(requestId, result.document);
          return;
        }
        if (result.code === 'CANCELED') {
          restoreAfterFailedOpen(prevView);
          return;
        }
        restoreAfterFailedOpen(prevView, result.message);
        if (prevView.status !== 'ready') {
          setViewState({ status: 'error', message: result.message });
        }
      }).finally(() => finishDocumentRequest(requestId));
    });
  }, [
    applyOpenResult,
    beginDocumentRequest,
    confirmIfDirty,
    finishDocumentRequest,
    restoreAfterFailedOpen
  ]);

  const handleSave = useCallback(async () => {
    if (viewState.status !== 'ready' || documentOpenPendingRef.current) return;
    const contentToSave = draftRef.current;
    commitQuickEdit();
    setSaveState({ status: 'saving' });
    const result = await saveMarkdownFile(viewState.document.path, contentToSave);
    if (result.ok) {
      setViewState({ status: 'ready', document: result.document });
      setDraftContent(result.document.content);
      draftRef.current = result.document.content;
      viewStateRef.current = { status: 'ready', document: result.document };
      syncUnsaved(false);
      setSaveState({ status: 'saved' });
      window.setTimeout(() => setSaveState({ status: 'idle' }), 1500);
    } else {
      setSaveState({ status: 'error', message: result.message });
    }
  }, [commitQuickEdit, syncUnsaved, viewState]);

  const resolveAnchorHref = (anchor: HTMLAnchorElement): string | null => {
    const fromData = anchor.getAttribute('data-md-href');
    if (fromData !== null && fromData.length > 0) return fromData;
    const href = anchor.getAttribute('href');
    return href;
  };

  const beginQuickEdit = useCallback(
    (target: HTMLElement, clientX: number, clientY: number) => {
      if (
        editorMode !== 'read' ||
        viewState.status !== 'ready' ||
        documentOpenPendingRef.current ||
        rendered.status !== 'ready'
      ) {
        return;
      }

      const blockElement = target.closest<HTMLElement>('[data-edit-block-id]');
      const blockId = blockElement?.dataset.editBlockId;
      if (!blockElement || !blockId) return;
      if (quickEditRef.current === blockElement) return;
      if (quickEditStateRef.current) commitQuickEdit();
      const block = rendered.editableBlocks.find((entry) => entry.id === blockId);
      if (!block) return;

      const source = draftRef.current.slice(block.start, block.end);
      const lineEnding = detectLineEnding(draftRef.current);
      if (!isEditableBlockRoundTripSafe(block.kind, source, blockElement, lineEnding)) return;
      const nextQuickEdit: QuickEditState = {
        blockId,
        kind: block.kind,
        start: block.start,
        end: block.end,
        originalSource: source,
        originalHtml: blockElement.innerHTML,
        originalDraft: draftRef.current,
        candidateDraft: draftRef.current,
        lineEnding
      };
      quickEditStateRef.current = nextQuickEdit;
      setQuickEdit(nextQuickEdit);
      quickEditRef.current = blockElement;
      blockElement.setAttribute('contenteditable', 'true');
      blockElement.setAttribute('spellcheck', 'true');
      blockElement.dataset.testid = 'quick-edit-surface';
      blockElement.setAttribute('aria-label', '编辑当前 Markdown 内容块');
      blockElement.classList.add('quick-edit-active');
      blockElement.focus({ preventScroll: true });
      placeCaret(blockElement, clientX, clientY);
    },
    [commitQuickEdit, editorMode, rendered, viewState.status]
  );

  const updateQuickEdit = useCallback(
    (element: HTMLElement) => {
      const current = quickEditStateRef.current;
      if (!current || documentOpenPendingRef.current) return;
      const editedMarkdown = serializeEditableBlock(element);
      const replacement = rebuildEditableBlockSource(
        current.kind,
        current.originalSource,
        editedMarkdown,
        current.lineEnding
      );
      const nextDraft =
        current.originalDraft.slice(0, current.start) +
        replacement +
        current.originalDraft.slice(current.end);
      draftRef.current = nextDraft;
      const dirty = isReadyDirty(viewStateRef.current, nextDraft);
      syncUnsaved(dirty);
      setSaveState({ status: 'idle' });
      const nextQuickEdit: QuickEditState = {
        ...current,
        candidateDraft: nextDraft
      };
      quickEditStateRef.current = nextQuickEdit;
      setQuickEdit(nextQuickEdit);
    },
    [syncUnsaved]
  );

  const cancelQuickEdit = useCallback(() => {
    const current = quickEditStateRef.current;
    if (!current) return;
    if (quickEditRef.current) {
      quickEditRef.current.innerHTML = current.originalHtml;
    }
    removeQuickEditAttributes(quickEditRef.current);
    quickEditRef.current = null;
    draftRef.current = current.originalDraft;
    syncUnsaved(isReadyDirty(viewStateRef.current, current.originalDraft));
    setSaveState({ status: 'idle' });
    quickEditStateRef.current = null;
    setQuickEdit(null);
  }, [syncUnsaved]);

  const handleMarkdownNavigation = useCallback(
    async (event: ReactMouseEvent<HTMLDivElement>) => {
      if (documentOpenPendingRef.current) return;
      const target = event.target as HTMLElement | null;
      const anchor = target?.closest('a');
      const activeEditor = quickEditRef.current;
      if (target && activeEditor?.contains(target)) {
        if (anchor) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      if (!anchor) {
        if (event.button === 0 && target) beginQuickEdit(target, event.clientX, event.clientY);
        return;
      }
      if (viewState.status !== 'ready') return;

      // Intercept primary and auxiliary (middle) clicks.
      if (event.button !== 0 && event.button !== 1) return;

      const href = resolveAnchorHref(anchor as HTMLAnchorElement);
      if (href === null) return;

      event.preventDefault();
      event.stopPropagation();

      if (href.startsWith('#')) {
        const id = decodeURIComponent(href.slice(1));
        if (id) {
          const el = readerRef.current?.querySelector(`#${CSS.escape(id)}`);
          if (el && typeof (el as HTMLElement).scrollIntoView === 'function') {
            (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        }
        return;
      }

      // Non-navigable placeholder from renderer
      if (href === '#' && !anchor.getAttribute('data-md-href')) {
        return;
      }

      const sourcePath = viewState.document.path;
      const result = await inspectMarkdownLink(sourcePath, href);
      if (!result.ok) {
        setStatusMessage(result.message);
        return;
      }

      if (result.action === 'external') {
        setPendingExternal({ url: result.url });
        return;
      }

      // Local Markdown: only switch session after user confirms discard (if dirty).
      confirmIfDirty('switch', () => {
        const requestId = beginDocumentRequest();
        void openMarkdownLink(sourcePath, href).then((opened) => {
          if (requestId !== documentRequestId.current) return;
          if (opened.ok) {
            applyOpenResult(requestId, opened.document);
            return;
          }
          // Failed open must not clear dirty / replace document.
          const stillDirty = isReadyDirty(viewStateRef.current, draftRef.current);
          syncUnsaved(stillDirty);
          setStatusMessage(opened.message);
        }).finally(() => finishDocumentRequest(requestId));
      });
    },
    [
      applyOpenResult,
      beginDocumentRequest,
      beginQuickEdit,
      confirmIfDirty,
      finishDocumentRequest,
      syncUnsaved,
      viewState
    ]
  );

  const handleConfirmExternal = useCallback(async () => {
    if (!pendingExternal) return;
    const result = await openExternalUrl(pendingExternal.url);
    if (!result.ok) {
      setStatusMessage(result.message);
    }
    setPendingExternal(null);
  }, [pendingExternal]);

  useEffect(() => {
    if (initialLoadStarted.current) return;
    initialLoadStarted.current = true;
    // Initial CLI probing must not block the Open button. A manual request increments
    // the same sequence and makes a late initial result stale.
    const requestId = ++documentRequestId.current;
    void getInitialDocument().then((result) => {
      if (requestId === documentRequestId.current && result.ok) {
        applyDocument(result.document);
      }
    });
  }, [applyDocument]);

  useEffect(() => {
    let unsubs: Array<() => void> = [];

    void onOpenFilePath((path) => {
      openPath(path);
    }).then((u) => unsubs.push(u));

    void onDragDropPaths((paths) => {
      const md = paths.find(isMarkdownFilePath);
      if (md) openPath(md);
    }).then((u) => unsubs.push(u));

    void onCloseRequested(() => {
      confirmIfDirty('close', () => {
        // allow_close one-shot closes without requiring dirty=false first
        void confirmClose(true);
      });
    }).then((u) => unsubs.push(u));

    return () => {
      for (const u of unsubs) u();
    };
  }, [confirmIfDirty, openPath]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void handleSave();
        return;
      }
      if (mod && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        setSearchOpen(true);
        window.setTimeout(() => searchInputRef.current?.focus(), 0);
        return;
      }
      if (event.key === 'Escape') {
        if (pendingExternal) {
          setPendingExternal(null);
          return;
        }
        if (discardDialog) {
          setDiscardDialog(null);
          return;
        }
        if (searchOpen) {
          setSearchOpen(false);
          return;
        }
        if (outlineOpen) {
          setOutlineOpen(false);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [discardDialog, handleSave, outlineOpen, pendingExternal, searchOpen]);

  const saveLabel =
    saveState.status === 'saving'
      ? '保存中...'
      : saveState.status === 'saved'
        ? '已保存'
        : saveState.status === 'error'
          ? '保存失败'
          : hasUnsaved
            ? '未保存'
            : '保存';

  const titleText =
    viewState.status === 'ready'
      ? `${hasUnsaved ? '• ' : ''}${viewState.document.name} — Vellora`
      : 'Vellora';

  const documentName = viewState.status === 'ready' ? viewState.document.name : 'Vellora';
  const toolbarStatus =
    quickEdit !== null
      ? '正在编辑当前内容块'
      : viewState.status === 'ready'
        ? statusMessage && statusMessage !== viewState.document.name
          ? statusMessage
          : hasUnsaved
            ? '有未保存更改'
            : 'Markdown 文档'
        : viewState.status === 'error'
          ? viewState.message
          : viewState.status === 'loading'
            ? '正在打开文件'
            : '未打开文件';

  useEffect(() => {
    document.title = titleText;
  }, [titleText]);

  return (
    <div className="app-shell" data-testid="app-shell">
      <header className="toolbar" data-testid="toolbar">
        <div className="toolbar-leading">
          <button
            type="button"
            className="toolbar-btn open-action"
            data-testid="btn-open"
            disabled={documentOpenPending}
            onClick={handleChooseFile}
            title="打开 Markdown 文件"
          >
            打开
          </button>
          <div className="document-identity">
            <span className="document-name">{documentName}</span>
            <span
              className={hasUnsaved ? 'document-status unsaved' : 'document-status'}
              data-testid="status-text"
            >
              {toolbarStatus}
            </span>
          </div>
        </div>

        <div className="mode-toggle" role="group" aria-label="查看方式">
          <button
            type="button"
            className={editorMode === 'read' ? 'mode-btn active' : 'mode-btn'}
            data-testid="btn-read"
            disabled={viewState.status !== 'ready' || documentOpenPending}
            onClick={() => {
              commitQuickEdit();
              setEditorMode('read');
            }}
          >
            预览
          </button>
          <button
            type="button"
            className={editorMode === 'edit' ? 'mode-btn active' : 'mode-btn'}
            data-testid="btn-edit"
            disabled={viewState.status !== 'ready' || documentOpenPending}
            onClick={() => {
              commitQuickEdit();
              setEditorMode('edit');
            }}
          >
            源码
          </button>
        </div>

        <div className="toolbar-actions">
          <button
            type="button"
            className={outlineOpen ? 'toolbar-btn active' : 'toolbar-btn'}
            data-testid="btn-outline"
            disabled={viewState.status !== 'ready'}
            onClick={() => setOutlineOpen((v) => !v)}
          >
            目录
          </button>
          <button
            type="button"
            className={searchOpen ? 'toolbar-btn active' : 'toolbar-btn'}
            data-testid="btn-search"
            disabled={viewState.status !== 'ready'}
            onClick={() => {
              setSearchOpen((v) => !v);
              window.setTimeout(() => searchInputRef.current?.focus(), 0);
            }}
          >
            查找
          </button>
          <button
            type="button"
            className={hasUnsaved ? 'toolbar-btn save-action dirty' : 'toolbar-btn save-action'}
            data-testid="btn-save"
            disabled={
              viewState.status !== 'ready' || saveState.status === 'saving' || documentOpenPending
            }
            onClick={() => void handleSave()}
            title="保存（Ctrl+S）"
          >
            {saveLabel}
          </button>
        </div>
      </header>

      {searchOpen && viewState.status === 'ready' ? (
        <div className="search-bar" data-testid="search-bar">
          <input
            ref={searchInputRef}
            type="search"
            className="search-input"
            data-testid="search-input"
            placeholder="搜索"
            aria-label="搜索当前文档"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setSearchActiveIndex(0);
            }}
            onKeyDown={(e: ReactKeyboardEvent<HTMLInputElement>) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (searchResult.count <= 0) return;
                const delta = e.shiftKey ? -1 : 1;
                setSearchActiveIndex(
                  (searchResult.activeIndex + delta + searchResult.count) % searchResult.count
                );
              }
            }}
          />
          <span className="search-count" data-testid="search-count">
            {searchResult.count > 0
              ? `${searchResult.activeIndex + 1}/${searchResult.count}`
              : '无结果'}
          </span>
          <button
            type="button"
            className="toolbar-btn"
            data-testid="search-prev"
            disabled={searchResult.count <= 0}
            onClick={() =>
              setSearchActiveIndex(
                (searchResult.activeIndex - 1 + searchResult.count) % searchResult.count
              )
            }
          >
            上一个
          </button>
          <button
            type="button"
            className="toolbar-btn"
            data-testid="search-next"
            disabled={searchResult.count <= 0}
            onClick={() =>
              setSearchActiveIndex((searchResult.activeIndex + 1) % searchResult.count)
            }
          >
            下一个
          </button>
          <button
            type="button"
            className="toolbar-btn search-close"
            data-testid="search-close"
            onClick={() => setSearchOpen(false)}
            aria-label="关闭查找"
          >
            关闭
          </button>
        </div>
      ) : null}

      <div className="main-row">
        {outlineOpen && viewState.status === 'ready' ? (
          <aside className="outline-panel" data-testid="outline-panel">
            <div className="outline-heading">大纲</div>
            {outline.length === 0 ? (
              <div className="outline-empty">无大纲</div>
            ) : (
              <nav className="outline-list">
                {outline.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className="outline-item"
                    data-testid="outline-item"
                    data-level={entry.level}
                    style={{ paddingLeft: `${(entry.level - 1) * 12 + 8}px` }}
                    onClick={() => {
                      if (editorMode !== 'read') setEditorMode('read');
                      window.setTimeout(() => {
                        const el = readerRef.current?.querySelector(`#${CSS.escape(entry.id)}`);
                        el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                      }, 0);
                    }}
                  >
                    {entry.text}
                  </button>
                ))}
              </nav>
            )}
          </aside>
        ) : null}

        <main className="content" data-testid="content">
          {viewState.status === 'empty' ? (
            <div className="empty-state" data-testid="empty-state">
              <div className="empty-mark" aria-hidden="true">MD</div>
              <p>未打开文件</p>
              <p className="muted">请选择 .md 或 .markdown 文件。</p>
              <button
                type="button"
                className="toolbar-btn primary"
                disabled={documentOpenPending}
                onClick={handleChooseFile}
              >
                打开
              </button>
            </div>
          ) : null}

          {viewState.status === 'loading' ? (
            <div className="empty-state" data-testid="loading-state">
              正在打开文件
            </div>
          ) : null}

          {viewState.status === 'error' ? (
            <div className="empty-state" data-testid="error-state">
              <p>打开失败</p>
              <p className="muted">{viewState.message}</p>
              <button
                type="button"
                className="toolbar-btn primary"
                disabled={documentOpenPending}
                onClick={handleChooseFile}
              >
                重新选择
              </button>
            </div>
          ) : null}

          {viewState.status === 'ready' && editorMode === 'edit' ? (
            <div className="source-editor-shell">
              <textarea
                className="source-editor"
                data-testid="source-editor"
                value={draftContent}
                disabled={documentOpenPending}
                spellCheck={false}
                aria-label="Markdown 源码"
                onChange={(e) => updateDraft(e.target.value)}
              />
            </div>
          ) : null}

          {viewState.status === 'ready' && editorMode === 'read' ? (
            rendered.status === 'error' ? (
              <div className="empty-state" data-testid="parse-error">
                Markdown 解析失败，请切换源码编辑修复。
              </div>
            ) : rendered.status === 'empty' ? (
              <div className="empty-state" data-testid="doc-empty">
                文件为空
              </div>
            ) : (
              <div className="reader-stage">
                <div
                  ref={readerRef}
                  className="markdown-body"
                  data-testid="markdown-body"
                  onClick={handleMarkdownNavigation}
                  onAuxClick={handleMarkdownNavigation}
                  onInput={(event) => {
                    const editor = quickEditRef.current;
                    if (editor?.contains(event.target as Node)) updateQuickEdit(editor);
                  }}
                  onBlur={(event) => {
                    if (event.target === quickEditRef.current) commitQuickEdit();
                  }}
                  onPaste={(event) => {
                    const editor = quickEditRef.current;
                    if (!editor?.contains(event.target as Node)) return;
                    event.preventDefault();
                    insertPlainTextAtCaret(editor, event.clipboardData.getData('text/plain'));
                    updateQuickEdit(editor);
                  }}
                  onKeyDown={(event) => {
                    const editor = quickEditRef.current;
                    if (!editor?.contains(event.target as Node)) return;
                    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      event.stopPropagation();
                      cancelQuickEdit();
                      return;
                    }
                    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                      event.preventDefault();
                      event.stopPropagation();
                      commitQuickEdit();
                      return;
                    }
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      insertPlainTextAtCaret(editor, '\n');
                      updateQuickEdit(editor);
                    }
                  }}
                  dangerouslySetInnerHTML={readerHtml}
                />
              </div>
            )
          ) : null}
        </main>
      </div>

      {pendingExternal ? (
        <div className="modal-backdrop" data-testid="external-link-modal">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="ext-title">
            <h2 id="ext-title">安全提示</h2>
            <p>您即将访问外部链接，确认离开此应用程序吗？</p>
            <p className="modal-url">{pendingExternal.url}</p>
            <div className="modal-actions">
              <button
                type="button"
                className="toolbar-btn"
                data-testid="external-cancel"
                onClick={() => setPendingExternal(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="toolbar-btn primary"
                data-testid="external-confirm"
                onClick={() => void handleConfirmExternal()}
              >
                继续访问
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {discardDialog ? (
        <div className="modal-backdrop" data-testid="discard-modal">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="discard-title">
            <h2 id="discard-title">未保存更改</h2>
            <p>当前文档有未保存更改。</p>
            <div className="modal-actions">
              <button
                type="button"
                className="toolbar-btn"
                data-testid="discard-cancel"
                onClick={() => setDiscardDialog(null)}
              >
                继续编辑
              </button>
              <button
                type="button"
                className="toolbar-btn danger"
                data-testid="discard-confirm"
                onClick={() => {
                  const { proceed } = discardDialog;
                  setDiscardDialog(null);
                  // Do not clear dirty here — only successful document replace clears it.
                  proceed();
                }}
              >
                放弃更改
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
