import type { JSONContent } from '@tiptap/core';
import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';

const parser = new MarkdownIt({ html: true, linkify: false, typographer: false });

export type SourceLineRange = { start: number; end: number };
export type SourceLineRanges = WeakMap<JSONContent, SourceLineRange>;

function imageAltText(tokens: Token[]): string {
  return tokens.map(token => {
    if (['text', 'text_special', 'code_inline'].includes(token.type)) return token.content;
    if (token.type === 'softbreak' || token.type === 'hardbreak') return '\n';
    if (token.type === 'image') return imageAltText(token.children ?? []);
    if (/^(strong|em|s|link)_(open|close)$/.test(token.type)) return '';
    // The caller preserves the whole construct as source if a token is unknown.
    throw new Error('Unsupported image alt token: ' + token.type);
  }).join('');
}

function inlineContent(tokens: Token[]): JSONContent[] {
  const marks: NonNullable<JSONContent['marks']> = [];
  const result: JSONContent[] = [];
  const markNames: Record<string, string> = { strong: 'bold', em: 'italic', s: 'strike', link: 'link' };
  for (const token of tokens) {
    const base = token.type.replace(/_(open|close)$/, '');
    if (token.nesting === 1 && markNames[base]) {
      marks.push({ type: markNames[base], ...(base === 'link' ? { attrs: {
        href: token.attrGet('href') ?? '', title: token.attrGet('title')
      } } : {}) });
    } else if (token.nesting === -1 && markNames[base]) {
      marks.pop();
    } else if (token.type === 'text' || token.type === 'code_inline') {
      if (token.content) result.push({ type: 'text', text: token.content, marks: [
        ...marks, ...(token.type === 'code_inline' ? [{ type: 'code' }] : [])
      ] });
    } else if (token.type === 'softbreak') {
      result.push({ type: 'text', text: '\n', marks: [...marks] });
    } else if (token.type === 'hardbreak') {
      result.push({ type: 'hardBreak' });
    } else if (token.type === 'html_inline' && /^<br\s*\/?\s*>$/i.test(token.content)) {
      result.push({ type: 'hardBreak' });
    } else if (token.type === 'image') {
      result.push({ type: 'image', attrs: {
        src: token.attrGet('src') ?? '',
        alt: imageAltText(token.children ?? []),
        title: token.attrGet('title')
      }, marks: [...marks] });
    } else {
      throw new Error(`Unsupported inline token: ${token.type}`);
    }
  }
  return result;
}

function convertTokens(tokens: Token[], ranges?: SourceLineRanges): JSONContent[] {
  const root: JSONContent = { type: 'doc', content: [] };
  const stack = [root];
  const nodeNames: Record<string, string> = {
    paragraph_open: 'paragraph', heading_open: 'heading', blockquote_open: 'blockquote',
    bullet_list_open: 'bulletList', ordered_list_open: 'orderedList', list_item_open: 'listItem',
    table_open: 'table', tr_open: 'tableRow', th_open: 'tableHeader', td_open: 'tableCell'
  };
  for (const token of tokens) {
    if (/^(thead|tbody)_(open|close)$/.test(token.type)) continue;
    const parent = stack[stack.length - 1];
    if (token.nesting === -1) {
      // Markdown permits empty containers and list items that begin with a
      // nested block. ProseMirror requires a block, and a leading paragraph in
      // each list item, respectively.
      if ((parent.type === 'blockquote' && !parent.content?.length) ||
        (parent.type === 'listItem' && parent.content?.[0]?.type !== 'paragraph')) {
        parent.content!.unshift({ type: 'paragraph' });
      }
      stack.pop();
      continue;
    }
    if (nodeNames[token.type]) {
      const node: JSONContent = { type: nodeNames[token.type], content: [] };
      if (token.map) ranges?.set(node, { start: token.map[0], end: token.map[1] });
      if (token.type === 'heading_open') node.attrs = { level: Number(token.tag.slice(1)) };
      if (token.type === 'ordered_list_open') {
        node.attrs = {
          start: Number(token.attrGet('start') ?? 1),
          markdownDelimiter: token.markup === ')' ? ')' : '.',
        };
      }
      if (token.type === 'th_open' || token.type === 'td_open') {
        node.attrs = { align: token.attrGet('style')?.match(/text-align:(\w+)/)?.[1] ?? null };
      }
      parent.content!.push(node);
      stack.push(node);
    } else if (token.type === 'inline') {
      const content = token.content === '&nbsp;' ? [] : inlineContent(token.children ?? []);
      if (parent.type === 'tableCell' || parent.type === 'tableHeader') {
        parent.content!.push({ type: 'paragraph', content });
      } else parent.content!.push(...content);
    } else if (token.type === 'fence' || token.type === 'code_block') {
      // markdown-it includes one structural newline after the code body.
      const text = token.content.replace(/\n$/, '');
      const node = { type: 'codeBlock', attrs: { language: token.info.trim() || null },
        content: text ? [{ type: 'text', text }] : [] };
      if (token.map) ranges?.set(node, { start: token.map[0], end: token.map[1] });
      parent.content!.push(node);
    } else if (token.type === 'hr') {
      const node = { type: 'horizontalRule' };
      if (token.map) ranges?.set(node, { start: token.map[0], end: token.map[1] });
      parent.content!.push(node);
    } else throw new Error(`Unsupported block token: ${token.type}`);
  }
  return root.content!;
}

export function rawSourceNode(source: string): JSONContent {
  return { type: 'rawSource', content: source ? [{ type: 'text', text: source }] : [] };
}

function dependsOnReferences(token: Token): boolean {
  if (token.type !== 'inline' || !token.children?.some(child => child.type === 'link_open' || child.type === 'image')) return false;
  // The parser resolves full, collapsed and shortcut references identically.
  // Reparse without definitions to distinguish them from inline links/images,
  // including references nested inside image alt text, without guessing syntax.
  const independent = parser.parseInline(token.content, {})[0].children;
  return JSON.stringify(token.children) !== JSON.stringify(independent);
}

/** Import from the existing Markdown grammar, before any HTML sanitization.
 * A top-level construct that cannot be represented is retained as editable source.
 * Unemitted source (e.g. reference definitions) is retained too.
 */
export function importMarkdown(source: string, ranges?: SourceLineRanges): JSONContent {
  const normalized = source.replace(/\r\n|\r/g, '\n');
  const lines = normalized.split('\n');
  const frontmatterEnd = /^\uFEFF?---[ \t]*$/.test(lines[0])
    ? lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)[ \t]*$/.test(line)) + 1
    : 0;
  // Mask the header so token maps keep their original line offsets. Its source
  // must not become a horizontal rule / setext heading when the body is edited.
  const body = frontmatterEnd ? lines.map((line, index) => index < frontmatterEnd ? '' : line).join('\n') : normalized;
  const env: { references?: Record<string, unknown> } = {};
  const tokens = parser.parse(body, env);
  const sourceNode = (start: number, end: number) => {
    const node = rawSourceNode(lines.slice(start, end).join('\n'));
    ranges?.set(node, { start, end });
    return node;
  };
  const content: JSONContent[] = frontmatterEnd ? [sourceNode(0, frontmatterEnd)] : [];
  let cursor = frontmatterEnd;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.map || token.level !== 0) continue;
    const [start, end] = token.map;
    const gap = lines.slice(cursor, start).join('\n');
    if (gap.trim()) content.push(sourceNode(cursor, start));
    let last = index;
    if (token.nesting === 1) {
      while (last + 1 < tokens.length) {
        last += 1;
        if (tokens[last].level === 0 && tokens[last].nesting === -1) break;
      }
    }
    const block = tokens.slice(index, last + 1);
    const hasTasks = block.some((part, offset) => part.type === 'list_item_open' &&
      block[offset + 1]?.type === 'paragraph_open' && block[offset + 2]?.type === 'inline' &&
      /^\[[ xX]\](?:[ \t]|$)/.test(block[offset + 2].content));
    try {
      if (hasTasks || (env.references && block.some(dependsOnReferences))) content.push(sourceNode(start, end));
      else content.push(...convertTokens(block, ranges));
    }
    catch { content.push(sourceNode(start, end)); }
    cursor = end;
    index = last;
  }
  const remainder = lines.slice(cursor).join('\n');
  if (remainder.trim()) content.push(sourceNode(cursor, lines.length));
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

export function documentLineEnding(source: string): '\r\n' | '\n' {
  const index = source.indexOf('\n');
  return index > 0 && source[index - 1] === '\r' ? '\r\n' : '\n';
}
