import { useCallback, useEffect, useRef, useState } from 'react';
import {
  chooseMarkdownFile, confirmClose, getInitialDocument, inspectMarkdownLink,
  onCloseRequested, onDragDropPaths, onOpenFilePath, openExternalUrl,
  openMarkdownFile, openMarkdownLink, saveMarkdownFile, setUnsavedChanges
} from '../api/tauri';
import type { MarkdownDocument, MarkdownOpenResult } from '../types';
import type { DocumentEditorHandle } from '../editor/DocumentEditor';

type ViewState =
  | { status: 'empty' }
  | { status: 'loading' }
  | { status: 'ready'; document: MarkdownDocument }
  | { status: 'error'; message: string };

type SaveState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'saved' }
  | { status: 'error'; message: string };

export type EditorMode = 'read' | 'edit';
type DiscardReason = 'open' | 'close' | 'switch';
type ConflictStep = 'choose' | 'overwrite' | 'reload';
export type SessionDialog =
  | { kind: 'conflict'; step: ConflictStep; message: string }
  | { kind: 'external'; url: string }
  | { kind: 'discard'; reason: DiscardReason }
  | null;
export type ModeChange = { from: EditorMode; to: EditorMode; content: string };
type SessionOptions = {
  onApplied: () => void;
  onBeforeModeChange: (change: ModeChange) => void;
  onAnchor: (id: string) => void;
};

function isReadyDirty(state: ViewState, draft: string): boolean {
  return state.status === 'ready' && draft !== state.document.content;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Owns document state and native intents; callers receive snapshots and operations. */
export function useDocumentSession(options: SessionOptions) {
  const callbacks = useRef(options);
  callbacks.current = options;
  const [viewState, setViewState] = useState<ViewState>({ status: 'empty' });
  const [draftContent, setDraftContent] = useState('');
  const [editorMode, setEditorMode] = useState<EditorMode>('read');
  const [saveState, setSaveState] = useState<SaveState>({ status: 'idle' });
  const [visualDirty, setVisualDirty] = useState(false);
  const [editorFailure, setEditorFailure] = useState(false);
  const [composing, setComposing] = useState(false);
  const [conflict, setConflict] = useState<null | {
    token: string; requestId: number; path: string; step: ConflictStep; message: string;
  }>(null);
  const [pendingExternal, setPendingExternal] = useState<string | null>(null);
  const [discardDialog, setDiscardDialog] = useState<null | { reason: DiscardReason; proceed: () => void }>(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [documentOpenPending, setDocumentOpenPending] = useState(false);
  const [documentSession, setDocumentSession] = useState(0);
  const documentEditorRef = useRef<DocumentEditorHandle>(null);
  const visualDirtyRef = useRef(false);
  const editorFailureRef = useRef(false);
  const compositionRef = useRef(false);
  const compositionWaiters = useRef<Array<() => void>>([]);
  const compositionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const savingRef = useRef(false);
  const documentRequestId = useRef(0);
  const documentOpenPendingRef = useRef(false);
  const initialLoadStarted = useRef(false);
  const editorModeRef = useRef(editorMode);
  const viewStateRef = useRef(viewState);
  const draftRef = useRef(draftContent);
  const discardDialogRef = useRef(discardDialog);
  editorModeRef.current = editorMode;
  viewStateRef.current = viewState;
  draftRef.current = draftContent;
  discardDialogRef.current = discardDialog;

  const hasUnsaved = editorFailure || (editorMode === 'read' ? visualDirty : isReadyDirty(viewState, draftContent));
  const syncUnsaved = useCallback((dirty: boolean) => {
    void setUnsavedChanges(dirty || editorFailureRef.current || compositionRef.current);
  }, []);

  const onEditorTransaction = useCallback(({ dirty }: { dirty: boolean }) => {
    visualDirtyRef.current = dirty;
    setVisualDirty(dirty);
    if (editorModeRef.current === 'read') syncUnsaved(dirty);
    setSaveState(current => current.status === 'saving' ? current : { status: 'idle' });
  }, [syncUnsaved]);

  const updateDraft = useCallback((value: string) => {
    if (documentOpenPendingRef.current) return;
    if (editorFailureRef.current) setStatusMessage('');
    editorFailureRef.current = false;
    setEditorFailure(false);
    setDraftContent(value);
    draftRef.current = value;
    syncUnsaved(editorModeRef.current === 'read' ? visualDirtyRef.current : isReadyDirty(viewStateRef.current, value));
    setSaveState(current => current.status === 'saving' ? current : { status: 'idle' });
  }, [syncUnsaved]);

  const handleEditorError = useCallback((message: string) => {
    editorFailureRef.current = true;
    setEditorFailure(true);
    setStatusMessage(message);
    syncUnsaved(true);
  }, [syncUnsaved]);

  const flushDocument = useCallback(() => {
    if (editorModeRef.current !== 'read') return true;
    const value = documentEditorRef.current?.flush();
    if (value === null) return false;
    if (value !== undefined && (value !== draftRef.current || editorFailureRef.current)) updateDraft(value);
    return true;
  }, [updateDraft]);

  const beginDocumentRequest = useCallback(() => {
    setConflict(null);
    setSaveState({ status: 'idle' });
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

  useEffect(() => { syncUnsaved(hasUnsaved); }, [hasUnsaved, syncUnsaved]);

  const applyDocument = useCallback((document: MarkdownDocument) => {
    const state: ViewState = { status: 'ready', document };
    setViewState(state);
    viewStateRef.current = state;
    setDraftContent(document.content);
    draftRef.current = document.content;
    setEditorMode('read');
    editorModeRef.current = 'read';
    setDocumentSession(value => value + 1);
    editorFailureRef.current = false;
    setEditorFailure(false);
    visualDirtyRef.current = false;
    setVisualDirty(false);
    setConflict(null);
    setSaveState({ status: 'idle' });
    setStatusMessage(document.name);
    callbacks.current.onApplied();
    syncUnsaved(false);
  }, [syncUnsaved]);

  const confirmIfDirty = useCallback((reason: DiscardReason, proceed: () => void) => {
    const check = () => {
      if (documentEditorRef.current?.editor?.isEditable) {
        const value = documentEditorRef.current.flush();
        if (value !== null && value !== draftRef.current) {
          draftRef.current = value;
          setDraftContent(value);
        }
      }
      if (!editorFailureRef.current && !isReadyDirty(viewStateRef.current, draftRef.current)) proceed();
      else {
        const pending = { reason, proceed };
        discardDialogRef.current = pending;
        setDiscardDialog(pending);
      }
    };
    if (compositionRef.current) compositionWaiters.current.push(check);
    else check();
  }, []);

  const cancelDiscardDialog = useCallback(() => {
    if (discardDialogRef.current?.reason === 'close') void confirmClose(false);
    discardDialogRef.current = null;
    setDiscardDialog(null);
  }, []);

  const discardCloseDraft = useCallback(() => {
    const current = viewStateRef.current;
    if (current.status !== 'ready') return;
    setDocumentSession(value => value + 1);
    editorFailureRef.current = false;
    setEditorFailure(false);
    visualDirtyRef.current = false;
    setVisualDirty(false);
    setDraftContent(current.document.content);
    draftRef.current = current.document.content;
    setEditorMode('read');
    editorModeRef.current = 'read';
    setSaveState({ status: 'idle' });
  }, []);

  const restoreAfterFailedOpen = useCallback((previous: ViewState, message?: string) => {
    if (previous.status === 'ready') {
      // Preserve the live document and any newer input instead of restoring a snapshot.
      syncUnsaved(isReadyDirty(viewStateRef.current, draftRef.current));
    } else if (previous.status === 'loading' || previous.status === 'empty') {
      setViewState({ status: 'empty' });
      syncUnsaved(false);
    } else setViewState(previous);
    if (message) setStatusMessage(message);
  }, [syncUnsaved]);

  const runOpenRequest = useCallback(async (
    load: () => Promise<MarkdownOpenResult>,
    kind: 'open' | 'initial' | 'reload' = 'open'
  ): Promise<boolean> => {
    const requestId = kind === 'initial' ? 0 : beginDocumentRequest();
    const previous = viewStateRef.current;
    if (kind !== 'initial' && previous.status !== 'ready') setViewState({ status: 'loading' });
    const fail = (message: string) => {
      if (kind === 'reload') setSaveState({ status: 'error', message });
      else {
        restoreAfterFailedOpen(previous, message);
        if (previous.status !== 'ready') setViewState({ status: 'error', message });
      }
    };
    try {
      const result = await load();
      if (requestId !== documentRequestId.current) return false;
      if (result.ok) {
        finishDocumentRequest(requestId);
        applyDocument(result.document);
        return true;
      }
      if (kind === 'initial' && result.code === 'NO_INITIAL') return false;
      if (result.code === 'CANCELED') restoreAfterFailedOpen(previous);
      else fail(result.message);
    } catch (error) {
      if (requestId === documentRequestId.current) fail(errorMessage(error));
    } finally {
      if (kind !== 'initial') finishDocumentRequest(requestId);
    }
    return false;
  }, [applyDocument, beginDocumentRequest, finishDocumentRequest, restoreAfterFailedOpen]);

  const openPath = useCallback((path: string) => {
    confirmIfDirty('open', () => { void runOpenRequest(() => openMarkdownFile(path)); });
  }, [confirmIfDirty, runOpenRequest]);

  const handleChooseFile = useCallback(() => {
    if (!documentOpenPendingRef.current) confirmIfDirty('open', () => { void runOpenRequest(chooseMarkdownFile); });
  }, [confirmIfDirty, runOpenRequest]);

  const handleSave = useCallback(async (conflictToken?: string) => {
    if (savingRef.current || documentOpenPendingRef.current) return false;
    savingRef.current = true;
    const requestId = documentRequestId.current;
    try {
      if (compositionRef.current) await new Promise<void>(resolve => compositionWaiters.current.push(resolve));
      if (requestId !== documentRequestId.current || documentOpenPendingRef.current || !flushDocument()) return false;
      const current = viewStateRef.current;
      if (current.status !== 'ready') return false;
      const contentToSave = draftRef.current;
      const editorHandle = documentEditorRef.current;
      const snapshot = editorModeRef.current === 'read' ? editorHandle?.capture() : null;
      if (editorModeRef.current === 'read' && !snapshot) return false;
      setSaveState({ status: 'saving' });
      const result = conflictToken ? await saveMarkdownFile(current.document.path, contentToSave, conflictToken)
        : await saveMarkdownFile(current.document.path, contentToSave);
      if (requestId !== documentRequestId.current) return false;
      if (result.ok) {
        setConflict(null);
        const saved: ViewState = { status: 'ready', document: result.document };
        setViewState(saved);
        viewStateRef.current = saved;
        if (snapshot && editorHandle === documentEditorRef.current) editorHandle?.markSaved(snapshot);
        if (draftRef.current === contentToSave && (!snapshot || !visualDirtyRef.current)) {
          setDraftContent(result.document.content);
          draftRef.current = result.document.content;
        }
        const dirty = compositionRef.current || (editorModeRef.current === 'read' ? visualDirtyRef.current : draftRef.current !== result.document.content);
        syncUnsaved(dirty);
        setSaveState({ status: dirty ? 'idle' : 'saved' });
        return !dirty;
      }
      if (result.code === 'FILE_CHANGED' && result.conflictToken) {
        setConflict({ token: result.conflictToken, requestId, path: current.document.path, step: 'choose', message: result.message });
        setSaveState({ status: 'idle' });
      } else setSaveState({ status: 'error', message: result.message });
      return false;
    } catch (error) {
      if (requestId === documentRequestId.current) setSaveState({ status: 'error', message: errorMessage(error) });
      return false;
    } finally { savingRef.current = false; }
  }, [flushDocument, syncUnsaved]);

  const handleSaveAndProceed = useCallback(async () => {
    const pending = discardDialogRef.current;
    if (pending?.reason !== 'close' || !await handleSave() || discardDialogRef.current !== pending) return;
    discardDialogRef.current = null;
    setDiscardDialog(null);
    pending.proceed();
  }, [handleSave]);

  const resolveConflict = useCallback(async () => {
    const pending = conflict;
    if (!pending || pending.requestId !== documentRequestId.current || documentOpenPendingRef.current) return;
    if (pending.step === 'overwrite') {
      const closing = discardDialogRef.current;
      const saved = await handleSave(pending.token);
      if (saved && closing?.reason === 'close' && discardDialogRef.current === closing) {
        discardDialogRef.current = null;
        setDiscardDialog(null);
        closing.proceed();
      }
    } else if (pending.step === 'reload') {
      if (await runOpenRequest(() => openMarkdownFile(pending.path), 'reload')) cancelDiscardDialog();
    }
  }, [conflict, handleSave, runOpenRequest, cancelDiscardDialog]);

  const openLink = useCallback(async (href: string) => {
    const current = viewStateRef.current;
    if (current.status !== 'ready' || documentOpenPendingRef.current) return;
    if (href.startsWith('#')) {
      try {
        const id = decodeURIComponent(href.slice(1));
        if (id) callbacks.current.onAnchor(id);
      } catch { setStatusMessage('链接格式无效'); }
      return;
    }
    if (!href) return;
    const sourcePath = current.document.path;
    const requestId = documentRequestId.current;
    try {
      const result = await inspectMarkdownLink(sourcePath, href);
      if (requestId !== documentRequestId.current || viewStateRef.current.status !== 'ready' || viewStateRef.current.document.path !== sourcePath) return;
      if (!result.ok) setStatusMessage(result.message);
      else if (result.action === 'external') setPendingExternal(result.url);
      else confirmIfDirty('switch', () => { void runOpenRequest(() => openMarkdownLink(sourcePath, href)); });
    } catch (error) {
      if (requestId === documentRequestId.current) setStatusMessage(errorMessage(error));
    }
  }, [confirmIfDirty, runOpenRequest]);

  const handleConfirmExternal = useCallback(async () => {
    if (!pendingExternal) return;
    try {
      const result = await openExternalUrl(pendingExternal);
      if (!result.ok) setStatusMessage(result.message);
    } catch (error) { setStatusMessage(errorMessage(error)); }
    setPendingExternal(null);
  }, [pendingExternal]);

  const commitMode = useCallback((mode: EditorMode) => {
    const from = editorModeRef.current;
    if (mode === from) return;
    callbacks.current.onBeforeModeChange({ from, to: mode, content: draftRef.current });
    editorModeRef.current = mode;
    setEditorMode(mode);
  }, []);

  const switchMode = useCallback((mode: EditorMode) => {
    const proceed = () => {
      if (mode !== editorModeRef.current && flushDocument()) commitMode(mode);
    };
    if (compositionRef.current) compositionWaiters.current.push(proceed);
    else proceed();
  }, [commitMode, flushDocument]);

  const recoverSource = useCallback((content: string) => {
    updateDraft(content);
    setStatusMessage('');
    commitMode('edit');
  }, [commitMode, updateDraft]);

  const onCompositionStart = useCallback(() => {
    clearTimeout(compositionTimer.current);
    compositionRef.current = true;
    setComposing(true);
    syncUnsaved(true);
  }, [syncUnsaved]);

  const onCompositionEnd = useCallback(() => {
    compositionTimer.current = setTimeout(() => {
      compositionRef.current = false;
      setComposing(false);
      syncUnsaved(editorModeRef.current === 'read' ? visualDirtyRef.current : isReadyDirty(viewStateRef.current, draftRef.current));
      compositionWaiters.current.splice(0).forEach(proceed => proceed());
    }, 0);
  }, [syncUnsaved]);
  useEffect(() => () => { clearTimeout(compositionTimer.current); compositionWaiters.current = []; }, []);

  const requestClose = useCallback(() => {
    confirmIfDirty('close', () => {
      void confirmClose(true).then(result => {
        if (result.ok) discardCloseDraft();
        else setStatusMessage(result.message);
      }).catch(error => setStatusMessage(errorMessage(error)));
    });
  }, [confirmIfDirty, discardCloseDraft]);

  useEffect(() => {
    let disposed = false;
    const unsubs: Array<() => void> = [];
    const register = async (registration: Promise<() => void>) => {
      const unsubscribe = await registration;
      if (disposed) unsubscribe();
      else unsubs.push(unsubscribe);
    };
    void (async () => {
      const registrations = await Promise.allSettled([
        register(onOpenFilePath(openPath)),
        register(onDragDropPaths(paths => {
          const path = paths.find(value => {
            const lower = value.toLowerCase();
            return lower.endsWith('.md') || lower.endsWith('.markdown');
          });
          if (path) openPath(path);
        })),
        register(onCloseRequested(requestClose))
      ]);
      for (const registration of registrations) {
        if (registration.status === 'rejected') console.error('Failed to register a native application event listener.', registration.reason);
      }
      if (disposed || initialLoadStarted.current) return;
      initialLoadStarted.current = true;
      // The renderer readiness handshake must follow native listener registration.
      void runOpenRequest(getInitialDocument, 'initial');
    })();
    return () => { disposed = true; unsubs.forEach(unsubscribe => unsubscribe()); };
  }, [openPath, requestClose, runOpenRequest]);

  const dialog: SessionDialog = conflict ? { kind: 'conflict', step: conflict.step, message: conflict.message }
    : pendingExternal ? { kind: 'external', url: pendingExternal }
      : discardDialog ? { kind: 'discard', reason: discardDialog.reason } : null;

  const save = useCallback(() => handleSave(), [handleSave]);
  const cancelDialog = useCallback(() => {
    if (conflict) setConflict(null);
    else if (pendingExternal) setPendingExternal(null);
    else cancelDiscardDialog();
  }, [conflict, pendingExternal, cancelDiscardDialog]);
  const discardChanges = useCallback(() => {
    const pending = discardDialogRef.current;
    discardDialogRef.current = null;
    setDiscardDialog(null);
    pending?.proceed();
  }, []);
  const chooseConflict = useCallback((step: 'overwrite' | 'reload') => {
    setConflict(current => current && { ...current, step });
  }, []);

  return {
    state: { viewState, draftContent, editorMode, saveState, hasUnsaved, documentOpenPending, documentSession, statusMessage, composing, dialog },
    actions: {
      chooseFile: handleChooseFile, openPath, openLink, save, switchMode, cancelDialog, discardChanges,
      saveAndClose: handleSaveAndProceed,
      chooseConflict,
      confirmConflict: resolveConflict,
      confirmExternal: handleConfirmExternal
    },
    editorBindings: {
      ref: documentEditorRef, onChange: updateDraft, onTransaction: onEditorTransaction,
      onError: handleEditorError, onRecover: recoverSource, onCompositionStart, onCompositionEnd
    }
  };
}

export type DocumentSession = ReturnType<typeof useDocumentSession>;
