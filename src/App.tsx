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
import { renderMarkdownDocument } from './markdown/renderMarkdown';
import {
  applyImageResolutions,
  collectLocalImageResolutionGroups,
  resolveImageGroupsWithLimit,
  type ImageResolutionMap
} from './markdown/resolveImages';
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

const IMAGE_RESOLVE_DEBOUNCE_MS = 300;

function isReadyDirty(state: ViewState, draft: string): boolean {
  return state.status === 'ready' && draft !== state.document.content;
}

function isMarkdownFilePath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.markdown');
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

  const readerRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const imageRequestId = useRef(0);
  const documentRequestId = useRef(0);
  const documentOpenPendingRef = useRef(false);
  const viewStateRef = useRef(viewState);
  const draftRef = useRef(draftContent);
  const initialLoadStarted = useRef(false);

  viewStateRef.current = viewState;
  draftRef.current = draftContent;

  const hasUnsaved = isReadyDirty(viewState, draftContent);

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

  const beginDocumentRequest = useCallback(() => {
    const requestId = ++documentRequestId.current;
    documentOpenPendingRef.current = true;
    setDocumentOpenPending(true);
    return requestId;
  }, []);

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
    setSaveState({ status: 'saving' });
    const result = await saveMarkdownFile(viewState.document.path, draftContent);
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
  }, [draftContent, syncUnsaved, viewState]);

  const resolveAnchorHref = (anchor: HTMLAnchorElement): string | null => {
    const fromData = anchor.getAttribute('data-md-href');
    if (fromData !== null && fromData.length > 0) return fromData;
    const href = anchor.getAttribute('href');
    return href;
  };

  const handleMarkdownNavigation = useCallback(
    async (event: ReactMouseEvent<HTMLDivElement>) => {
      if (documentOpenPendingRef.current) return;
      const target = event.target as HTMLElement | null;
      const anchor = target?.closest('a');
      if (!anchor || viewState.status !== 'ready') return;

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
    [applyOpenResult, beginDocumentRequest, confirmIfDirty, finishDocumentRequest, syncUnsaved, viewState]
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

  useEffect(() => {
    document.title = titleText;
  }, [titleText]);

  return (
    <div className="app-shell" data-testid="app-shell">
      <header className="toolbar" data-testid="toolbar">
        <button
          type="button"
          className="toolbar-btn"
          data-testid="btn-open"
          disabled={documentOpenPending}
          onClick={handleChooseFile}
        >
          打开
        </button>
        <div className="mode-toggle" role="group" aria-label="模式">
          <button
            type="button"
            className={editorMode === 'read' ? 'toolbar-btn active' : 'toolbar-btn'}
            data-testid="btn-read"
            disabled={viewState.status !== 'ready' || documentOpenPending}
            onClick={() => setEditorMode('read')}
          >
            阅读
          </button>
          <button
            type="button"
            className={editorMode === 'edit' ? 'toolbar-btn active' : 'toolbar-btn'}
            data-testid="btn-edit"
            disabled={viewState.status !== 'ready' || documentOpenPending}
            onClick={() => setEditorMode('edit')}
          >
            编辑
          </button>
        </div>
        <button
          type="button"
          className="toolbar-btn"
          data-testid="btn-save"
          disabled={
            viewState.status !== 'ready' || saveState.status === 'saving' || documentOpenPending
          }
          onClick={() => void handleSave()}
        >
          {saveLabel}
        </button>
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
        <span className="toolbar-status" data-testid="status-text">
          {statusMessage ||
            (viewState.status === 'error'
              ? viewState.message
              : viewState.status === 'loading'
                ? '正在打开文件'
                : viewState.status === 'empty'
                  ? '未打开文件'
                  : '')}
        </span>
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
            <textarea
              className="source-editor"
              data-testid="source-editor"
              value={draftContent}
              disabled={documentOpenPending}
              spellCheck={false}
              onChange={(e) => updateDraft(e.target.value)}
            />
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
              <div
                ref={readerRef}
                className="markdown-body"
                data-testid="markdown-body"
                onClick={handleMarkdownNavigation}
                onAuxClick={handleMarkdownNavigation}
                dangerouslySetInnerHTML={{ __html: searchResult.html }}
              />
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
