import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, test } from 'vitest';

import { authorizeMarkdownOpenRequest } from './ipc';

async function createAuthorizationFixture(): Promise<{
  markdownPath: string;
  textPath: string;
  missingPath: string;
}> {
  const dir = join(tmpdir(), `md-viewer-ipc-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  const markdownPath = join(dir, '系统打开.md');
  const textPath = join(dir, 'notes.txt');
  const missingPath = join(dir, 'missing.md');
  await writeFile(markdownPath, '# 系统打开', 'utf8');
  await writeFile(textPath, 'not markdown', 'utf8');
  return { markdownPath, textPath, missingPath };
}

describe('system Markdown open authorization', () => {
  test('authorizes existing Markdown files passed by the operating system', async () => {
    const { markdownPath } = await createAuthorizationFixture();

    expect(authorizeMarkdownOpenRequest(markdownPath)).toBe(true);
  });

  test('does not authorize unsupported, missing, or blank system open paths', async () => {
    const { textPath, missingPath } = await createAuthorizationFixture();

    expect(authorizeMarkdownOpenRequest(textPath)).toBe(false);
    expect(authorizeMarkdownOpenRequest(missingPath)).toBe(false);
    expect(authorizeMarkdownOpenRequest('')).toBe(false);
    expect(authorizeMarkdownOpenRequest(null)).toBe(false);
  });
});
