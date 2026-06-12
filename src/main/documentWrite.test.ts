import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, test, vi } from 'vitest';

import { openDefaultEditor, saveMarkdownFile } from './documentWrite';

async function createWriteFixture(): Promise<{ filePath: string; textPath: string }> {
  const dir = join(tmpdir(), `md-viewer-write-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, '编辑 文档.md');
  const textPath = join(dir, 'notes.txt');
  await writeFile(filePath, '# 原始', 'utf8');
  await writeFile(textPath, 'not markdown', 'utf8');
  return { filePath, textPath };
}

describe('controlled Markdown write access', () => {
  test('saves Markdown content to the selected document and returns fresh metadata', async () => {
    const { filePath } = await createWriteFixture();

    const result = await saveMarkdownFile(filePath, '# 更新\n\n正文');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await readFile(filePath, 'utf8')).toBe('# 更新\n\n正文');
    expect(result.document.path).toBe(filePath);
    expect(result.document.content).toBe('# 更新\n\n正文');
    expect(result.document.size).toBeGreaterThan(0);
  });

  test('rejects non-Markdown paths before writing', async () => {
    const { textPath } = await createWriteFixture();

    const result = await saveMarkdownFile(textPath, '# 不应写入');

    expect(result).toEqual({
      ok: false,
      code: 'UNSUPPORTED_FILE_TYPE',
      message: '只能保存 .md 或 .markdown 文件。'
    });
    expect(await readFile(textPath, 'utf8')).toBe('not markdown');
  });

  test('keeps save failures recoverable when the target file disappears', async () => {
    const { filePath } = await createWriteFixture();
    await rm(filePath);

    const result = await saveMarkdownFile(filePath, '# 草稿');

    expect(result).toEqual({
      ok: false,
      code: 'NOT_FOUND',
      message: '文件不存在或已被移动。'
    });
  });
});

describe('default editor fallback', () => {
  test('opens the Markdown file with the system default application', async () => {
    const { filePath } = await createWriteFixture();
    const opener = vi.fn().mockResolvedValue('');

    const result = await openDefaultEditor(filePath, opener);

    expect(result).toEqual({
      ok: true
    });
    expect(opener).toHaveBeenCalledWith(filePath);
  });

  test('reports default editor failures without throwing', async () => {
    const { filePath } = await createWriteFixture();
    const opener = vi.fn().mockResolvedValue('no association');

    const result = await openDefaultEditor(filePath, opener);

    expect(result).toEqual({
      ok: false,
      code: 'OPEN_FAILED',
      message: '无法用默认编辑器打开文件。'
    });
  });
});
