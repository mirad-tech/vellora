import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';
import type { DocumentEditorHandle } from '../editor/DocumentEditor';
import type { SourceEditorHandle } from '../editor/SourceEditor';
import { sourceOffsetForPosition, visibleDocumentPosition } from '../editor/sourcePosition';
import type { EditorMode, ModeChange } from '../session/useDocumentSession';

type Options = {
  mode: EditorMode;
  session: number;
  editor: RefObject<DocumentEditorHandle | null>;
  source: RefObject<SourceEditorHandle | null>;
};

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function getPreferredScrollBehavior(): ScrollBehavior {
  return typeof window.matchMedia === 'function' && window.matchMedia(REDUCED_MOTION_QUERY).matches
    ? 'auto'
    : 'smooth';
}


/** Keeps source selection, reading position and focus scoped to the current view. */
export function useDocumentViewport({ mode, session, editor, source }: Options) {
  const contentRef = useRef<HTMLElement>(null);
  const readerRef = useRef<HTMLDivElement>(null);
  const positions = useRef({ read: 0, edit: 0, start: 0, end: 0, sourceVisited: false });
  const firstSourcePosition = useRef<{ offset: number | null; ratio: number } | null>(null);
  const focusAfterModeSwitch = useRef(false);
  const focusEditor = useCallback(() => {
    if (document.activeElement?.closest('[role="search"], [role="dialog"]')) return;
    if (mode === 'edit') source.current?.focus();
    else editor.current?.editor?.view.focus();
  }, [mode, editor, source]);

  const capture = useCallback(({ from, to, content }: ModeChange) => {
    const viewport = contentRef.current;
    const currentEditor = editor.current?.editor;
    if (to === 'edit' && !positions.current.sourceVisited && viewport && currentEditor) {
      const position = visibleDocumentPosition(currentEditor, viewport);
      let offset: number | null = null;
      try { if (position !== null) offset = sourceOffsetForPosition(currentEditor.state.doc, content, position); }
      catch { /* A location that cannot be mapped falls back to the scroll ratio. */ }
      firstSourcePosition.current = {
        offset,
        ratio: viewport.scrollTop / Math.max(1, viewport.scrollHeight - viewport.clientHeight),
      };
    }
    positions.current[from] = viewport?.scrollTop ?? 0;
    const selection = source.current?.getSelection();
    if (selection) Object.assign(positions.current, selection);
    focusAfterModeSwitch.current = true;
  }, [editor, source]);
  const reset = useCallback(() => {
    positions.current = { read: 0, edit: 0, start: 0, end: 0, sourceVisited: false };
    firstSourcePosition.current = null;
    focusAfterModeSwitch.current = true;
  }, []);

  useLayoutEffect(() => {
    const viewport = contentRef.current;
    if (viewport) viewport.scrollTop = positions.current[mode];
    if (mode === 'edit') {
      const first = firstSourcePosition.current;
      firstSourcePosition.current = null;
      positions.current.sourceVisited = true;
      if (source.current && viewport && first) {
        if (first.offset !== null) source.current.revealOffset(first.offset);
        else viewport.scrollTop = first.ratio * Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      } else source.current?.restoreSelection(positions.current);
    }
    if (focusAfterModeSwitch.current) {
      focusAfterModeSwitch.current = false;
      const frame = window.requestAnimationFrame(focusEditor);
      return () => window.cancelAnimationFrame(frame);
    }
  }, [mode, session, source, focusEditor]);

  const scrollToHeading = useCallback((id: string) => {
    const reader = readerRef.current;
    const heading = reader?.ownerDocument.getElementById(id);
    if (!reader || !heading || !reader.contains(heading)) return;
    heading.closest('.raw-source-shell')?.dispatchEvent(new Event('vellora-reveal-heading'));
    contentRef.current?.focus({ preventScroll: true });
    heading.scrollIntoView?.({ behavior: getPreferredScrollBehavior(), block: 'start' });
  }, []);
  const jumpToHeading = useCallback((id: string) => {
    focusAfterModeSwitch.current = false;
    window.setTimeout(() => scrollToHeading(id), 0);
  }, [scrollToHeading]);

  return { contentRef, readerRef, capture, reset, focusEditor, scrollToHeading, jumpToHeading };
}
