import type { MarkdownEditableBlockKind } from './renderMarkdown';

function isContainerFormattingWhitespace(node: Node): boolean {
  const parent = node.parentElement;
  return (
    node.nodeType === Node.TEXT_NODE &&
    (parent?.tagName === 'BLOCKQUOTE' || parent?.tagName === 'LI') &&
    /^\s*$/.test(node.textContent ?? '')
  );
}

function hasMeaningfulPreviousSibling(node: Node): boolean {
  let sibling = node.previousSibling;
  while (sibling) {
    if (!isContainerFormattingWhitespace(sibling)) return true;
    sibling = sibling.previousSibling;
  }
  return false;
}

function serializeChildren(node: Node): string {
  let previousWasBreak = false;
  return Array.from(node.childNodes, (child) => {
    if (isContainerFormattingWhitespace(child)) return '';
    let serialized = serializeNode(child);
    if (previousWasBreak && child.nodeType === Node.TEXT_NODE) {
      serialized = serialized.replace(/^\n/, '');
    }
    previousWasBreak = child instanceof HTMLElement && child.tagName === 'BR';
    return serialized;
  }).join('');
}

function serializeCode(text: string): string {
  const longestFence = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  const fence = '`'.repeat(longestFence + 1);
  const needsPadding = text.startsWith('`') || text.endsWith('`');
  const padding = needsPadding ? ' ' : '';
  return `${fence}${padding}${text}${padding}${fence}`;
}

function serializeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent ?? '').replace(/\u00a0/g, ' ');
  }
  if (!(node instanceof HTMLElement)) return '';

  const children = () => serializeChildren(node);
  switch (node.tagName) {
    case 'BR':
      return '\n';
    case 'STRONG':
    case 'B':
      return `**${children()}**`;
    case 'EM':
    case 'I':
      return `*${children()}*`;
    case 'DEL':
    case 'S':
      return `~~${children()}~~`;
    case 'CODE':
      return serializeCode(node.textContent ?? '');
    case 'A': {
      const href = node.getAttribute('data-md-href') ?? node.getAttribute('href') ?? '';
      const title = node.getAttribute('title');
      const escapedHref = href.replace(/([\\()])/g, '\\$1');
      return `[${children()}](${escapedHref}${title ? ` "${title.replace(/"/g, '\\"')}"` : ''})`;
    }
    case 'DIV':
    case 'P': {
      const prefix = hasMeaningfulPreviousSibling(node) ? '\n' : '';
      return `${prefix}${children()}`;
    }
    default:
      return children();
  }
}

export function serializeEditableBlock(element: HTMLElement): string {
  return serializeChildren(element).replace(/\n+$/g, '');
}

function normalizeLineEndings(value: string, lineEnding: '\r\n' | '\n'): string {
  return value.replace(/\r\n|\r|\n/g, lineEnding);
}

function rebuildHeading(originalSource: string, edited: string): string {
  const match = originalSource.match(/^([ \t]{0,3}#{1,6}[ \t]+)([\s\S]*?)([ \t]+#+[ \t]*)?$/);
  if (!match) return originalSource;
  return `${match[1]}${edited.replace(/\r\n|\r|\n/g, ' ')}${match[3] ?? ''}`;
}

function rebuildListItem(
  originalSource: string,
  edited: string,
  lineEnding: '\r\n' | '\n'
): string {
  const normalizedSource = originalSource.replace(/\r\n|\r/g, '\n');
  const match = normalizedSource.match(/^([ \t]*(?:[-+*]|\d+[.)])[ \t]+)([\s\S]*)$/);
  if (!match) return originalSource;

  const originalLines = normalizedSource.split('\n');
  const continuationPrefixes = originalLines.slice(1).map((line) => line.match(/^[ \t]*/)?.[0] ?? '');
  const fallbackIndent = ' '.repeat(match[1].replace(/\t/g, '    ').length);
  const editedLines = edited.replace(/\r\n|\r/g, '\n').split('\n');
  const rebuilt = editedLines.map((line, index) => {
    if (index === 0) return `${match[1]}${line}`;
    if (line.length === 0) return '';
    return `${continuationPrefixes[index - 1] || fallbackIndent}${line}`;
  });
  return rebuilt.join(lineEnding);
}

function rebuildBlockquote(
  originalSource: string,
  edited: string,
  lineEnding: '\r\n' | '\n'
): string {
  const originalLines = originalSource.replace(/\r\n|\r/g, '\n').split('\n');
  const prefixes = originalLines.map((line) => line.match(/^[ \t]*>[ \t]?/)?.[0] ?? '> ');
  const fallbackPrefix = prefixes[0] || '> ';
  return edited
    .replace(/\r\n|\r/g, '\n')
    .split('\n')
    .map((line, index) => `${prefixes[index] || fallbackPrefix}${line}`)
    .join(lineEnding);
}

export function rebuildEditableBlockSource(
  kind: MarkdownEditableBlockKind,
  originalSource: string,
  editedMarkdown: string,
  lineEnding: '\r\n' | '\n'
): string {
  switch (kind) {
    case 'heading':
      return rebuildHeading(originalSource, editedMarkdown);
    case 'list-item':
      return rebuildListItem(originalSource, editedMarkdown, lineEnding);
    case 'blockquote':
      return rebuildBlockquote(originalSource, editedMarkdown, lineEnding);
    case 'paragraph':
      return normalizeLineEndings(editedMarkdown, lineEnding);
  }
}

export function isEditableBlockRoundTripSafe(
  kind: MarkdownEditableBlockKind,
  originalSource: string,
  element: HTMLElement,
  lineEnding: '\r\n' | '\n'
): boolean {
  return (
    rebuildEditableBlockSource(kind, originalSource, serializeEditableBlock(element), lineEnding) ===
    originalSource
  );
}
