import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, test, vi } from 'vitest';

import { openMarkdownLink } from './linkAccess';

async function createLinkFixture(): Promise<{ documentPath: string; linkedPath: string }> {
  const dir = join(tmpdir(), `md-viewer-link-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(join(dir, '子 目录'), { recursive: true });
  const documentPath = join(dir, '入口.md');
  const linkedPath = join(dir, '子 目录', '下一篇.markdown');
  await writeFile(documentPath, '[下一篇](子%20目录/下一篇.markdown)', 'utf8');
  await writeFile(linkedPath, '# 下一篇', 'utf8');
  return { documentPath, linkedPath };
}

describe('controlled Markdown link opening', () => {
  test('opens a relative Markdown link through the controlled file reader', async () => {
    const { documentPath, linkedPath } = await createLinkFixture();

    const result = await openMarkdownLink(documentPath, '子%20目录/下一篇.markdown', vi.fn());

    expect(result.ok).toBe(true);
    if (!result.ok || result.action !== 'markdown') return;
    expect(result.document.path).toBe(linkedPath);
    expect(result.document.content).toBe('# 下一篇');
  });

  test('opens http and https externally instead of navigating the renderer', async () => {
    const { documentPath } = await createLinkFixture();
    const openExternal = vi.fn().mockResolvedValue(undefined);

    const result = await openMarkdownLink(documentPath, 'https://example.com/docs', openExternal);

    expect(result).toEqual({
      ok: true,
      action: 'external',
      url: 'https://example.com/docs'
    });
    expect(openExternal).toHaveBeenCalledWith('https://example.com/docs');
  });

  test('rejects dangerous protocols without calling the external opener', async () => {
    const { documentPath } = await createLinkFixture();
    const openExternal = vi.fn();

    const result = await openMarkdownLink(documentPath, 'javascript:alert(1)', openExternal);

    expect(result).toEqual({
      ok: false,
      code: 'DANGEROUS_PROTOCOL',
      message: '已阻止不安全链接。'
    });
    expect(openExternal).not.toHaveBeenCalled();
  });
});
