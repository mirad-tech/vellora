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

async function createBoundaryFixture(): Promise<{
  documentPath: string;
  workspacePath: string;
  allowedPath: string;
}> {
  const dir = join(tmpdir(), `md-viewer-link-boundary-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const workspacePath = join(dir, 'workspace');
  await mkdir(join(workspacePath, 'docs'), { recursive: true });
  await mkdir(join(workspacePath, 'private'), { recursive: true });
  await mkdir(join(dir, 'private'), { recursive: true });
  const documentPath = join(workspacePath, 'docs', 'entry.md');
  const allowedPath = join(workspacePath, 'private', 'allowed.md');
  await writeFile(documentPath, '# Entry', 'utf8');
  await writeFile(allowedPath, '# Allowed', 'utf8');
  await writeFile(join(dir, 'private', 'secret.md'), '# Secret', 'utf8');
  return { documentPath, workspacePath, allowedPath };
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

  test('rejects decoded traversal outside a standalone document directory', async () => {
    const { documentPath } = await createBoundaryFixture();

    await expect(openMarkdownLink(documentPath, '../../private/secret.md', vi.fn())).resolves.toMatchObject({
      ok: false,
      code: 'UNSUPPORTED_LINK'
    });
    await expect(openMarkdownLink(documentPath, '%2e%2e/%2e%2e/private/secret.md', vi.fn())).resolves.toMatchObject({
      ok: false,
      code: 'UNSUPPORTED_LINK'
    });
  });

  test('allows relative Markdown links inside an authorized workspace directory', async () => {
    const { documentPath, workspacePath, allowedPath } = await createBoundaryFixture();

    const result = await openMarkdownLink(documentPath, '../private/allowed.md', vi.fn(), {
      allowedDirectories: [workspacePath]
    });

    expect(result.ok).toBe(true);
    if (!result.ok || result.action !== 'markdown') return;
    expect(result.document.path).toBe(allowedPath);
    expect(result.document.content).toBe('# Allowed');
  });

  test('does not let a standalone document borrow another authorized workspace boundary', async () => {
    const dir = join(tmpdir(), `md-viewer-link-cross-boundary-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const workspacePath = join(dir, 'workspace');
    await mkdir(join(dir, 'docs'), { recursive: true });
    await mkdir(join(workspacePath, 'private'), { recursive: true });
    const documentPath = join(dir, 'docs', 'entry.md');
    await writeFile(documentPath, '# Entry', 'utf8');
    await writeFile(join(workspacePath, 'private', 'secret.md'), '# Secret', 'utf8');

    await expect(openMarkdownLink(documentPath, '../workspace/private/secret.md', vi.fn(), {
      allowedDirectories: [workspacePath]
    })).resolves.toMatchObject({
      ok: false,
      code: 'UNSUPPORTED_LINK'
    });
  });

  test('returns an error for malformed URLs instead of throwing', async () => {
    const { documentPath } = await createLinkFixture();
    const openExternal = vi.fn();

    const result = await openMarkdownLink(documentPath, 'http://[invalid', openExternal);

    expect(result).toMatchObject({
      ok: false,
      code: 'UNSUPPORTED_LINK'
    });
    expect(openExternal).not.toHaveBeenCalled();
  });
});
