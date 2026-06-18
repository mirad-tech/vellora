import type { MarkdownLinkOpenResult } from '../shared/documentTypes';
import { isMarkdownPath, readMarkdownFile } from './fileAccess';
import { resolveDocumentRelativePath, type LocalResourceAccessOptions } from './pathPolicy';

export type ExternalLinkOpener = (url: string) => Promise<void> | void;
export type MarkdownLinkOpenOptions = LocalResourceAccessOptions;

const DANGEROUS_PROTOCOLS = new Set(['javascript:', 'data:', 'vbscript:', 'file:']);

function protocolOf(value: string): string | null {
  const match = /^[a-zA-Z][a-zA-Z\d+.-]*:/.exec(value);
  return match ? match[0].toLowerCase() : null;
}

function removeUrlSuffix(value: string): string {
  return value.split(/[?#]/, 1)[0];
}

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export async function openMarkdownLink(
  documentPath: unknown,
  rawHref: unknown,
  openExternal: ExternalLinkOpener,
  options: MarkdownLinkOpenOptions = {}
): Promise<MarkdownLinkOpenResult> {
  if (typeof documentPath !== 'string' || documentPath.trim() === '') {
    return {
      ok: false,
      code: 'INVALID_ARGUMENT',
      message: '文件路径无效。'
    };
  }

  if (typeof rawHref !== 'string' || rawHref.trim() === '') {
    return {
      ok: false,
      code: 'INVALID_ARGUMENT',
      message: '链接无效。'
    };
  }

  const href = rawHref.trim();
  const protocol = protocolOf(href);

  if (protocol && DANGEROUS_PROTOCOLS.has(protocol)) {
    return {
      ok: false,
      code: 'DANGEROUS_PROTOCOL',
      message: '已阻止不安全链接。'
    };
  }

  if (protocol === 'http:' || protocol === 'https:') {
    let url: string;
    try {
      url = new URL(href).toString();
    } catch {
      return {
        ok: false,
        code: 'UNSUPPORTED_LINK',
        message: '链接无效。'
      };
    }
    await openExternal(url);
    return {
      ok: true,
      action: 'external',
      url
    };
  }

  if (protocol) {
    return {
      ok: false,
      code: 'UNSUPPORTED_LINK',
      message: '只能打开 Markdown 链接或安全外部链接。'
    };
  }

  const localPath = resolveDocumentRelativePath(documentPath, decodePath(removeUrlSuffix(href)), options.allowedDirectories);
  if (!localPath) {
    return {
      ok: false,
      code: 'UNSUPPORTED_LINK',
      message: '只能打开 Markdown 链接或安全外部链接。'
    };
  }

  if (!isMarkdownPath(localPath)) {
    return {
      ok: false,
      code: 'UNSUPPORTED_LINK',
      message: '只能打开 Markdown 链接或安全外部链接。'
    };
  }

  const result = await readMarkdownFile(localPath);
  if (!result.ok) return result;

  return {
    ok: true,
    action: 'markdown',
    document: result.document
  };
}
