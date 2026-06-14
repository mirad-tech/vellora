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
      fileAssociations?: Array<{ ext?: string; name?: string; role?: string }>;
      nsis?: {
        oneClick?: boolean;
        allowToChangeInstallationDirectory?: boolean;
        multiLanguageInstaller?: boolean;
        displayLanguageSelector?: boolean;
        createDesktopShortcut?: boolean;
        createStartMenuShortcut?: boolean;
        runAfterFinish?: boolean;
        include?: string;
      };
    };
  };
}

function readIcoSizes(icon: Buffer): Array<{ width: number; height: number }> {
  const count = icon.readUInt16LE(4);
  const sizes: Array<{ width: number; height: number }> = [];

  for (let index = 0; index < count; index += 1) {
    const offset = 6 + index * 16;
    const width = icon[offset] === 0 ? 256 : icon[offset];
    const height = icon[offset + 1] === 0 ? 256 : icon[offset + 1];
    sizes.push({ width, height });
  }

  return sizes;
}

describe('stage 8 packaging configuration', () => {
  test('defines Windows NSIS packaging metadata and scripts', async () => {
    const pkg = await readPackageJson();

    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.productName).toBe('Markdown viewer');
    expect(pkg.devDependencies).toHaveProperty('electron-builder');
    expect(pkg.scripts).toMatchObject({
      dist: 'npm run build && electron-builder',
      'test:stage8': 'vitest run tests/stage8/packaging.test.ts',
      'test:e2e:stage8': 'playwright test tests/e2e/stage8.spec.ts'
    });
    expect(pkg.scripts).not.toHaveProperty('dist:win:portable');
    expect(pkg.build).toMatchObject({
      appId: 'app.markdown-viewer.desktop',
      productName: 'Markdown viewer',
      directories: {
        output: 'release'
      }
    });
    expect(pkg.build?.files).toEqual(expect.arrayContaining(['out/**', 'package.json']));
    expect(pkg.build?.win?.icon).toBe('build/icon.ico');
    expect(pkg.build?.win?.target).toEqual(['nsis']);
    expect(pkg.build?.fileAssociations).toEqual([
      { ext: 'md', name: 'Markdown File', role: 'Editor' },
      { ext: 'markdown', name: 'Markdown File', role: 'Editor' }
    ]);
    expect(pkg.build?.nsis).toMatchObject({
      oneClick: false,
      allowToChangeInstallationDirectory: true,
      multiLanguageInstaller: true,
      displayLanguageSelector: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      runAfterFinish: true,
      include: 'build/installer.nsh'
    });
  });

  test('includes a custom NSIS page for optional Markdown file association', async () => {
    const installerScript = await readFile(join(root, 'build', 'installer.nsh'), 'utf8');

    expect(installerScript).toContain('customPageAfterChangeDir');
    expect(installerScript).toContain('MarkdownAssociationPageCreate');
    expect(installerScript).toContain('RegisterMarkdownAssociation');
    expect(installerScript).toContain('APP_UNASSOCIATE "md" "Markdown File"');
    expect(installerScript).toContain('APP_UNASSOCIATE "markdown" "Markdown File"');
  });

  test('includes an app icon and concise user guide', async () => {
    const icon = await readFile(join(root, 'build', 'icon.ico'));
    expect(icon.subarray(0, 4)).toEqual(Buffer.from([0, 0, 1, 0]));
    expect(readIcoSizes(icon)).toEqual(expect.arrayContaining([{ width: 256, height: 256 }]));

    const guide = await readFile(join(root, 'README.md'), 'utf8');
    expect(guide).toContain('Markdown查看器');
    expect(guide).toContain('Markdown viewer');
    expect(guide).toContain('打开 Markdown 文件');
    expect(guide).toContain('打开文件夹');
    expect(guide).toContain('NSIS 安装包');
    expect(guide).toContain('可选择安装路径');
    expect(guide).toContain('关联 .md');
    expect(guide).toContain('不会删除用户文档');
  });
});
