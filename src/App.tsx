import { useCallback, useEffect, useRef, useState } from 'react';
import appIconUrl from '../src-tauri/icons/128x128.png';
import type { MarkdownOutlineEntry } from './markdown/renderMarkdown';
import { useSourceOutline } from './markdown/useSourceOutline';
import { DocumentEditor } from './editor/DocumentEditor';
import { SourceEditor, type SourceEditorHandle } from './editor/SourceEditor';
import { useDocumentImages } from './markdown/useDocumentImages';
import { useDocumentSession } from './session/useDocumentSession';
import { useDocumentSearch } from './ui/useDocumentSearch';
import { useDocumentViewport } from './ui/useDocumentViewport';
import { SearchPanel } from './ui/SearchPanel';
import { ConfirmationDialogs } from './ui/ConfirmationDialogs';

export default function App() {
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [activeHeadingId, setActiveHeadingId] = useState('');
  const [imageSources, setImageSources] = useState<string[]>([]);
  const [documentOutline, setDocumentOutline] = useState<MarkdownOutlineEntry[]>([]);
  const sourceEditorRef = useRef<SourceEditorHandle>(null);
  const outlineButtonRef = useRef<HTMLButtonElement>(null);
  const outlinePanelRef = useRef<HTMLElement>(null);
  const { state, actions, editorBindings } = useDocumentSession({
    onApplied: () => { search.reset(); setImageSources([]); viewport.reset(); },
    onBeforeModeChange: change => viewport.capture(change),
    onAnchor: id => viewport.scrollToHeading(id),
  });
  const { viewState, draftContent, editorMode, saveState, hasUnsaved,
    documentOpenPending, documentSession, statusMessage, composing, dialog } = state;
  const { chooseFile: handleChooseFile, save: handleSave, switchMode,
    openLink: handleMarkdownNavigation, cancelDialog: cancelDiscardDialog } = actions;
  const { ref: documentEditorRef, onChange: updateDraft,
    onTransaction: onEditorTransaction, onError: handleEditorError } = editorBindings;
  const viewport = useDocumentViewport({ mode: editorMode, session: documentSession,
    editor: documentEditorRef, source: sourceEditorRef });
  const { readerRef, contentRef } = viewport;
  const search = useDocumentSearch({ ready: viewState.status === 'ready', mode: editorMode,
    content: draftContent, composing, blocked: Boolean(dialog) || documentOpenPending,
    editor: documentEditorRef, source: sourceEditorRef,
    focusEditor: viewport.focusEditor });
  const { isOpen: searchOpen, query: searchQuery, index: searchActiveIndex, navigation: searchNavigation } = search;
  const imageMap = useDocumentImages(viewState.status === 'ready' ? viewState.document.path : null, documentSession, imageSources);

  const sourceOutline = useSourceOutline(draftContent, editorMode === 'edit' && outlineOpen, documentSession, composing);
  const outline = editorMode === 'read' ? documentOutline : sourceOutline;

  const updateActiveHeading = useCallback(() => {
    if (editorMode !== 'read' || outline.length === 0) return;
    const reader = readerRef.current;
    const content = contentRef.current;
    if (!reader || !content) return;

    const threshold = content.getBoundingClientRect().top + 96;
    let currentId = outline[0].id;
    for (const entry of outline) {
      const heading = reader.ownerDocument.getElementById(entry.id);
      if (heading && !reader.contains(heading)) continue;
      if (!heading || heading.getBoundingClientRect().top > threshold) break;
      currentId = entry.id;
    }
    setActiveHeadingId((current) => (current === currentId ? current : currentId));
  }, [editorMode, outline]);

  useEffect(() => {
    if (outline.length === 0) {
      setActiveHeadingId('');
      return;
    }
    setActiveHeadingId((current) =>
      outline.some((entry) => entry.id === current) ? current : outline[0].id
    );
  }, [outline]);

  useEffect(() => {
    if (!outlineOpen) return;
    updateActiveHeading();
  }, [outlineOpen, updateActiveHeading]);

  useEffect(() => {
    if (!outlineOpen || dialog) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!window.matchMedia?.('(max-width: 1023px)').matches) return;
      const target = event.target as Node;
      if (!outlinePanelRef.current?.contains(target) && !outlineButtonRef.current?.contains(target)) {
        setOutlineOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [outlineOpen, dialog]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape' && (event.isComposing || event.keyCode === 229 || composing || search.isComposing())) return;
      if (event.key === 'Escape') {
        if (dialog) cancelDiscardDialog();
        else if (searchOpen) search.close();
        else if (outlineOpen) {
          setOutlineOpen(false);
          outlineButtonRef.current?.focus({ preventScroll: true });
        }
        return;
      }
      // A confirmation owns the interaction, including save/quit decisions.
      if (dialog) return;
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void handleSave();
      } else if (mod && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        search.open();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [cancelDiscardDialog, dialog, composing, handleSave, outlineOpen, searchOpen, search.open, search.close, search.isComposing]);

  const titleText =
    viewState.status === 'ready'
      ? `${hasUnsaved ? '• ' : ''}${viewState.document.name} — Vellora`
      : 'Vellora';

  const documentName = viewState.status === 'ready' ? viewState.document.name : 'Vellora';
  const toolbarStatus =
    documentOpenPending
      ? '正在打开文件'
      : saveState.status === 'saving'
        ? '正在保存'
        : saveState.status === 'saved'
          ? '已保存'
          : saveState.status === 'error'
            ? saveState.message
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
  const toolbarFeedback = viewState.status === 'ready' && !documentOpenPending &&
    saveState.status !== 'saving' && saveState.status !== 'saved'
    ? saveState.status === 'error'
      ? saveState.message
      : statusMessage && statusMessage !== viewState.document.name ? statusMessage : ''
    : '';
  const identityStatus = toolbarFeedback
    ? hasUnsaved ? '有未保存更改' : 'Markdown 文档'
    : toolbarStatus;

  useEffect(() => {
    document.title = titleText;
  }, [titleText]);

  return (
    <div className="app-shell" data-testid="app-shell"
      onCompositionStartCapture={event => {
        if (!(event.target as HTMLElement).closest('.document-editor, [data-testid="source-editor"]')) return;
        editorBindings.onCompositionStart();
      }}
      onCompositionEndCapture={event => {
        if (!(event.target as HTMLElement).closest('.document-editor, [data-testid="source-editor"]')) return;
        editorBindings.onCompositionEnd();
      }}>
      <header className="toolbar" data-testid="toolbar" inert={Boolean(dialog)}>
        <div className="toolbar-leading">
          <button
            type="button"
            className="button button--toolbar open-action"
            data-testid="btn-open"
            disabled={documentOpenPending}
            onClick={handleChooseFile}
            title="打开 Markdown 文件"
          >
            <svg className="toolbar-icon" viewBox="0 0 20 20" aria-hidden="true">
              <path d="M2.5 6V4.5a1 1 0 0 1 1-1h4l2 2h6a1 1 0 0 1 1 1V8M3.5 16.5h12l2-8h-12l-2 8-1-10" />
            </svg>
            打开
          </button>
          <div className="document-identity">
            <span className="document-name" title={documentName}>{documentName}</span>
            <span
              className={hasUnsaved ? 'document-status unsaved' : 'document-status'}
              data-testid={toolbarFeedback ? undefined : 'status-text'}
              data-busy={documentOpenPending || saveState.status === 'saving' || viewState.status === 'loading'}
              role={toolbarFeedback ? undefined : 'status'}
              title={identityStatus}
            >
              {identityStatus}
            </span>
          </div>
        </div>

        <div className="mode-toggle" data-mode={editorMode} role="group" aria-label="查看方式">
          <button
            type="button"
            className={editorMode === 'read' ? 'mode-btn active' : 'mode-btn'}
            data-testid="btn-read"
            aria-pressed={editorMode === 'read'}
            disabled={viewState.status !== 'ready' || documentOpenPending}
            onClick={() => {
              switchMode('read');
            }}
          >
            文档
          </button>
          <button
            type="button"
            className={editorMode === 'edit' ? 'mode-btn active' : 'mode-btn'}
            data-testid="btn-edit"
            aria-pressed={editorMode === 'edit'}
            disabled={viewState.status !== 'ready' || documentOpenPending}
            onClick={() => {
              switchMode('edit');
            }}
          >
            源码
          </button>
        </div>

        <div className="toolbar-actions" role="group" aria-label="文档操作">
          <button
            type="button"
            className={hasUnsaved || saveState.status === 'saving'
              ? 'button button--toolbar save-action button--primary'
              : 'button button--toolbar save-action'}
            data-testid="btn-save"
            data-saving={saveState.status === 'saving'}
            aria-busy={saveState.status === 'saving'}
            disabled={viewState.status !== 'ready' || !hasUnsaved || documentOpenPending || saveState.status === 'saving'}
            onClick={() => void handleSave()}
            title="保存 (Ctrl/⌘+S)"
          >
            {saveState.status === 'saving' ? <span className="save-progress" aria-hidden="true" /> : (
              <svg className="toolbar-icon" viewBox="0 0 20 20" aria-hidden="true">
                <path d="M5 3.5h8.5l3 3v8.5a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 15V5A1.5 1.5 0 0 1 5 3.5Z" />
                <path d="M7 3.5v4h5.5v-4M7 16.5v-5h6v5" />
              </svg>
            )}
            保存
          </button>
          <button
            type="button"
            className={searchOpen ? 'button button--icon active' : 'button button--icon'}
            data-testid="btn-search"
            disabled={viewState.status !== 'ready' || documentOpenPending}
            onClick={search.open}
            aria-label="查找"
            aria-expanded={searchOpen}
            aria-controls="document-search"
            title="查找 (Ctrl/⌘+F)"
          >
            <svg className="toolbar-icon" viewBox="0 0 20 20" aria-hidden="true">
              <circle cx="8.5" cy="8.5" r="5.25" />
              <path d="m12.5 12.5 4 4" />
            </svg>
          </button>
          <button
            type="button"
            className={
              outlineOpen ? 'button button--icon active' : 'button button--icon'
            }
            data-testid="btn-outline"
            ref={outlineButtonRef}
            disabled={viewState.status !== 'ready' || documentOpenPending}
            onClick={() => setOutlineOpen((v) => !v)}
            aria-label="目录"
            aria-expanded={outlineOpen}
            aria-controls="document-outline"
            title="目录"
          >
            <svg className="toolbar-icon" viewBox="0 0 20 20" aria-hidden="true">
              <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
              <path d="M7.5 3.5v13M10.5 7h4M10.5 10h4M10.5 13h2" />
            </svg>
          </button>
        </div>
      </header>

      {toolbarFeedback ? (
        <div className="toolbar-feedback" data-testid="status-text" role={saveState.status === 'error' ? 'alert' : 'status'} inert={Boolean(dialog)}>
          {toolbarFeedback}
        </div>
      ) : null}

      <div className="main-row" inert={Boolean(dialog)}>
        {searchOpen && viewState.status === 'ready' ? <SearchPanel search={search} inert={Boolean(dialog)} /> : null}
        {outlineOpen && viewState.status === 'ready' ? (
          <aside ref={outlinePanelRef} id="document-outline" className="outline-panel" data-testid="outline-panel" aria-label="文档目录">
            <div className="outline-heading">
              <span>目录</span>
              <button type="button" className="search-icon-btn outline-close" data-testid="close-outline"
                aria-label="关闭目录" title="关闭目录" onClick={() => {
                  setOutlineOpen(false);
                  outlineButtonRef.current?.focus({ preventScroll: true });
                }}>
                <svg className="toolbar-icon" viewBox="0 0 20 20" aria-hidden="true">
                  <path d="m6 6 8 8M14 6l-8 8" />
                </svg>
              </button>
            </div>
            {outline.length === 0 ? (
              <div className="outline-empty">无大纲</div>
            ) : (
              <nav className="outline-list" aria-label="文档标题">
                {outline.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className={
                      activeHeadingId === entry.id ? 'outline-item current' : 'outline-item'
                    }
                    data-testid="outline-item"
                    data-level={entry.level}
                    title={entry.text}
                    aria-current={activeHeadingId === entry.id ? 'location' : undefined}
                    style={{ paddingLeft: `${(entry.level - 1) * 12 + 8}px` }}
                    onClick={() => {
                      if (composing) return;
                      setActiveHeadingId(entry.id);
                      if (editorMode !== 'read') switchMode('read');
                      if (window.matchMedia?.('(max-width: 1023px)').matches) setOutlineOpen(false);
                      viewport.jumpToHeading(entry.id);
                    }}
                  >
                    <span className="outline-item-label">{entry.text}</span>
                  </button>
                ))}
              </nav>
            )}
          </aside>
        ) : null}

        <main
          ref={contentRef}
          className="content"
          data-testid="content"
          aria-busy={documentOpenPending}
          tabIndex={-1}
          onScroll={outlineOpen ? updateActiveHeading : undefined}
        >
          {viewState.status === 'empty' ? (
            <div className="empty-state" data-testid="empty-state">
              <img
                className="empty-app-icon"
                data-testid="empty-app-icon"
                src={appIconUrl}
                width="56"
                height="56"
                alt=""
                aria-hidden="true"
                draggable="false"
              />
              <p>未打开文件</p>
              <p className="muted">请选择 .md 或 .markdown 文件。</p>
              <button
                type="button"
                className="button button--primary"
                disabled={documentOpenPending}
                onClick={handleChooseFile}
              >
                打开
              </button>
            </div>
          ) : null}

          {viewState.status === 'loading' ? (
            <div className="empty-state" data-testid="loading-state" role="status">
              正在打开文件
            </div>
          ) : null}

          {viewState.status === 'error' ? (
            <div className="empty-state" data-testid="error-state">
              <p>打开失败</p>
              <p className="muted">{viewState.message}</p>
              <button
                type="button"
                className="button button--primary"
                disabled={documentOpenPending}
                onClick={handleChooseFile}
              >
                重新选择
              </button>
            </div>
          ) : null}

          {viewState.status === 'ready' && editorMode === 'edit' ? (
            <SourceEditor ref={sourceEditorRef} value={draftContent} disabled={documentOpenPending}
              onChange={updateDraft} scroller={contentRef} matches={search.matches}
              activeIndex={search.activeIndex} searchOpen={searchOpen} />
          ) : null}

          {viewState.status === 'ready' ? (
            <div className="reader-stage" ref={readerRef} hidden={editorMode !== 'read'}>
              <DocumentEditor key={documentSession} ref={documentEditorRef}
                content={draftContent} active={editorMode === 'read'} disabled={documentOpenPending}
                savedContent={viewState.document.content} onTransaction={onEditorTransaction} onImageSources={setImageSources}
                images={imageMap} query={searchOpen ? searchQuery : ''} searchIndex={searchActiveIndex} searchNavigation={searchNavigation}
                onChange={updateDraft} onOutline={setDocumentOutline} onSearch={search.onDocumentResult}
                onOpenLink={handleMarkdownNavigation} onError={handleEditorError}
                onRecover={editorBindings.onRecover} />
            </div>
          ) : null}
        </main>
      </div>

      <ConfirmationDialogs state={state} actions={actions} restoreEditor={viewport.focusEditor} />
    </div>
  );
}
