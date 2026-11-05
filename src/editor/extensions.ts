import {
  Extension, Node, getExtensionField, renderNestedMarkdownContent,
  type ExtendableConfig, type Extensions, type JSONContent,
} from '@tiptap/core';
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
import { documentMetadata } from './editorMetadata';

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

// Export-only adapter: let the existing text serializer handle a complete run's
// marks, then restore literal code/image syntax before the enclosing block (or
// table cell) is serialized. Placeholders never enter the editor document.
const SerializedInline = Node.create({
  name: 'serializedInline', group: 'inline', inline: true, content: 'inline*',
  parseHTML: () => [], renderHTML: () => ['span', 0],
  renderMarkdown: (node, helpers) => {
    const renderChild = helpers.renderChild;
    if (!renderChild) throw new Error('Inline Markdown renderer is unavailable');
    const content = node.content ?? [];
    let prefix = '\ue000';
    const source = JSON.stringify(content);
    while (source.includes(prefix)) prefix += '\ue000';
    const replacements: string[] = [];
    const text = helpers.renderChildren(content.map((child, index) => {
      if (child.type !== 'serializedCode' && child.type !== 'image') return child;
      const placeholder = `${prefix}${replacements.length}\ue001`;
      replacements.push(renderChild({ ...child, marks: [] }, index));
      return { type: 'text', text: placeholder, marks: child.marks };
    }));
    return text.replace(new RegExp(`${prefix}(\\d+)\ue001`, 'g'), (_match, index: string) => replacements[Number(index)]);
  },
});

function destination(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/([\\()])/g, '\\$1').replace(/\s/g, character => encodeURIComponent(character));
}

function linkMarkdown(text: string, attrs: Record<string, unknown> | undefined): string {
  const title = attrs?.title ? ` "${String(attrs.title).replace(/&/g, '&amp;').replace(/([\\"])/g, '\\$1')}"` : '';
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
    let length = 3;
    for (const run of text.matchAll(char === '`' ? /`+/g : /~+/g)) {
      length = Math.max(length, run[0].length + 1);
    }
    const fence = char.repeat(length);
    const separator = language.startsWith(char) ? ' ' : '';
    return `${fence}${separator}${language}\n${text}${text ? '\n' : ''}${fence}`;
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
  addProseMirrorPlugins() {
    return [...(this.parent?.() ?? []), new Plugin({
      appendTransaction(transactions, _oldState, state) {
        if (!transactions.some(transaction => transaction.docChanged)) return null;
        const tr = state.tr;
        state.doc.descendants((table, tablePos) => {
          if (table.type.name !== 'table' || !table.firstChild) return;
          const header = table.firstChild;
          table.forEach((row, rowOffset) => row.forEach((cell, cellOffset, column) => {
            const align = header.maybeChild(column)?.attrs.align;
            if (align && !cell.attrs.align) {
              tr.setNodeMarkup(tablePos + rowOffset + cellOffset + 2, undefined, { ...cell.attrs, align });
            }
          }));
          return false;
        });
        return tr.docChanged ? tr : null;
      },
    })];
  },
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

export type SearchState = {
  query: string; activeIndex: number;
  syntax: DecorationSet; decorations: DecorationSet; active: Decoration[];
};
export const searchKey = new PluginKey<SearchState>('documentSearch');
type Match = { from: number; to: number };
const matchCache = new WeakMap<ProseMirrorNode, { query: string; matches: Match[] }>();
const maxSearchHighlights = 1000;

export function findDocumentMatches(doc: ProseMirrorNode, query: string): Match[] {
  const normalized = query.trim();
  const cached = matchCache.get(doc);
  if (cached?.query === normalized) return cached.matches;
  const matches: Match[] = [];
  if (normalized && doc.isTextblock) {
    const pattern = new RegExp(normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
    // A placeholder retains positions occupied by inline images/hard breaks.
    const text = doc.textBetween(0, doc.content.size, '', '\ufffc');
    for (const match of text.matchAll(pattern)) {
      matches.push({ from: 1 + match.index!, to: 1 + match.index! + match[0].length });
    }
  } else if (normalized && !doc.isText) {
    doc.forEach((child, offset) => {
      const start = offset + (doc.type.name === 'doc' ? 0 : 1);
      for (const match of findDocumentMatches(child, normalized)) {
        matches.push({ from: start + match.from, to: start + match.to });
      }
    });
  }
  matchCache.set(doc, { query: normalized, matches });
  return matches;
}

type CodeSpan = { from: number; to: number; className: string };
const codeCache = new WeakMap<ProseMirrorNode, CodeSpan[]>();
function codeDecorations(node: ProseMirrorNode, pos: number): Decoration[] {
  let spans = codeCache.get(node);
  if (!spans) {
    spans = [];
    const language = String(node.attrs.language ?? '').split(/\s+/)[0];
    if (hljs.getLanguage(language)) {
      const template = document.createElement('template');
      template.innerHTML = hljs.highlight(node.textContent, { language, ignoreIllegals: true }).value;
      let offset = 1;
      const walk = (parent: globalThis.Node, classes: string[]) => {
        for (const child of Array.from(parent.childNodes)) {
          if (child.nodeType === globalThis.Node.TEXT_NODE) {
            const end = offset + (child.textContent?.length ?? 0);
            if (end > offset && classes.length) spans!.push({ from: offset, to: end, className: classes.join(' ') });
            offset = end;
          } else if (child instanceof HTMLElement) walk(child, [...classes, ...child.classList]);
        }
      };
      walk(template.content, []);
    }
    codeCache.set(node, spans);
  }
  return spans.map(span => Decoration.inline(pos + span.from, pos + span.to, { class: span.className }, { kind: 'code' }));
}

function headingDecorations(doc: ProseMirrorNode): Decoration[] {
  return documentMetadata(doc).headings.filter(heading => heading.source === 'node').map(heading =>
    Decoration.node(heading.pos, heading.pos + heading.size, { id: heading.id, 'data-heading-id': heading.id }, { kind: 'heading' }));
}

function activeDecoration(doc: ProseMirrorNode, query: string, index: number): Decoration[] {
  const matches = findDocumentMatches(doc, query);
  const activeIndex = matches.length ? Math.max(0, index) % matches.length : -1;
  const match = matches[activeIndex];
  if (!match) return [];
  const decorations = [Decoration.inline(match.from, match.to, {
    'data-active-search': 'true',
    // Matches outside the ordinary highlight budget still need a visible,
    // navigable current hit. Removing active decorations removes this one too.
    ...(activeIndex >= maxSearchHighlights ? { class: 'search-hit', 'data-search-hit': String(activeIndex) } : {}),
  }, { kind: 'active' })];
  const start = doc.resolve(match.from);
  if (start.parent.type.name === 'rawSource') {
    decorations.push(Decoration.node(start.before(), start.after(), { 'data-search-reveal': 'true' }, { kind: 'active' }));
  }
  return decorations;
}

const DocumentDecorations = Extension.create({
  name: 'documentDecorations',
  addProseMirrorPlugins() {
    return [new Plugin<SearchState>({
      key: searchKey,
      state: {
        init: (_config, state) => {
          const decorations = headingDecorations(state.doc);
          state.doc.descendants((node, pos) => {
            if (node.type.name === 'codeBlock') decorations.push(...codeDecorations(node, pos));
            return !node.isTextblock;
          });
          const syntax = DecorationSet.create(state.doc, decorations);
          return { query: '', activeIndex: 0, syntax, decorations: syntax, active: [] };
        },
        apply: (tr, value, oldState) => {
          const { query, activeIndex } = (tr.getMeta(searchKey) ?? value) as { query: string; activeIndex: number };
          if (!tr.docChanged && query === value.query && activeIndex === value.activeIndex) return value;
          if (!tr.docChanged && query === value.query) {
            const active = activeDecoration(tr.doc, query, activeIndex);
            // ProseMirror consumes these arrays while constructing its tree.
            // Keep the saved active decorations intact for the next navigation.
            return { ...value, activeIndex, active, decorations: value.decorations.remove([...value.active]).add(tr.doc, [...active]) };
          }
          let syntax = value.syntax.map(tr.mapping, tr.doc);
          if (tr.docChanged) {
            const changedCode = new Map<number, ProseMirrorNode>();
            tr.mapping.maps.forEach((map, index) => map.forEach((_oldFrom, _oldTo, from, to) => {
              const rest = tr.mapping.slice(index + 1);
              const start = Math.max(0, rest.map(from, -1) - 1);
              const end = Math.min(tr.doc.content.size, rest.map(to, 1) + 1);
              tr.doc.nodesBetween(start, end, (node, pos) => {
                if (node.type.name === 'codeBlock') changedCode.set(pos, node);
                return !node.isTextblock;
              });
            }));
            changedCode.forEach((node, pos) => {
              syntax = syntax.remove(syntax.find(pos, pos + node.nodeSize, spec => spec.kind === 'code'));
              syntax = syntax.add(tr.doc, codeDecorations(node, pos));
            });
            const before = documentMetadata(oldState.doc).headings.filter(heading => heading.source === 'node');
            const after = documentMetadata(tr.doc).headings.filter(heading => heading.source === 'node');
            if (syntax.find(undefined, undefined, spec => spec.kind === 'heading').length !== after.length ||
              before.length !== after.length || after.some((heading, index) =>
              heading.id !== before[index].id || heading.level !== before[index].level || heading.size !== before[index].size)) {
              syntax = syntax.remove(syntax.find(undefined, undefined, spec => spec.kind === 'heading'));
              syntax = syntax.add(tr.doc, headingDecorations(tr.doc));
            }
          }
          const hits = findDocumentMatches(tr.doc, query).slice(0, maxSearchHighlights).map((match, index) => Decoration.inline(match.from, match.to, {
            class: 'search-hit', 'data-search-hit': String(index),
          }, { inclusiveStart: false, inclusiveEnd: false }));
          const active = activeDecoration(tr.doc, query, activeIndex);
          return { query, activeIndex, syntax, active, decorations: syntax.add(tr.doc, [...hits, ...active]) };
        },
      },
      props: {
        decorations: state => searchKey.getState(state)!.decorations,
      },
    })];
  },
});

const MarkdownStarterKit = StarterKit.extend({
  addExtensions() {
    return (this.parent?.() ?? []).map(extension => {
      if (!(extension instanceof Node)) return extension;
      if (extension.name === 'orderedList') {
        return extension.extend({
          addAttributes() {
            return { ...this.parent?.(), markdownDelimiter: { default: '.', rendered: false } };
          },
        });
      }
      if (extension.name !== 'listItem') return extension;
      const renderListItem = getExtensionField<NonNullable<ExtendableConfig['renderMarkdown']>>(
        extension, 'renderMarkdown',
      );
      return extension.extend({
        renderMarkdown(node, helpers, context) {
          const listHelpers = {
            ...helpers,
            renderChild(child: JSONContent, index: number) {
              const markdown = helpers.renderChild?.(child, index) ?? helpers.renderChildren([child]);
              // A list starting outside 1 cannot interrupt its parent paragraph.
              if (child.type === 'orderedList' && Number(child.attrs?.start ?? 1) !== 1 &&
                  node.content?.[index - 1]?.type === 'paragraph') {
                return '\n' + markdown;
              }
              return markdown;
            },
          };
          const attrs = context.meta?.parentAttrs;
          if (context.parentType !== 'orderedList' || (attrs?.type && attrs.type !== '1')) {
            return renderListItem(node, listHelpers, context);
          }
          // Different delimiters keep adjacent ordered lists separate on reimport.
          const delimiter = attrs?.markdownDelimiter === ')' ? ')' : '.';
          const number = Number(attrs?.start ?? 1) + context.index;
          return renderNestedMarkdownContent(node, listHelpers, `${number}${delimiter} `, context, {
            alignNestedToPrefix: true,
          });
        },
      });
    });
  },
});

export function editorExtensions(overrides: { rawSource?: typeof RawSource; image?: typeof LocalImage } = {}): Extensions {
  return [
    MarkdownStarterKit.configure({ code: false, paragraph: false, codeBlock: false, link: false, underline: false, trailingNode: false }),
    Code.extend({ excludes: '' }), SerializedCode, SerializedInline,
    SafeParagraph, SafeCodeBlock, SafeLink, overrides.image ?? LocalImage, overrides.rawSource ?? RawSource,
    SafeTable.configure({ resizable: false }), TableRow,
    TableCell.extend({ content: 'paragraph' }), TableHeader.extend({ content: 'paragraph' }),
    Markdown.configure({ indentation: { style: 'space', size: 2 } }), DocumentDecorations,
  ];
}
