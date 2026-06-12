import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

const root = process.cwd();

async function readPackageJson() {
  const raw = await readFile(join(root, 'package.json'), 'utf8');
  return JSON.parse(raw) as {
    version?: string;
    productName?: string;
    scripts?: Record<string, string>;
    devDependencies?: Record<string, string>;
    build?: {
      appId?: string;
      productName?: string;
      directories?: { output?: string };
      files?: string[];
      win?: { icon?: string; target?: Array<string | { target?: string }> };
      portable?: { artifactName?: string };
    };
  };
}

describe('stage 8 packaging configuration', () => {
  test('defines Windows portable packaging metadata and scripts', async () => {
    const pkg = await readPackageJson();

    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.productName).toBe('Local Markdown Viewer');
    expect(pkg.devDependencies).toHaveProperty('electron-builder');
    expect(pkg.scripts).toMatchObject({
      dist: 'npm run build && electron-builder',
      'dist:win:portable': 'npm run build && electron-builder --win portable',
      'test:stage8': 'vitest run tests/stage8/packaging.test.ts',
      'test:e2e:stage8': 'playwright test tests/e2e/stage8.spec.ts'
    });
    expect(pkg.build).toMatchObject({
      appId: 'app.local-markdown-viewer.desktop',
      productName: 'Local Markdown Viewer',
      directories: {
        output: 'release'
      },
      portable: {
        artifactName: 'Local-Markdown-Viewer-${version}-portable.${ext}'
      }
    });
    expect(pkg.build?.files).toEqual(expect.arrayContaining(['out/**', 'package.json']));
    expect(pkg.build?.win?.icon).toBe('build/icon.ico');
    expect(pkg.build?.win?.target).toEqual(['portable']);
  });

  test('includes an app icon and concise user guide', async () => {
    const icon = await readFile(join(root, 'build', 'icon.ico'));
    expect(icon.subarray(0, 4)).toEqual(Buffer.from([0, 0, 1, 0]));

    const guide = await readFile(join(root, 'README.md'), 'utf8');
    expect(guide).toContain('Local Markdown Viewer');
    expect(guide).toContain('打开 Markdown 文件');
    expect(guide).toContain('打开文件夹');
    expect(guide).toContain('不会删除用户文档');
  });
});
