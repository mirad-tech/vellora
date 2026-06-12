import { stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { isMarkdownPath, readMarkdownFile } from './fileAccess';
import type { MarkdownOpenResult, MarkdownSaveResult, OpenDefaultEditorResult } from '../shared/documentTypes';

export type DefaultEditorOpener = (filePath: string) => Promise<string>;

function invalidPathResult(): MarkdownSaveResult {
  return {
    ok: false,
    code: 'INVALID_ARGUMENT',
    message: '文件路径无效。'
  };
}

async function validateWritableMarkdownPath(filePath: unknown): Promise<MarkdownOpenResult> {
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

  return readMarkdownFile(filePath);
}

export async function saveMarkdownFile(filePath: unknown, content: unknown): Promise<MarkdownSaveResult> {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    return invalidPathResult();
  }

  if (typeof content !== 'string') {
    return {
      ok: false,
      code: 'INVALID_ARGUMENT',
      message: '保存内容无效。'
    };
  }

  if (!isMarkdownPath(filePath)) {
    return {
      ok: false,
      code: 'UNSUPPORTED_FILE_TYPE',
      message: '只能保存 .md 或 .markdown 文件。'
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

    await writeFile(resolvedPath, content, 'utf8');
    const result = await readMarkdownFile(resolvedPath);

    if (!result.ok) {
      return {
        ok: false,
        code: result.code === 'UNSUPPORTED_FILE_TYPE' ? 'UNSUPPORTED_FILE_TYPE' : 'SAVE_FAILED',
        message: result.message
      };
    }

    return {
      ok: true,
      document: result.document
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
      code: 'SAVE_FAILED',
      message: '保存失败，请检查权限或文件状态。'
    };
  }
}

export async function openDefaultEditor(
  filePath: unknown,
  opener: DefaultEditorOpener
): Promise<OpenDefaultEditorResult> {
  const validation = await validateWritableMarkdownPath(filePath);

  if (!validation.ok) {
    const code =
      validation.code === 'INVALID_ARGUMENT' ||
      validation.code === 'UNSUPPORTED_FILE_TYPE' ||
      validation.code === 'NOT_FOUND' ||
      validation.code === 'NOT_A_FILE'
        ? validation.code
        : 'OPEN_FAILED';
    return {
      ok: false,
      code,
      message: validation.message
    };
  }

  const errorMessage = await opener(validation.document.path);
  if (errorMessage) {
    return {
      ok: false,
      code: 'OPEN_FAILED',
      message: '无法用默认编辑器打开文件。'
    };
  }

  return {
    ok: true
  };
}
