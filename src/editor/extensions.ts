import { Extension, Node, type Extensions, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import CodeBlock from '@tiptap/extension-code-block';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import Paragraph from '@tiptap/extension-paragraph';
import Code from '@tiptap/extension-code';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import { Markdown } from '@tiptap/markdown';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import hljs from 'highlight.js/lib/core';
import { headingId } from './markdownDocument';

export const RawSource = Node.create({
  name: 'rawSource', group: 'block', content: 'text*', marks: '', code: true, defining: true,
  parseHTML: () => [],
  renderHTML: () => ['pre', { class: 'raw-source' }, ['code', 0]],
  renderMarkdown: node => (node.content ?? []).map(child => child.text ?? '').join(''),
});

const SafeParagraph = Paragraph.extend({
  renderMarkdown: (node, helpers, context) => {
    // The table renderer adds its own pipe-escaping layer after rendering a cell.
    // Block syntax has no meaning inside a cell and must not be escaped twice.
    if (context.parentType === 'table') return helpers.renderChildren(node.content ?? []);
    if (!node.content?.length) return '&nbsp;';
    // The upstream serializer escapes inline marks but not block syntax.
    return helpers.renderChildren(node.content).replace(/^([ \t]{0,3})([#>+=|:-]|\d+[.)])/gm,
      (_match: string, indent: string, marker: string) => `${indent}${marker.length === 1 ? `\\${marker}` : `${marker.slice(0, -1)}\\${marker.slice(-1)}`}`)
      .replace(/^[ \t]+/gm, whitespace => whitespace.replace(/ /g, '&#32;').replace(/\t/g, '&#9;'));
  },
});

// This node is used only by the export adapter. A code mark's delimiters cannot
// depend on its text in Tiptap's placeholder-based mark serializer.
const SerializedCode = Node.create({
  name: 'serializedCode', group: 'inline', inline: true, content: 'text*', code: true,
  parseHTML: () => [], renderHTML: () => ['code', 0],
  renderMarkdown: node => {
    const text = (node.content ?? []).map(child => child.text ?? '').join('');
    const runs = text.match(/`+/g) ?? [];
    const fence = '`'.repeat(Math.max(1, ...runs.map(run => run.length + 1)));
    const padding = text.startsWith('`') || text.endsWith('`') || /^ .+ $/.test(text) ? ' ' : '';
    return wrapInlineMarks(`${fence}${padding}${text}${padding}${fence}`, node.marks);
  },
});

function destination(value: unknown): string {
  return String(value ?? '').replace(/([\\()])/g, '\\$1').replace(/\s/g, character => encodeURIComponent(character));
}

function linkMarkdown(text: string, attrs: Record<string, unknown> | undefined): string {
  const title = attrs?.title ? ` "${String(attrs.title).replace(/([\\"])/g, '\\$1')}"` : '';
  return `[${text}](${destination(attrs?.href)}${title})`;
}

function wrapInlineMarks(text: string, marks: JSONContent['marks']): string {
  return (marks ?? []).reduceRight((value, mark) => {
    if (mark.type === 'link') return linkMarkdown(value, mark.attrs);
    const delimiter = { bold: '**', italic: '*', strike: '~~' }[mark.type];
    return delimiter ? `${delimiter}${value}${delimiter}` : value;
  }, text);
}

export const SafeCodeBlock = CodeBlock.extend({
  renderMarkdown: node => {
    const text = (node.content ?? []).map(child => child.text ?? '').join('');
    const language = String(node.attrs?.language ?? '').replace(/[\r\n]/g, ' ');
    const char = language.includes('`') ? '~' : '`';
    const runs = text.match(char === '`' ? /`+/g : /~+/g) ?? [];
    const fence = char.repeat(Math.max(3, ...runs.map(run => run.length + 1)));
    return `${fence}${language}\n${text}${text ? '\n' : ''}${fence}`;
  },
}).configure({ enableTabIndentation: true, tabSize: 2, exitOnTripleEnter: false });

export const SafeLink = Link.extend({
  renderMarkdown: (node, helpers) => linkMarkdown(helpers.renderChildren(node), node.attrs),
  addAttributes() {
    return { ...this.parent?.(), title: { default: null } };
  },
  renderHTML: ({ HTMLAttributes }) => ['a', {
    'data-md-href': HTMLAttributes.href, href: '#', title: HTMLAttributes.title,
    rel: 'noreferrer'
  }, 0],
}).configure({ openOnClick: false, autolink: false, linkOnPaste: false });

export const LocalImage = Image.extend({
  renderMarkdown: node => {
    const alt = String(node.attrs?.alt ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/([\\`*_[\]~])/g, '\\$1');
    return wrapInlineMarks(`!${linkMarkdown(alt, { href: node.attrs?.src, title: node.attrs?.title })}`, node.marks);
  },
  renderHTML: ({ node }) => ['img', { 'data-local-src': node.attrs.src,
    alt: node.attrs.alt ?? '', title: node.attrs.title ?? '' }],
}).configure({ inline: true, allowBase64: false });

const SafeTable = Table.extend({
  renderMarkdown: (node, helpers) => {
    const rows = (node.content ?? []).map(row => (row.content ?? []).map(cell => ({
      header: cell.type === 'tableHeader',
      align: cell.attrs?.align,
      // Preserve code whitespace. Only structural line breaks become <br>.
      // markdown-it removes exactly one backslash before each cell-content pipe.
      text: helpers.renderChildren(cell.content ?? [])
        .replace(/ {2}\n/g, '<br>').replace(/\r?\n/g, '<br>').replace(/\|/g, '\\|'),
    })));
    const columns = Math.max(0, ...rows.map(row => row.length));
    if (!columns) return '';
    const hasHeader = rows[0].some(cell => cell.header);
    const line = (values: string[]) => '| ' + values.join(' | ') + ' |';
    const values = (row: typeof rows[number]) => Array.from({ length: columns }, (_, index) => row[index]?.text ?? '');
    const separators = Array.from({ length: columns }, (_, index) => {
      const align = rows.find(row => row[index]?.align)?.[index].align;
      return align === 'left' ? ':---' : align === 'center' ? ':---:' : align === 'right' ? '---:' : '---';
    });
    return '\n' + [
      line(hasHeader ? values(rows[0]) : Array<string>(columns).fill('')),
      line(separators),
      ...(hasHeader ? rows.slice(1) : rows).map(row => line(values(row))),
    ].join('\n') + '\n';
  },
});

export type SearchState = { query: string; activeIndex: number };
export const searchKey = new PluginKey<SearchState>('documentSearch');

export function findDocumentMatches(doc: ProseMirrorNode, query: string): Array<{ from: number; to: number }> {
  if (!query.trim()) return [];
  const pattern = new RegExp(query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  const matches: Array<{ from: number; to: number }> = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return;
    // A placeholder retains positions occupied by inline images/hard breaks.
    const text = node.textBetween(0, node.content.size, '', '\ufffc');
    for (const match of text.matchAll(pattern)) {
      matches.push({ from: pos + 1 + match.index!, to: pos + 1 + match.index! + match[0].length });
    }
    return false;
  });
  return matches;
}

const DocumentDecorations = Extension.create({
  name: 'documentDecorations',
  addProseMirrorPlugins() {
    return [new Plugin<SearchState>({
      key: searchKey,
      state: {
        init: () => ({ query: '', activeIndex: 0 }),
        apply: (tr, value) => tr.getMeta(searchKey) ?? value,
      },
      props: {
        decorations(state) {
          const decorations: Decoration[] = [];
          const seen = new Map<string, number>();
          state.doc.descendants((node, pos) => {
            if (node.type.name === 'heading') {
              const id = headingId(node.textContent, seen);
              decorations.push(Decoration.node(pos, pos + node.nodeSize, { id, 'data-heading-id': id }));
            }
            if (node.type.name === 'codeBlock') {
              const language = String(node.attrs.language ?? '').split(/\s+/)[0];
              if (!hljs.getLanguage(language)) return false;
              const template = document.createElement('template');
              template.innerHTML = hljs.highlight(node.textContent, { language, ignoreIllegals: true }).value;
              let offset = pos + 1;
              const walk = (parent: globalThis.Node, classes: string[]) => {
                for (const child of Array.from(parent.childNodes)) {
                  if (child.nodeType === globalThis.Node.TEXT_NODE) {
                    const end = offset + (child.textContent?.length ?? 0);
                    if (end > offset && classes.length) decorations.push(Decoration.inline(offset, end, { class: classes.join(' ') }));
                    offset = end;
                  } else if (child instanceof HTMLElement) walk(child, [...classes, ...child.classList]);
                }
              };
              walk(template.content, []);
              return false;
            }
          });
          const search = searchKey.getState(state)!;
          const matches = findDocumentMatches(state.doc, search.query);
          const active = matches.length ? Math.max(0, search.activeIndex) % matches.length : -1;
          matches.forEach((match, index) => decorations.push(Decoration.inline(match.from, match.to, {
            class: 'search-hit', 'data-search-hit': String(index),
            ...(index === active ? { 'data-active-search': 'true' } : {}),
          }, { inclusiveStart: false, inclusiveEnd: false })));
          return DecorationSet.create(state.doc, decorations);
        },
      },
    })];
  },
});

export function editorExtensions(overrides: { rawSource?: typeof RawSource; image?: typeof LocalImage } = {}): Extensions {
  return [
    StarterKit.configure({ code: false, paragraph: false, codeBlock: false, link: false, underline: false, trailingNode: false }),
    Code.extend({ excludes: '' }), SerializedCode,
    SafeParagraph, SafeCodeBlock, SafeLink, overrides.image ?? LocalImage, overrides.rawSource ?? RawSource,
    SafeTable.configure({ resizable: false }), TableRow,
    TableCell.extend({ content: 'paragraph' }), TableHeader.extend({ content: 'paragraph' }),
    Markdown.configure({ indentation: { style: 'space', size: 2 } }), DocumentDecorations,
  ];
}
