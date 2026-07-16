import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';

export type MarkdownRenderResult =
  | {
      status: 'ready';
      html: string;
      outline: MarkdownOutlineEntry[];
      editableBlocks: MarkdownEditableBlock[];
    }
  | {
      status: 'empty';
      html: '';
    }
  | {
      status: 'error';
      message: string;
    };

export type ReadyMarkdownRenderResult = Extract<MarkdownRenderResult, { status: 'ready' }>;

export type MarkdownEditableBlockKind = 'heading' | 'paragraph' | 'list-item' | 'blockquote';

export type MarkdownEditableBlock = {
  id: string;
  kind: MarkdownEditableBlockKind;
  start: number;
  end: number;
};

export type MarkdownOutlineEntry = {
  id: string;
  level: number;
  text: string;
};

export type MarkdownParser = {
  render: (content: string) => string;
};

const ALLOWED_TAGS = [
  'a',
  'blockquote',
  'br',
  'code',
  'del',
  'div',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'img',
  'li',
  'ol',
  'p',
  'pre',
  'section',
  'span',
  'strong',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul'
];

const ALLOWED_ATTR = [
  'align',
  'alt',
  'class',
  'colspan',
  'data-heading-id',
  'data-edit-block-id',
  'data-edit-block-kind',
  'data-edit-block-token',
  'data-local-image-token',
  'data-local-src',
  'data-md-href',
  'href',
  'id',
  'rel',
  'role',
  'rowspan',
  'title'
];

type MarkdownRenderEnvironment = {
  localImageToken?: string;
  editBlockToken?: string;
};

hljs.safeMode();
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('css', css);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('md', markdown);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('html', xml);

function highlightCode(code: string, language: string): string {
  const normalizedLanguage = language.trim().toLowerCase().replace(/^language-/, '');
  if (!normalizedLanguage || !hljs.getLanguage(normalizedLanguage)) {
    return '';
  }

  return hljs.highlight(code, {
    language: normalizedLanguage,
    ignoreIllegals: true
  }).value;
}

function createMarkdownParser(): MarkdownIt {
  const parser = new MarkdownIt({
    html: true,
    linkify: false,
    typographer: false,
    highlight: highlightCode
  });

  const defaultLinkOpen =
    parser.renderer.rules.link_open ??
    ((tokens: Token[], index: number, options, _env, self) => {
      return self.renderToken(tokens, index, options);
    });

  parser.renderer.rules.link_open = (tokens, index, options, env, self) => {
    const token = tokens[index];
    const href = token.attrGet('href') ?? '';
    token.attrSet('rel', 'noreferrer');
    // Keep real target out of navigable href so middle-click / WebView navigation
    // cannot bypass the frontend confirm path. In-page anchors keep href="#...".
    token.attrSet('data-md-href', href);
    if (href.startsWith('#')) {
      token.attrSet('href', href);
    } else {
      token.attrSet('href', '#');
      token.attrSet('role', 'link');
    }
    return defaultLinkOpen(tokens, index, options, env, self);
  };

  parser.renderer.rules.image = (tokens, index, options, env, self) => {
    const token = tokens[index];
    const source = token.attrGet('src') ?? '';
    const localImageToken =
      typeof env === 'object' && env !== null && 'localImageToken' in env
        ? (env as MarkdownRenderEnvironment).localImageToken
        : undefined;
    token.attrs = (token.attrs ?? []).filter(([name]) => name !== 'src');
    token.attrSet('data-local-src', source);
    if (localImageToken) {
      token.attrSet('data-local-image-token', localImageToken);
    }
    token.attrSet('alt', self.renderInlineAsText(token.children ?? [], options, env));
    return self.renderToken(tokens, index, options);
  };

  return parser;
}

const defaultParser = createMarkdownParser();

function slugifyHeading(text: string): string {
  const slug = text
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]+/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return slug || 'heading';
}

function uniqueHeadingId(text: string, usedIds: Map<string, number>): string {
  const baseId = `heading-${slugifyHeading(text)}`;
  const count = usedIds.get(baseId) ?? 0;
  usedIds.set(baseId, count + 1);
  return count === 0 ? baseId : `${baseId}-${count + 1}`;
}

function applyHeadingIds(tokens: Token[]): MarkdownOutlineEntry[] {
  const outline: MarkdownOutlineEntry[] = [];
  const usedIds = new Map<string, number>();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== 'heading_open') continue;

    const inlineToken = tokens[index + 1];
    if (!inlineToken || inlineToken.type !== 'inline') continue;

    const level = Number(token.tag.slice(1));
    const text = inlineToken.content.trim();
    const id = uniqueHeadingId(text, usedIds);

    token.attrSet('id', id);
    token.attrSet('data-heading-id', id);
    outline.push({ id, level, text });
  }

  return outline;
}

function createLocalImageToken(): string {
  return globalThis.crypto?.randomUUID?.() ?? `image-token-${Date.now()}-${Math.random()}`;
}

function createEditBlockToken(): string {
  return globalThis.crypto?.randomUUID?.() ?? `edit-token-${Date.now()}-${Math.random()}`;
}

function findMatchingClose(
  tokens: Token[],
  openIndex: number,
  openType: string,
  closeType: string
): number {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    if (tokens[index].type === openType) depth += 1;
    if (tokens[index].type !== closeType) continue;
    depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

function sourceRangeForMap(
  content: string,
  lineStarts: number[],
  map: [number, number]
): { start: number; end: number } | null {
  const start = lineStarts[map[0]];
  const endExclusive = map[1] < lineStarts.length ? lineStarts[map[1]] : content.length;
  if (start === undefined || endExclusive <= start) return null;

  let end = endExclusive;
  while (end > start && (content[end - 1] === '\n' || content[end - 1] === '\r')) {
    end -= 1;
  }
  return end > start ? { start, end } : null;
}

function isSimpleContainer(
  tokens: Token[],
  openIndex: number,
  closeIndex: number
): boolean {
  const inner = tokens.slice(openIndex + 1, closeIndex);
  const paragraphCount = inner.filter((token) => token.type === 'paragraph_open').length;
  if (paragraphCount !== 1) return false;

  const disallowed = new Set([
    'blockquote_open',
    'bullet_list_open',
    'ordered_list_open',
    'fence',
    'code_block',
    'html_block',
    'table_open',
    'heading_open'
  ]);
  return !inner.some(
    (token) =>
      disallowed.has(token.type) ||
      token.children?.some((child) => child.type === 'image' || child.type === 'html_inline')
  );
}

function hasUnsupportedInlineContent(tokens: Token[], openIndex: number): boolean {
  const inline = tokens[openIndex + 1];
  return Boolean(
    inline?.type === 'inline' &&
      inline.children?.some((child) => child.type === 'image' || child.type === 'html_inline')
  );
}

function applyEditableBlocks(
  content: string,
  tokens: Token[],
  editBlockToken: string
): MarkdownEditableBlock[] {
  const blocks: MarkdownEditableBlock[] = [];
  const lineStarts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\n') lineStarts.push(index + 1);
  }

  const addBlock = (token: Token, kind: MarkdownEditableBlockKind) => {
    if (!token.map) return;
    const range = sourceRangeForMap(content, lineStarts, token.map);
    if (!range) return;
    const id = `edit-block-${kind}-${range.start}`;
    token.attrSet('data-edit-block-id', id);
    token.attrSet('data-edit-block-kind', kind);
    token.attrSet('data-edit-block-token', editBlockToken);
    blocks.push({ id, kind, ...range });
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (
      token.type === 'heading_open' &&
      token.level === 0 &&
      !hasUnsupportedInlineContent(tokens, index)
    ) {
      addBlock(token, 'heading');
      continue;
    }
    if (
      token.type === 'paragraph_open' &&
      token.level === 0 &&
      !hasUnsupportedInlineContent(tokens, index)
    ) {
      addBlock(token, 'paragraph');
      continue;
    }
    if (token.type === 'blockquote_open' && token.level === 0) {
      const closeIndex = findMatchingClose(tokens, index, 'blockquote_open', 'blockquote_close');
      if (closeIndex > index && isSimpleContainer(tokens, index, closeIndex)) {
        addBlock(token, 'blockquote');
      }
      continue;
    }
    if (token.type === 'list_item_open' && token.level === 1) {
      const closeIndex = findMatchingClose(tokens, index, 'list_item_open', 'list_item_close');
      if (closeIndex > index && isSimpleContainer(tokens, index, closeIndex)) {
        addBlock(token, 'list-item');
      }
    }
  }

  return blocks;
}

function renderWithOutline(content: string, parser: MarkdownIt): ReadyMarkdownRenderResult {
  const editBlockToken = createEditBlockToken();
  const env: MarkdownRenderEnvironment = {
    localImageToken: createLocalImageToken(),
    editBlockToken
  };
  const tokens = parser.parse(content, env);
  const outline = applyHeadingIds(tokens);
  const editableBlocks = applyEditableBlocks(content, tokens, editBlockToken);
  const unsafeHtml = parser.renderer.render(tokens, parser.options, env);

  return {
    status: 'ready',
    html: sanitizeHtml(unsafeHtml, env.localImageToken, editBlockToken),
    outline,
    editableBlocks
  };
}

function sanitizeHtml(html: string, localImageToken?: string, editBlockToken?: string): string {
  const hasToken = typeof localImageToken === 'string' && localImageToken.length > 0;
  const hasEditToken = typeof editBlockToken === 'string' && editBlockToken.length > 0;

  const securityHook = (node: Element) => {
    if (node.tagName === 'IMG') {
      if (hasToken) {
        const tokenAttr = node.getAttribute('data-local-image-token');
        const localSrc = node.getAttribute('data-local-src');

        if (tokenAttr !== localImageToken || !localSrc) {
          node.remove();
        } else {
          node.removeAttribute('data-local-image-token');
          node.removeAttribute('src');
        }
      } else {
        node.removeAttribute('data-local-image-token');
      }
    }

    if (node.hasAttribute('id')) {
      const idVal = node.getAttribute('id') || '';
      const dangerousIds = ['app-shell', 'root', 'app', 'reader', 'sidebar'];
      if (dangerousIds.includes(idVal.toLowerCase())) {
        node.removeAttribute('id');
      }
    }

    const hasEditMetadata =
      node.hasAttribute('data-edit-block-id') ||
      node.hasAttribute('data-edit-block-kind') ||
      node.hasAttribute('data-edit-block-token');
    if (hasEditMetadata) {
      if (!hasEditToken || node.getAttribute('data-edit-block-token') !== editBlockToken) {
        node.removeAttribute('data-edit-block-id');
        node.removeAttribute('data-edit-block-kind');
      }
      node.removeAttribute('data-edit-block-token');
    }
  };

  DOMPurify.addHook('afterSanitizeAttributes', securityHook);

  try {
    const allowedAttrs = [...ALLOWED_ATTR];
    if (!hasToken) {
      allowedAttrs.push('src');
    }

    return DOMPurify.sanitize(html, {
      ALLOWED_TAGS,
      ALLOWED_ATTR: allowedAttrs,
      ALLOW_DATA_ATTR: false,
      FORCE_BODY: true,
      FORBID_TAGS: [
        'base',
        'button',
        'embed',
        'form',
        'iframe',
        'input',
        'link',
        'math',
        'meta',
        'object',
        'script',
        'select',
        'style',
        'svg',
        'textarea'
      ]
    });
  } finally {
    DOMPurify.removeHook('afterSanitizeAttributes');
  }
}

export function renderMarkdownDocument(
  content: string,
  parser: MarkdownParser = defaultParser
): MarkdownRenderResult {
  if (content.trim().length === 0) {
    return {
      status: 'empty',
      html: ''
    };
  }

  try {
    if (parser === defaultParser) {
      return renderWithOutline(content, defaultParser);
    }

    const unsafeHtml = parser.render(content);
    return {
      status: 'ready',
      html: sanitizeHtml(unsafeHtml),
      outline: [],
      editableBlocks: []
    };
  } catch {
    return {
      status: 'error',
      message: 'Markdown 解析失败。'
    };
  }
}
