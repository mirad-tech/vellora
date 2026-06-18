import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type WorkspaceFixture = {
  folderPath: string;
  readmePath: string;
  nestedPath: string;
  deletedPath: string;
  statePath: string;
};

async function createWorkspaceFixture(): Promise<WorkspaceFixture> {
  const dir = join(tmpdir(), `md-viewer-stage6-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const folderPath = join(dir, '工作区 资料');
  const readmePath = join(folderPath, 'README.md');
  const nestedPath = join(folderPath, 'docs', '深入', 'API.markdown');
  const deletedPath = join(folderPath, 'docs', '待删除.md');
  await mkdir(join(folderPath, 'docs', '深入'), { recursive: true });
  await writeFile(readmePath, '# README\n\n入口文档。', 'utf8');
  await writeFile(join(folderPath, 'docs', '开始.md'), '# 开始\n\n多层目录文档。', 'utf8');
  await writeFile(nestedPath, '# API\n\n深入文档。', 'utf8');
  await writeFile(deletedPath, '# 待删除', 'utf8');
  await writeFile(join(folderPath, 'notes.txt'), 'ignore', 'utf8');

  return {
    folderPath,
    readmePath,
    nestedPath,
    deletedPath,
    statePath: join(dir, 'state')
  };
}

async function launchApp(fixture: WorkspaceFixture, fileLimit?: number): Promise<ElectronApplication> {
  const appPath = join(process.cwd(), 'out/main/index.js');
  const electronApp = await electron.launch({
    args: [appPath],
    env: {
      ...process.env,
      ELECTRON_ENABLE_SECURITY_WARNINGS: 'true',
      PLAYWRIGHT_TEST: 'true',
      MD_VIEWER_USER_DATA_DIR: fixture.statePath,
      ...(fileLimit ? { MD_VIEWER_WORKSPACE_FILE_LIMIT: String(fileLimit) } : {})
    }
  });

  await electronApp.evaluate(
    async ({ dialog }, folderPath) => {
      dialog.showOpenDialog = async (_window: unknown, options?: { properties?: string[] }) => {
        if (options?.properties?.includes('openDirectory')) {
          return {
            canceled: false,
            filePaths: [folderPath],
            bookmarks: []
          };
        }

        return {
          canceled: true,
          filePaths: [],
          bookmarks: []
        };
      };
    },
    fixture.folderPath
  );

  return electronApp;
}

async function clickNativeMenuItem(
  electronApp: ElectronApplication,
  topLevelLabel: string,
  itemLabel: string
): Promise<void> {
  await electronApp.evaluate(
    ({ BrowserWindow, Menu }, labels) => {
      const aliases: Record<string, string[]> = {
        File: ['File', '文件'],
        'Open Folder': ['Open Folder', '打开文件夹']
      };
      const normalize = (value: string) => value.replaceAll('&', '').replace(/\([^)]*\)$/, '');
      const candidatesFor = (value: string) => aliases[value] ?? [value];
      const menu = Menu.getApplicationMenu();
      const topLevelCandidates = candidatesFor(labels.topLevelLabel);
      const itemCandidates = candidatesFor(labels.itemLabel);
      const topLevel = menu?.items.find((item) => topLevelCandidates.includes(normalize(item.label)));
      const target = topLevel?.submenu?.items.find((item) => itemCandidates.includes(normalize(item.label)));
      if (!target) throw new Error(`Missing menu item: ${labels.topLevelLabel} -> ${labels.itemLabel}`);
      (target.click as (...args: unknown[]) => void)(target, BrowserWindow.getFocusedWindow(), undefined);
    },
    { topLevelLabel, itemLabel }
  );
}

async function openWorkspace(electronApp: ElectronApplication, page: Page): Promise<void> {
  await page.getByRole('button', { name: '打开文件', exact: true }).waitFor();
  await clickNativeMenuItem(electronApp, 'File', 'Open Folder');
  await expect(page.getByTestId('sidebar-panel')).toBeVisible();
  await expect(page.getByTestId('sidebar-tab-workspace')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('workspace-panel')).toBeVisible();
}

test('opens a folder, browses nested Markdown files, filters the tree, and switches documents', async () => {
  const fixture = await createWorkspaceFixture();
  const electronApp = await launchApp(fixture);
  const page = await electronApp.firstWindow();

  await openWorkspace(electronApp, page);

  await expect(page.getByTestId('workspace-file').filter({ hasText: 'README.md' })).toBeVisible();
  await expect(page.getByTestId('workspace-file').filter({ hasText: 'API.markdown' })).toBeVisible();
  await expect(page.getByTestId('workspace-panel')).not.toContainText('notes.txt');

  await page.getByTestId('workspace-filter').fill('api');
  await expect(page.getByTestId('workspace-file')).toHaveCount(1);
  await page.getByTestId('workspace-file').filter({ hasText: 'API.markdown' }).click();

  await expect(page.locator('.markdown-body h1')).toHaveText('API');
  await expect(page.getByTestId('status-file-name')).toContainText('API.markdown');

  await electronApp.close();
});

test('keeps recent files and folders after restart and opens them safely', async () => {
  const fixture = await createWorkspaceFixture();
  let electronApp = await launchApp(fixture);
  let page = await electronApp.firstWindow();

  await openWorkspace(electronApp, page);
  await page.getByTestId('workspace-file').filter({ hasText: 'README.md' }).click();
  await expect(page.locator('.markdown-body h1')).toHaveText('README');
  await electronApp.close();

  electronApp = await launchApp(fixture);
  page = await electronApp.firstWindow();

  await expect(page.getByTestId('recent-list')).toBeVisible();
  await expect(page.locator('[data-testid="recent-item"][data-recent-type="folder"]')).toContainText('工作区 资料');
  await page.locator('[data-testid="recent-item"][data-recent-type="file"]').filter({ hasText: 'README.md' }).click();
  await expect(page.locator('.markdown-body h1')).toHaveText('README');

  await electronApp.close();
});

test('shows a recoverable error when a workspace file disappears', async () => {
  const fixture = await createWorkspaceFixture();
  const electronApp = await launchApp(fixture);
  const page = await electronApp.firstWindow();

  await openWorkspace(electronApp, page);
  await rm(fixture.deletedPath);
  await page.getByTestId('workspace-file').filter({ hasText: '待删除.md' }).click();

  await expect(page.getByRole('heading', { name: '打开失败' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('文件不存在或已被移动。');
  await expect(page.getByTestId('workspace-panel')).toBeVisible();

  await electronApp.close();
});

test('shows a workspace limit state for large folders', async () => {
  const fixture = await createWorkspaceFixture();
  const electronApp = await launchApp(fixture, 2);
  const page = await electronApp.firstWindow();

  await openWorkspace(electronApp, page);

  await expect(page.getByTestId('workspace-limit')).toContainText('2');
  await expect(page.getByTestId('workspace-file')).toHaveCount(2);

  await electronApp.close();
});
