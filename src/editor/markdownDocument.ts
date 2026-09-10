import type { JSONContent } from '@tiptap/core';
import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';

const parser = new MarkdownIt({ html: true, linkify: false, typographer: false });

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

function convertTokens(tokens: Token[]): JSONContent[] {
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
    if (token.nesting === -1) { stack.pop(); continue; }
    if (nodeNames[token.type]) {
      const node: JSONContent = { type: nodeNames[token.type], content: [] };
      if (token.type === 'heading_open') node.attrs = { level: Number(token.tag.slice(1)) };
      if (token.type === 'ordered_list_open') node.attrs = { start: Number(token.attrGet('start') ?? 1) };
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
      parent.content!.push({ type: 'codeBlock', attrs: { language: token.info.trim() || null },
        content: text ? [{ type: 'text', text }] : [] });
    } else if (token.type === 'hr') {
      parent.content!.push({ type: 'horizontalRule' });
    } else throw new Error(`Unsupported block token: ${token.type}`);
  }
  return root.content!;
}

export function rawSourceNode(source: string): JSONContent {
  return { type: 'rawSource', content: source ? [{ type: 'text', text: source }] : [] };
}

/** Import from the existing Markdown grammar, before any HTML sanitization.
 * A top-level construct that cannot be represented is retained as editable source.
 * Unemitted source (e.g. reference definitions) is retained too.
 */
export function importMarkdown(source: string): JSONContent {
  const normalized = source.replace(/\r\n|\r/g, '\n');
  const lines = normalized.split('\n');
  const tokens = parser.parse(normalized, {});
  const content: JSONContent[] = [];
  let cursor = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.map || token.level !== 0) continue;
    const [start, end] = token.map;
    const gap = lines.slice(cursor, start).join('\n');
    if (gap.trim()) content.push(rawSourceNode(gap));
    let last = index;
    if (token.nesting === 1) {
      while (last + 1 < tokens.length) {
        last += 1;
        if (tokens[last].level === 0 && tokens[last].nesting === -1) break;
      }
    }
    try { content.push(...convertTokens(tokens.slice(index, last + 1))); }
    catch { content.push(rawSourceNode(lines.slice(start, end).join('\n'))); }
    cursor = end;
    index = last;
  }
  const remainder = lines.slice(cursor).join('\n');
  if (remainder.trim()) content.push(rawSourceNode(remainder));
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

export function documentLineEnding(source: string): '\r\n' | '\n' {
  const index = source.indexOf('\n');
  return index > 0 && source[index - 1] === '\r' ? '\r\n' : '\n';
}

export function headingId(text: string, seen: Map<string, number>): string {
  const slug = text.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]+/gu, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const base = `heading-${slug || 'heading'}`;
  const count = (seen.get(base) ?? 0) + 1;
  seen.set(base, count);
  return count === 1 ? base : `${base}-${count}`;
}
