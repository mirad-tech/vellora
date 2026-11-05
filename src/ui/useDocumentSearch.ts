import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import type { DocumentEditorHandle } from '../editor/DocumentEditor';
import type { SourceEditorHandle, SourceSearchMatch } from '../editor/SourceEditor';
import { findDocumentMatches } from '../editor/extensions';
import type { EditorMode } from '../session/useDocumentSession';

type Options = {
  ready: boolean;
  mode: EditorMode;
  content: string;
  composing: boolean;
  blocked: boolean;
  editor: RefObject<DocumentEditorHandle | null>;
  source: RefObject<SourceEditorHandle | null>;
  focusEditor: () => void;
};

function normalizeSearchQuery(query: string): string {
  return query.trim();
}

function escapeSearchQuery(query: string): string {
  return query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findSourceSearchMatches(
  source: string,
  rawQuery: string
): SourceSearchMatch[] {
  const query = normalizeSearchQuery(rawQuery);
  if (!query) return [];

  const matches: SourceSearchMatch[] = [];
  const matcher = new RegExp(escapeSearchQuery(query), 'giu');
  for (const match of source.matchAll(matcher)) {
    if (match.index === undefined) continue;
    matches.push({
      start: match.index,
      end: match.index + match[0].length
    });
  }

  return matches;
}


/** Coordinates two search surfaces without owning either editor's document or DOM. */
export function useDocumentSearch({ ready, mode, content, composing, blocked, editor, source, focusEditor }: Options) {
  const [isOpen, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [navigation, setNavigation] = useState(0);
  const [documentResult, onDocumentResult] = useState({ count: 0, activeIndex: -1 });
  const inputRef = useRef<HTMLInputElement>(null);
  const inputComposing = useRef(false);
  const focusTimer = useRef<number | undefined>(undefined);
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  useEffect(() => {
    if (blocked) window.clearTimeout(focusTimer.current);
    return () => window.clearTimeout(focusTimer.current);
  }, [blocked]);
  const previousNavigation = useRef({ mode, query: '', index: 0, open: false });
  const matches = useMemo(() => findSourceSearchMatches(content, isOpen && mode === 'edit' ? query : ''),
    [content, mode, isOpen, query]);
  const sourceResult = useMemo(() => ({
    count: matches.length,
    activeIndex: matches.length ? Math.max(0, index) % matches.length : -1,
  }), [matches, index]);
  const { count, activeIndex } = mode === 'edit' ? sourceResult : documentResult;

  const open = useCallback(() => {
    if (!ready || blockedRef.current) return;
    setOpen(true);
    window.clearTimeout(focusTimer.current);
    focusTimer.current = window.setTimeout(() => {
      const input = inputRef.current;
      if (blockedRef.current || !input || input.closest('[inert]')) return;
      input.focus({ preventScroll: true });
      input.select();
    }, 0);
  }, [ready]);
  const close = useCallback(() => {
    window.clearTimeout(focusTimer.current);
    if (document.activeElement?.closest('[role="search"]') && count > 0) {
      if (mode === 'edit') {
        const match = matches[activeIndex];
        if (match) source.current?.selectMatch(match);
      } else {
        const current = editor.current?.editor;
        const match = current && findDocumentMatches(current.state.doc, query)[activeIndex];
        if (match) current.commands.setTextSelection(match);
      }
    }
    setOpen(false);
    window.requestAnimationFrame(focusEditor);
  }, [mode, count, activeIndex, matches, query, editor, source, focusEditor]);
  const navigate = useCallback((delta: number) => {
    if (count <= 0) return;
    setIndex((activeIndex + delta + count) % count);
    setNavigation(value => value + 1);
  }, [count, activeIndex]);
  const changeQuery = useCallback((value: string) => { setQuery(value); setIndex(0); }, []);
  const reset = useCallback(() => {
    window.clearTimeout(focusTimer.current);
    setOpen(false); setQuery(''); setIndex(0);
  }, []);
  const isComposing = useCallback(() => inputComposing.current, []);
  const onCompositionStart = useCallback(() => { inputComposing.current = true; }, []);
  const onCompositionEnd = useCallback(() => {
    inputComposing.current = false;
    setNavigation(value => value + 1);
  }, []);
  const onInputKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229 || inputComposing.current) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    else if (event.key === 'Enter') { event.preventDefault(); navigate(event.shiftKey ? -1 : 1); }
  }, [close, navigate]);

  useEffect(() => {
    const previous = previousNavigation.current;
    previousNavigation.current = { mode, query, index, open: isOpen };
    const modeOnly = previous.mode !== mode && previous.query === query &&
      previous.index === index && previous.open === isOpen;
    if (modeOnly || !isOpen || composing || inputComposing.current || mode !== 'edit') return;
    const match = matches[sourceResult.activeIndex];
    if (match) source.current?.revealMatch(match);
  }, [mode, isOpen, query, index, matches, sourceResult, navigation, composing, source]);

  return {
    isOpen, query, index, navigation, count, activeIndex, matches, inputRef,
    expanded: query.trim().length > 0,
    open, close, navigate, changeQuery, reset, onDocumentResult, isComposing,
    onCompositionStart, onCompositionEnd, onInputKeyDown
  };
}

export type DocumentSearch = ReturnType<typeof useDocumentSearch>;
