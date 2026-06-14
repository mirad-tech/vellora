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
  'href',
  'id',
  'rowspan',
  'title'
];

type MarkdownRenderEnvironment = {
  localImageToken?: string;
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
    token.attrSet('rel', 'noreferrer');
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

function renderWithOutline(content: string, parser: MarkdownIt): ReadyMarkdownRenderResult {
  const env: MarkdownRenderEnvironment = {
    localImageToken: createLocalImageToken()
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

function removeUntrustedImages(html: string, localImageToken?: string): string {
  if (!html.includes('<img') && !html.includes('<IMG')) {
    return html;
  }
  const template = document.createElement('template');
  template.innerHTML = html;

  const images = Array.from(template.content.querySelectorAll<HTMLImageElement>('img'));
  for (const image of images) {
    if (
      !localImageToken ||
      image.getAttribute('data-local-image-token') !== localImageToken ||
      !image.hasAttribute('data-local-src')
    ) {
      image.remove();
      continue;
    }

    image.removeAttribute('data-local-image-token');
    image.removeAttribute('src');
  }

  return template.innerHTML;
}

function sanitizeHtml(html: string, localImageToken?: string): string {
  let sanitized = '';
  sanitized = DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
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

  const imageSafeHtml = removeUntrustedImages(sanitized, localImageToken);
  return imageSafeHtml;
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
    };
  } catch {
    return {
      status: 'error',
      message: 'Markdown 解析失败。'
    };
  }
}
