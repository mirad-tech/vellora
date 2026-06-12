import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, test } from 'vitest';

import { resolveMarkdownImage } from './imageAccess';

async function createImageFixture(): Promise<{ documentPath: string; imagePath: string }> {
  const dir = join(tmpdir(), `md-viewer-image-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(join(dir, '资源 目录'), { recursive: true });
  const documentPath = join(dir, '文档.md');
  const imagePath = join(dir, '资源 目录', '示例 图片.png');
  await writeFile(documentPath, '![示例](资源%20目录/示例%20图片.png)', 'utf8');
  await writeFile(
    imagePath,
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lb7T2wAAAABJRU5ErkJggg==', 'base64')
  );
  return { documentPath, imagePath };
}

describe('controlled local image access', () => {
  test('resolves a relative image with spaces to a data URL', async () => {
    const { documentPath } = await createImageFixture();

    const result = await resolveMarkdownImage(documentPath, '资源%20目录/示例%20图片.png');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mime).toBe('image/png');
    expect(result.src).toMatch(/^data:image\/png;base64,/);
  });

  test('returns a missing result for absent images', async () => {
    const { documentPath } = await createImageFixture();

    const result = await resolveMarkdownImage(documentPath, 'missing.png');

    expect(result).toEqual({
      ok: false,
      code: 'IMAGE_NOT_FOUND',
      message: '图片不存在或已被移动。'
    });
  });

  test('rejects external, absolute, and unsupported image sources', async () => {
    const { documentPath } = await createImageFixture();

    await expect(resolveMarkdownImage(documentPath, 'https://example.com/a.png')).resolves.toMatchObject({
      ok: false,
      code: 'UNSUPPORTED_IMAGE_SOURCE'
    });
    await expect(resolveMarkdownImage(documentPath, 'C:/Windows/win.ini')).resolves.toMatchObject({
      ok: false,
      code: 'UNSUPPORTED_IMAGE_SOURCE'
    });
    await expect(resolveMarkdownImage(documentPath, 'icon.svg')).resolves.toMatchObject({
      ok: false,
      code: 'UNSUPPORTED_IMAGE_TYPE'
    });
  });
});
