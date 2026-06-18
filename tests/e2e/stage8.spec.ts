import { expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function createPackagedFixture(): Promise<{
  filePath: string;
  statePath: string;
}> {
  const dir = join(tmpdir(), `md-viewer-stage8-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, '打包 验证.md');
  await writeFile(filePath, '# 打包验证\n\n打包版打开成功。', 'utf8');
  return {
    filePath,
    statePath: join(dir, 'state')
  };
}

test('packaged Windows app starts securely and opens Markdown without dev server', async () => {
  const executablePath = join(process.cwd(), 'release', 'win-unpacked', 'Markdown viewer.exe');
  await access(executablePath);

  const fixture = await createPackagedFixture();
  const electronApp = await electron.launch({
    executablePath,
    env: {
      ...process.env,
      ELECTRON_ENABLE_SECURITY_WARNINGS: 'true',
      PLAYWRIGHT_TEST: 'true',
      MD_VIEWER_USER_DATA_DIR: fixture.statePath
    }
  });

  await electronApp.evaluate(
    async ({ dialog }, selectedPath) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [selectedPath],
        bookmarks: []
      });
    },
    fixture.filePath
  );

  const page = await electronApp.firstWindow();
  await page.getByRole('button', { name: '打开文件', exact: true }).click();
  await expect(page.locator('.markdown-body h1')).toHaveText('打包验证');

  const boundary = await page.evaluate(async () => ({
    url: location.href,
    requireType: typeof (globalThis as typeof globalThis & { require?: unknown }).require,
    diagnostics: await window.mdViewer.getSecurityDiagnostics()
  }));

  expect(boundary.url).toContain('file://');
  expect(boundary.requireType).toBe('undefined');
  expect(boundary.diagnostics).toMatchObject({
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    webviewTag: false
  });

  await electronApp.close();
});

test('packaged Windows app opens Markdown passed by Windows file association arguments', async () => {
  const executablePath = join(process.cwd(), 'release', 'win-unpacked', 'Markdown viewer.exe');
  await access(executablePath);

  const fixture = await createPackagedFixture();
  const electronApp = await electron.launch({
    executablePath,
    args: [fixture.filePath],
    env: {
      ...process.env,
      MD_VIEWER_USER_DATA_DIR: fixture.statePath
    }
  });

  const page = await electronApp.firstWindow();
  await expect(page.locator('.markdown-body h1')).toHaveText('打包验证');

  await electronApp.close();
});
