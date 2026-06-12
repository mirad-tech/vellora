import { readFile, stat } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';

import type { MarkdownOpenResult } from '../shared/documentTypes';

const SUPPORTED_MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);

export function isMarkdownPath(filePath: string): boolean {
  return SUPPORTED_MARKDOWN_EXTENSIONS.has(extname(filePath).toLowerCase());
}

export async function readMarkdownFile(filePath: unknown): Promise<MarkdownOpenResult> {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    return {
      ok: false,
      code: 'INVALID_ARGUMENT',
      message: '文件路径无效。'
    };
  }

  if (!isMarkdownPath(filePath)) {
    return {
      ok: false,
      code: 'UNSUPPORTED_FILE_TYPE',
      message: '只能打开 .md 或 .markdown 文件。'
    };
  }

  const resolvedPath = resolve(filePath);

  try {
    const info = await stat(resolvedPath);
    if (!info.isFile()) {
      return {
        ok: false,
        code: 'NOT_A_FILE',
        message: '选择的路径不是文件。'
      };
    }

    const content = await readFile(resolvedPath, 'utf8');

    return {
      ok: true,
      document: {
        path: resolvedPath,
        name: basename(resolvedPath),
        content,
        modifiedAt: info.mtimeMs,
        size: info.size
      }
    };
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;

    if (code === 'ENOENT') {
      return {
        ok: false,
        code: 'NOT_FOUND',
        message: '文件不存在或已被移动。'
      };
    }

    return {
      ok: false,
      code: 'READ_FAILED',
      message: '无法读取文件，请检查权限或文件状态。'
    };
  }
}
