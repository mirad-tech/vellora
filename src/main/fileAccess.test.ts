import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, test } from 'vitest';

import { isMarkdownPath, readMarkdownFile } from './fileAccess';

async function makeTempMarkdown(name: string, content: string): Promise<string> {
  const dir = join(tmpdir(), `md-viewer-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, name);
  await writeFile(filePath, content, 'utf8');
  return filePath;
}

describe('controlled Markdown file access', () => {
  test('accepts .md and .markdown paths with Windows-safe names', () => {
    expect(isMarkdownPath('C:\\文档\\daily note.md')).toBe(true);
    expect(isMarkdownPath('G:\\团队 空间\\说明.MARKDOWN')).toBe(true);
    expect(isMarkdownPath('G:\\团队 空间\\说明.txt')).toBe(false);
  });

  test('reads UTF-8 Markdown content and metadata through the controlled API', async () => {
    const filePath = await makeTempMarkdown('中文 路径.md', '# 标题\n\n阶段 1');

    const result = await readMarkdownFile(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.path).toBe(filePath);
    expect(result.document.name).toBe('中文 路径.md');
    expect(result.document.content).toBe('# 标题\n\n阶段 1');
    expect(typeof result.document.modifiedAt).toBe('number');
    expect(result.document.size).toBe((await readFile(filePath)).byteLength);
  });

  test('rejects non-Markdown files before reading content', async () => {
    const filePath = await makeTempMarkdown('notes.txt', '# not allowed');

    const result = await readMarkdownFile(filePath);

    expect(result).toEqual({
      ok: false,
      code: 'UNSUPPORTED_FILE_TYPE',
      message: '只能打开 .md 或 .markdown 文件。'
    });
  });
});
