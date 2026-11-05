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
import { headingId } from './headingIds';

export type MarkdownRenderResult =
  | {
      status: 'ready';
      html: string;
      outline: MarkdownOutlineEntry[];
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

export type MarkdownOutlineEntry = {
  id: string;
  level: number;
  text: string;
};

export type MarkdownParser = {
  render: (content: string) => string;
};

export type MarkdownReferences = Record<string, { href: string; title: string }>;
export type MarkdownRenderContext = { references?: MarkdownReferences };

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
  references?: MarkdownReferences;
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

export function collectMarkdownReferences(sources: readonly string[]): MarkdownReferences {
  const env: MarkdownRenderEnvironment = { references: Object.create(null) };
  for (const source of sources) defaultParser.parse(source, env);
  return env.references!;
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
    const text = (inlineToken.children ?? []).map(child => {
      if (child.type === 'text' || child.type === 'code_inline') return child.content;
      return child.type === 'softbreak' ? '\n' : '';
    }).join('').trim();
    const id = headingId(text, usedIds);

    token.attrSet('id', id);
    token.attrSet('data-heading-id', id);
    outline.push({ id, level, text });
  }

  return outline;
}

/** Source editing needs heading metadata, without rendering or sanitizing HTML. */
export function extractMarkdownOutline(content: string): MarkdownOutlineEntry[] {
  try {
    return applyHeadingIds(defaultParser.parse(content, {}));
  } catch {
    return [];
  }
}

function createLocalImageToken(): string {
  return globalThis.crypto?.randomUUID?.() ?? `image-token-${Date.now()}-${Math.random()}`;
}

function renderWithOutline(content: string, parser: MarkdownIt, context: MarkdownRenderContext): ReadyMarkdownRenderResult {
  const env: MarkdownRenderEnvironment = {
    localImageToken: createLocalImageToken(),
    ...(context.references ? { references: { ...context.references } } : {})
  };
  const tokens = parser.parse(content, env);
  const outline = applyHeadingIds(tokens);
  const unsafeHtml = parser.renderer.render(tokens, parser.options, env);

  return {
    status: 'ready',
    html: sanitizeHtml(unsafeHtml, env.localImageToken),
    outline
  };
}

function sanitizeHtml(html: string, localImageToken?: string): string {
  const hasToken = typeof localImageToken === 'string' && localImageToken.length > 0;

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
  parser: MarkdownParser = defaultParser,
  context: MarkdownRenderContext = {}
): MarkdownRenderResult {
  if (content.trim().length === 0) {
    return {
      status: 'empty',
      html: ''
    };
  }

  try {
    if (parser === defaultParser) {
      return renderWithOutline(content, defaultParser, context);
    }

    const unsafeHtml = parser.render(content);
    return {
      status: 'ready',
      html: sanitizeHtml(unsafeHtml),
      outline: []
    };
  } catch {
    return {
      status: 'error',
      message: 'Markdown 解析失败。'
    };
  }
}
