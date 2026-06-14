import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, test } from 'vitest';

import {
  getMarkdownDialogOptions,
  getWorkspaceDialogOptions,
  openMarkdownFromDialog,
  openWorkspaceFromDialog
} from './openDialog';

async function makeMarkdownFixture(): Promise<string> {
  const dir = join(tmpdir(), `md-viewer-dialog-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, '可选择 文档.md');
  await writeFile(filePath, '# 从选择入口打开', 'utf8');
  return filePath;
}

describe('Markdown open dialog flow', () => {
  test('limits native selection to Markdown extensions', () => {
    const opts = getMarkdownDialogOptions('en');
    expect(opts.properties).toEqual(['openFile']);
    expect(opts.filters).toEqual([
      {
        name: 'Markdown',
        extensions: ['md', 'markdown']
      }
    ]);
  });

  test('limits native folder selection to directories', () => {
    const opts = getWorkspaceDialogOptions('en');
    expect(opts.properties).toEqual(['openDirectory']);
  });

  test('returns localized English cancel messages', async () => {
    await expect(
      openMarkdownFromDialog(async () => ({
        canceled: true,
        filePaths: []
      }), 'en')
    ).resolves.toEqual({
      ok: false,
      code: 'CANCELED',
      message: 'No file selected.'
    });

    await expect(
      openWorkspaceFromDialog(async () => ({
        canceled: true,
        filePaths: []
      }), {}, 'en')
    ).resolves.toEqual({
      ok: false,
      code: 'CANCELED',
      message: 'No folder selected.'
    });
  });

  test('reads the file selected by the dialog through controlled file access', async () => {
    const filePath = await makeMarkdownFixture();

    const result = await openMarkdownFromDialog(async () => ({
      canceled: false,
      filePaths: [filePath]
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.path).toBe(filePath);
    expect(result.document.content).toBe('# 从选择入口打开');
  });

  test('opens the folder selected by the dialog through controlled workspace access', async () => {
    const filePath = await makeMarkdownFixture();
    const folderPath = dirname(filePath);

    const result = await openWorkspaceFromDialog(async () => ({
      canceled: false,
      filePaths: [folderPath]
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workspace.path).toBe(folderPath);
    expect(result.workspace.fileCount).toBe(1);
  });
});
