import React, { useImperativeHandle, useLayoutEffect, useMemo, useRef, type Ref, type RefObject } from 'react';
import { documentLineEnding } from './markdownDocument';

export type SourceSearchMatch = { start: number; end: number };
type SourceSelection = { start: number; end: number };
export type SourceEditorHandle = {
  focus: () => void;
  getSelection: () => SourceSelection;
  restoreSelection: (selection: SourceSelection) => void;
  selectMatch: (match: SourceSearchMatch) => void;
  revealMatch: (match: SourceSearchMatch) => void;
  revealOffset: (offset: number) => void;
};
type Props = {
  ref?: Ref<SourceEditorHandle>;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  scroller: RefObject<HTMLElement | null>;
  matches: SourceSearchMatch[];
  activeIndex: number;
  searchOpen: boolean;
};

const TEXTAREA_MIRROR_PROPERTIES = [
  'box-sizing',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'border-top-style',
  'border-right-style',
  'border-bottom-style',
  'border-left-style',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'font-family',
  'font-size',
  'font-style',
  'font-variant',
  'font-weight',
  'letter-spacing',
  'line-height',
  'text-align',
  'text-indent',
  'text-transform',
  'word-spacing',
  'tab-size',
  'direction'
] as const;

function measureTextareaMatch(
  editor: HTMLTextAreaElement,
  match: SourceSearchMatch
): { top: number; height: number } | null {
  const view = editor.ownerDocument.defaultView;
  const body = editor.ownerDocument.body;
  if (!view || !body) return null;

  const computed = view.getComputedStyle(editor);
  const mirror = editor.ownerDocument.createElement('div');
  mirror.setAttribute('aria-hidden', 'true');
  for (const property of TEXTAREA_MIRROR_PROPERTIES) {
    mirror.style.setProperty(property, computed.getPropertyValue(property));
  }
  mirror.style.position = 'fixed';
  mirror.style.top = '0';
  mirror.style.left = '-10000px';
  mirror.style.width = computed.width;
  mirror.style.height = 'auto';
  mirror.style.minHeight = '0';
  mirror.style.maxHeight = 'none';
  mirror.style.overflow = 'hidden';
  mirror.style.visibility = 'hidden';
  mirror.style.pointerEvents = 'none';
  mirror.style.whiteSpace = editor.wrap === 'off' ? 'pre' : 'pre-wrap';
  mirror.style.overflowWrap = editor.wrap === 'off' ? 'normal' : 'break-word';
  mirror.style.wordBreak = computed.wordBreak;

  mirror.textContent = editor.value.slice(0, match.start);
  const marker = editor.ownerDocument.createElement('span');
  marker.textContent = editor.value.slice(match.start, match.end) || '\u200b';
  mirror.append(marker);
  body.append(mirror);

  try {
    const lineHeight = Number.parseFloat(computed.lineHeight);
    const fontSize = Number.parseFloat(computed.fontSize);
    const fallbackHeight = Number.isFinite(lineHeight)
      ? lineHeight
      : (Number.isFinite(fontSize) ? fontSize : 16) * 1.5;
    return {
      top: marker.offsetTop,
      height: Math.max(marker.offsetHeight, fallbackHeight)
    };
  } finally {
    mirror.remove();
  }
}

function selectSourceSearchMatch(
  editor: HTMLTextAreaElement,
  scroller: HTMLElement | null,
  match: SourceSearchMatch
): void {
  editor.setSelectionRange(match.start, match.end);
  if (!scroller || scroller.clientHeight <= 0) return;

  const metrics = measureTextareaMatch(editor, match);
  if (!metrics) return;

  const editorTop =
    editor.getBoundingClientRect().top -
    scroller.getBoundingClientRect().top +
    scroller.scrollTop;
  const matchTop = editorTop + metrics.top;
  const matchBottom = matchTop + metrics.height;
  const viewportTop = scroller.scrollTop;
  const viewportBottom = viewportTop + scroller.clientHeight;
  const viewportMargin = 24;

  if (
    matchTop < viewportTop + viewportMargin ||
    matchBottom > viewportBottom - viewportMargin
  ) {
    scroller.scrollTop = Math.max(
      0,
      matchTop - (scroller.clientHeight - metrics.height) / 2
    );
  }
}


export function SourceEditor({
  ref, value: draftContent, disabled: documentOpenPending, onChange: updateDraft,
  scroller, matches: sourceSearchMatches, activeIndex, searchOpen
}: Props) {
  const sourceEditorRef = useRef<HTMLTextAreaElement>(null);
  const sourceSearchLayerRef = useRef<HTMLDivElement>(null);
  const sourceEditInProgressRef = useRef(false);
  const lineEnding = useRef(documentLineEnding(draftContent));
  // Textarea selections use LF; search and document offsets refer to the unnormalized draft.
  const textareaContent = useMemo(() => draftContent.replace(/\r\n?/g, '\n'), [draftContent]);
  const textareaOffset = (offset: number) => draftContent.length === textareaContent.length
    ? offset : draftContent.slice(0, offset).replace(/\r\n/g, '\n').length;
  const sourceSearchHighlights = useMemo(() => {
    if (sourceSearchMatches.length === 0) return null;

    const content: React.ReactNode[] = [];
    let cursor = 0;
    sourceSearchMatches.forEach((match, index) => {
      if (match.start > cursor) {
        content.push(
          <span key={`source-text-${cursor}-${match.start}`}>
            {draftContent.slice(cursor, match.start)}
          </span>
        );
      }
      content.push(
        <mark
          key={`source-hit-${match.start}-${match.end}`}
          className="source-search-hit"
          data-source-search-hit={index}
        >
          {draftContent.slice(match.start, match.end)}
        </mark>
      );
      cursor = match.end;
    });
    if (cursor < draftContent.length) {
      content.push(
        <span key={`source-text-${cursor}-${draftContent.length}`}>
          {draftContent.slice(cursor)}
        </span>
      );
    }
    return content;
  }, [draftContent, sourceSearchMatches]);

  useLayoutEffect(() => {
    const layer = sourceSearchLayerRef.current;
    layer?.querySelector('[data-active-search]')?.removeAttribute('data-active-search');
    layer?.querySelector('[data-source-search-hit="' + activeIndex + '"]')?.setAttribute('data-active-search', 'true');
  }, [sourceSearchHighlights, activeIndex]);

  useImperativeHandle(ref, () => ({
    focus: () => sourceEditorRef.current?.focus({ preventScroll: true }),
    getSelection: () => ({
      start: sourceEditorRef.current?.selectionStart ?? 0,
      end: sourceEditorRef.current?.selectionEnd ?? 0
    }),
    restoreSelection: ({ start, end }) => sourceEditorRef.current?.setSelectionRange(start, end),
    selectMatch: match => sourceEditorRef.current?.setSelectionRange(textareaOffset(match.start), textareaOffset(match.end)),
    revealMatch: match => {
      const editor = sourceEditorRef.current;
      const editing = sourceEditInProgressRef.current && document.activeElement === editor;
      sourceEditInProgressRef.current = false;
      if (editor && !editing) selectSourceSearchMatch(editor, scroller.current, {
        start: textareaOffset(match.start), end: textareaOffset(match.end)
      });
    },
    revealOffset: offset => {
      const editor = sourceEditorRef.current;
      const viewport = scroller.current;
      if (!editor || !viewport) return;
      const start = textareaOffset(offset);
      editor.setSelectionRange(start, start);
      const metrics = measureTextareaMatch(editor, { start, end: start + 1 });
      if (metrics) viewport.scrollTop = Math.max(0,
        editor.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop + metrics.top - 24);
    }
  }), [scroller, draftContent, textareaContent]);

  return (
    <div className="source-editor-shell">
      {sourceSearchHighlights ? (
        <div
          className="source-search-layer"
          ref={sourceSearchLayerRef}
          data-testid="source-search-highlight-layer"
          aria-hidden="true"
        >
          {sourceSearchHighlights}
        </div>
      ) : null}
      <textarea
        className={
          sourceSearchHighlights
            ? 'source-editor source-editor--searching'
            : 'source-editor'
        }
        data-testid="source-editor"
        ref={sourceEditorRef}
        value={textareaContent}
        disabled={documentOpenPending}
        spellCheck={false}
        aria-label="Markdown 源码"
        onChange={(e) => {
          sourceEditInProgressRef.current = searchOpen;
          const value = e.target.value;
          updateDraft(lineEnding.current === '\r\n' ? value.replace(/\n/g, '\r\n') : value);
        }}
      />
    </div>
  );
}
