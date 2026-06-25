import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, test } from 'vitest';

import { openMarkdownWorkspace } from './workspaceAccess';

async function createWorkspaceFixture(): Promise<string> {
  const dir = join(tmpdir(), `md-viewer-workspace-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(join(dir, 'docs', '深入'), { recursive: true });
  await mkdir(join(dir, 'assets'), { recursive: true });
  await mkdir(join(dir, 'node_modules', 'dep'), { recursive: true });
  await mkdir(join(dir, '.git', 'hooks'), { recursive: true });
  await writeFile(join(dir, 'README.md'), '# README', 'utf8');
  await writeFile(join(dir, 'docs', '开始.md'), '# 开始', 'utf8');
  await writeFile(join(dir, 'docs', '深入', 'API.markdown'), '# API', 'utf8');
  await writeFile(join(dir, 'assets', 'logo.png'), 'not markdown', 'utf8');
  await writeFile(join(dir, 'notes.txt'), 'ignore me', 'utf8');
  await writeFile(join(dir, 'node_modules', 'dep', 'README.md'), '# DEP README', 'utf8');
  await writeFile(join(dir, '.git', 'description.md'), '# Description', 'utf8');
  return dir;
}

describe('controlled workspace folder access', () => {
  test('builds a nested Markdown-only file tree', async () => {
    const folderPath = await createWorkspaceFixture();

    const result = await openMarkdownWorkspace(folderPath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workspace.path).toBe(folderPath);
    expect(result.workspace.fileCount).toBe(3);
    expect(result.workspace.truncated).toBe(false);
    expect(result.workspace.children).toEqual([
      {
        type: 'directory',
        name: 'docs',
        path: join(folderPath, 'docs'),
        relativePath: 'docs',
        children: [
          {
            type: 'directory',
            name: '深入',
            path: join(folderPath, 'docs', '深入'),
            relativePath: 'docs/深入',
            children: [
              {
                type: 'file',
                name: 'API.markdown',
                path: join(folderPath, 'docs', '深入', 'API.markdown'),
                relativePath: 'docs/深入/API.markdown'
              }
            ]
          },
          {
            type: 'file',
            name: '开始.md',
            path: join(folderPath, 'docs', '开始.md'),
            relativePath: 'docs/开始.md'
          }
        ]
      },
      {
        type: 'file',
        name: 'README.md',
        path: join(folderPath, 'README.md'),
        relativePath: 'README.md'
      }
    ]);
  });

  test('reports missing folders without throwing', async () => {
    const missingPath = join(tmpdir(), `missing-workspace-${Date.now()}`);

    const result = await openMarkdownWorkspace(missingPath);

    expect(result).toEqual({
      ok: false,
      code: 'NOT_FOUND',
      message: '文件夹不存在或已被移动。'
    });
  });

  test('stops at the configured Markdown file limit', async () => {
    const folderPath = await createWorkspaceFixture();
    await writeFile(join(folderPath, 'extra-1.md'), '# 1', 'utf8');
    await writeFile(join(folderPath, 'extra-2.md'), '# 2', 'utf8');

    const result = await openMarkdownWorkspace(folderPath, { maxMarkdownFiles: 2 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workspace.fileCount).toBe(2);
    expect(result.workspace.truncated).toBe(true);
    expect(result.workspace.limit).toBe(2);
  });
});
