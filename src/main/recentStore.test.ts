import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, test } from 'vitest';

import { createRecentStore } from './recentStore';

async function createRecentFixture(): Promise<{
  statePath: string;
  filePath: string;
  folderPath: string;
  secondFilePath: string;
}> {
  const dir = join(tmpdir(), `md-viewer-recent-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const folderPath = join(dir, '资料 目录');
  const filePath = join(folderPath, '记录.md');
  const secondFilePath = join(folderPath, '第二篇.md');
  await mkdir(folderPath, { recursive: true });
  await writeFile(filePath, '# 记录', 'utf8');
  await writeFile(secondFilePath, '# 第二篇', 'utf8');
  return {
    statePath: join(dir, 'state', 'recent.json'),
    filePath,
    folderPath,
    secondFilePath
  };
}

describe('recent local document store', () => {
  test('persists recent files and folders with newest item first', async () => {
    const { statePath, filePath, folderPath } = await createRecentFixture();
    const store = createRecentStore(statePath);

    await store.record({ type: 'folder', path: folderPath });
    await store.record({ type: 'file', path: filePath });
    await store.record({ type: 'folder', path: folderPath });

    const reloadedStore = createRecentStore(statePath);
    const result = await reloadedStore.read();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      type: 'folder',
      path: folderPath,
      name: '资料 目录',
      exists: true
    });
    expect(result.items[1]).toMatchObject({
      type: 'file',
      path: filePath,
      name: '记录.md',
      exists: true
    });
    expect(typeof result.items[0].openedAt).toBe('number');
  });

  test('keeps missing recent items marked as unavailable', async () => {
    const { statePath, filePath } = await createRecentFixture();
    const store = createRecentStore(statePath);

    await store.record({ type: 'file', path: filePath });
    await rm(filePath);

    const result = await store.read();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0]).toMatchObject({
      type: 'file',
      path: filePath,
      exists: false
    });
  });

  test('serializes concurrent record calls without losing recent items', async () => {
    const { statePath, filePath, folderPath, secondFilePath } = await createRecentFixture();
    const store = createRecentStore(statePath);

    await Promise.all([
      store.record({ type: 'file', path: filePath }),
      store.record({ type: 'folder', path: folderPath }),
      store.record({ type: 'file', path: secondFilePath })
    ]);

    const result = await store.read();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items.map((item) => item.path)).toEqual([
      secondFilePath,
      folderPath,
      filePath
    ]);
  });
});
