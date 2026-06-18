import { expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function createMarkdownFixture(): Promise<string> {
  const dir = join(tmpdir(), `md-viewer-e2e-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, '阶段 1 验证.md');
  await writeFile(filePath, '# 阶段 1\n\nRenderer 不能访问 fs。', 'utf8');
  return filePath;
}

function createLaunchArgumentEnv(): Record<string, string> {
  const envEntries = Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[0] !== 'PLAYWRIGHT_TEST' && typeof entry[1] === 'string'
  );

  return {
    ...Object.fromEntries(envEntries),
    ELECTRON_ENABLE_SECURITY_WARNINGS: 'true'
  };
}

test('stage 1 shell starts securely and reads Markdown through the preload API', async () => {
  const fixturePath = await createMarkdownFixture();
  const appPath = join(process.cwd(), 'out/main/index.js');
  const electronApp = await electron.launch({
    args: [appPath],
    env: {
      ...process.env,
      ELECTRON_ENABLE_SECURITY_WARNINGS: 'true',
      PLAYWRIGHT_TEST: 'true'
    }
  });

  const page = await electronApp.firstWindow();
  const consoleMessages: string[] = [];
  page.on('console', (message) => {
    consoleMessages.push(message.text());
  });

  await page.getByRole('button', { name: '打开文件', exact: true }).waitFor();
  await expect(page.getByRole('heading', { name: '未打开文件' })).toBeVisible();

  const boundary = await page.evaluate(async () => {
    const rendererGlobal = globalThis as typeof globalThis & {
      require?: (moduleName: string) => unknown;
      process?: unknown;
    };

    let fsAccess = 'require-unavailable';
    if (typeof rendererGlobal.require === 'function') {
      try {
        fsAccess = typeof rendererGlobal.require('fs');
      } catch {
        fsAccess = 'blocked';
      }
    }

    return {
      requireType: typeof rendererGlobal.require,
      processType: typeof rendererGlobal.process,
      fsAccess,
      apiKeys: Object.keys(window.mdViewer).sort(),
      diagnostics: await window.mdViewer.getSecurityDiagnostics()
    };
  });

  expect(boundary.requireType).toBe('undefined');
  expect(boundary.fsAccess).toBe('require-unavailable');
  expect(boundary.apiKeys).toEqual([
    'confirmDiscardChanges',
    'exportToPdf',
    'getRecentItems',
    'getSecurityDiagnostics',
    'onMarkdownOpenRequested',
    'onMenuAction',
    'openDefaultEditor',
    'openDroppedMarkdownFile',
    'openMarkdownByPath',
    'openMarkdownFile',
    'openMarkdownLink',
    'openWorkspaceByPath',
    'openWorkspaceFolder',
    'resolveMarkdownImage',
    'saveMarkdownFile',
    'setLanguage',
    'setUnsavedChanges'
  ]);
  expect(boundary.diagnostics).toEqual({
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
    allowedIpcChannels: [
      'dialog:openMarkdownFile',
      'document:openMarkdownByPath',
      'document:openRequested',
      'document:resolveMarkdownImage',
      'document:openMarkdownLink',
      'dialog:openWorkspaceFolder',
      'workspace:openByPath',
      'recent:list',
      'document:saveMarkdownFile',
      'document:openDefaultEditor',
      'editor:setUnsavedChanges',
      'editor:confirmDiscardChanges',
      'menu-action',
      'export-to-pdf',
      'app:getSecurityDiagnostics',
      'app:setLanguage'
    ]
  });

  const openResult = await page.evaluate((filePath) => window.mdViewer.openMarkdownByPath(filePath), fixturePath);

  expect(openResult.ok).toBe(true);
  if (!openResult.ok) {
    await electronApp.close();
    return;
  }

  expect(openResult.document.path).toBe(fixturePath);
  expect(openResult.document.name).toBe('阶段 1 验证.md');
  expect(openResult.document.content).toBe('# 阶段 1\n\nRenderer 不能访问 fs。');
  expect(typeof openResult.document.modifiedAt).toBe('number');

  const securityWarnings = consoleMessages.filter((message) =>
    message.includes('Electron Security Warning')
  );
  expect(securityWarnings).toEqual([]);

  await electronApp.close();
});

test('opens a Markdown file passed as a launch argument without test authorization', async () => {
  const fixturePath = await createMarkdownFixture();
  const appPath = join(process.cwd(), 'out/main/index.js');
  const electronApp = await electron.launch({
    args: [appPath, fixturePath],
    env: createLaunchArgumentEnv()
  });

  const page = await electronApp.firstWindow();
  await expect(page.locator('.markdown-body h1')).toHaveText('阶段 1');
  await expect(page.getByTestId('status-file-name')).toContainText('阶段 1 验证.md');

  await electronApp.close();
});
