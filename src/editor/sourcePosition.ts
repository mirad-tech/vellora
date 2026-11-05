import type { Editor, JSONContent } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { importMarkdown, type SourceLineRanges } from './markdownDocument';
import { documentMetadata } from './editorMetadata';

/** Return a visible caret or reading position, without changing the selection. */
export function visibleDocumentPosition(editor: Editor, viewport: HTMLElement): number | null {
  if (viewport.clientHeight <= 0) return null;
  const bounds = viewport.getBoundingClientRect();
  const body = editor.view.dom.getBoundingClientRect();
  try {
    // Clicking the mode control has already moved DOM focus out of the editor.
    const caret = editor.view.coordsAtPos(editor.state.selection.from);
    if (caret.top >= bounds.top && caret.bottom <= bounds.bottom) return editor.state.selection.from;
    const position = editor.view.posAtCoords({
      left: Math.max(bounds.left + 1, body.left + 32),
      top: Math.max(bounds.top + 12, body.top + 1),
    });
    if (position) return position.pos;
    for (const child of editor.view.dom.children) {
      if (child.getBoundingClientRect().bottom > bounds.top + 12) return editor.view.posAtDOM(child, 0);
    }
  } catch { /* A hidden/replaced view uses the caller's scroll-ratio fallback. */ }
  return null;
}

/** Build a temporary mapping only when entering source mode for the first time. */
export function sourceOffsetForPosition(doc: ProseMirrorNode, source: string, position: number): number | null {
  const ranges: SourceLineRanges = new WeakMap();
  const json = importMarkdown(source, ranges);
  const parsed = doc.type.schema.nodeFromJSON(json);
  let target = Math.max(0, Math.min(position, doc.content.size));
  if (!doc.eq(parsed)) {
    const previousHeading = documentMetadata(doc).headings.filter(heading => heading.pos <= target).at(-1);
    const matchingHeading = previousHeading && documentMetadata(parsed).headings.find(heading => heading.id === previousHeading.id);
    if (!matchingHeading) return null;
    target = matchingHeading.pos + 1;
  }
  const resolved = parsed.resolve(Math.min(target, parsed.content.size));
  const candidates: JSONContent[] = [];
  let node = json;
  for (let depth = 0; depth <= resolved.depth; depth++) {
    const child = node.content?.[resolved.index(depth)];
    if (!child) break;
    candidates.push(child);
    node = child;
  }
  const range = candidates.reverse().map(candidate => ranges.get(candidate)).find(Boolean);
  if (!range) return null;
  // Offsets refer to the original bytes' JS string positions, including CRLF/BOM.
  const offsets = [0];
  for (const newline of source.matchAll(/\r\n|\r|\n/g)) offsets.push(newline.index! + newline[0].length);
  return offsets[range.start] ?? source.length;
}
