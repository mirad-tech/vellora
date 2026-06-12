import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type EditFixture = {
  filePath: string;
  statePath: string;
};

async function createEditFixture(): Promise<EditFixture> {
  const dir = join(tmpdir(), `md-viewer-stage7-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const filePath = join(dir, '编辑 文档.md');
  await mkdir(dir, { recursive: true });
  await writeFile(filePath, '# 原始\n\n正文。', 'utf8');

  return {
    filePath,
    statePath: join(dir, 'state')
  };
}

async function launchWithSelectedFile(fixture: EditFixture): Promise<ElectronApplication> {
  const appPath = join(process.cwd(), 'out/main/index.js');
  const electronApp = await electron.launch({
    args: [appPath],
    env: {
      ...process.env,
      ELECTRON_ENABLE_SECURITY_WARNINGS: 'true',
      MD_VIEWER_USER_DATA_DIR: fixture.statePath
    }
  });

  await electronApp.evaluate(
    async ({ dialog, shell }, filePath) => {
      const state = globalThis as typeof globalThis & {
        __stage7MessageBoxResponse?: number;
        __stage7MessageBoxCount?: number;
        __stage7OpenedPath?: string;
      };
      state.__stage7MessageBoxResponse = 0;
      state.__stage7MessageBoxCount = 0;

      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [filePath],
        bookmarks: []
      });
      dialog.showMessageBox = async () => {
        state.__stage7MessageBoxCount = (state.__stage7MessageBoxCount ?? 0) + 1;
        return {
          response: state.__stage7MessageBoxResponse ?? 0,
          checkboxChecked: false
        };
      };
      shell.openPath = async (pathToOpen: string) => {
        state.__stage7OpenedPath = pathToOpen;
        return '';
      };
    },
    fixture.filePath
  );

  return electronApp;
}

async function openFixture(page: Page): Promise<void> {
  await page.getByRole('button', { name: '打开文件' }).click();
  await expect(page.getByTestId('markdown-body')).toBeVisible();
}

async function clickNativeMenuItem(
  electronApp: ElectronApplication,
  topLevelLabel: string,
  itemLabel: string
): Promise<void> {
  await electronApp.evaluate(
    ({ BrowserWindow, Menu }, labels) => {
      const normalize = (value: string) => value.replaceAll('&', '');
      const menu = Menu.getApplicationMenu();
      const topLevel = menu?.items.find((item) => normalize(item.label) === labels.topLevelLabel);
      const target = topLevel?.submenu?.items.find((item) => normalize(item.label) === labels.itemLabel);
      if (!target) throw new Error(`Missing menu item: ${labels.topLevelLabel} -> ${labels.itemLabel}`);
      (target.click as (...args: unknown[]) => void)(target, BrowserWindow.getFocusedWindow(), undefined);
    },
    { topLevelLabel, itemLabel }
  );
}

async function enterSourceEditMode(electronApp: ElectronApplication, page: Page): Promise<void> {
  await clickNativeMenuItem(electronApp, 'View', 'Source Edit');
  await expect(page.getByTestId('source-editor')).toBeVisible();
  await expect(page.getByTestId('editor-preview')).toBeVisible();
}

async function saveFromNativeMenu(electronApp: ElectronApplication): Promise<void> {
  await clickNativeMenuItem(electronApp, 'File', 'Save');
}

async function closeAppDiscardingDrafts(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(() => {
    const state = globalThis as typeof globalThis & { __stage7MessageBoxResponse?: number };
    state.__stage7MessageBoxResponse = 1;
  });
  await electronApp.close();
}

test('quick edits rendered text blocks and saves the same file', async () => {
  const fixture = await createEditFixture();
  const electronApp = await launchWithSelectedFile(fixture);
  const page = await electronApp.firstWindow();

  await openFixture(page);
  await expect(page.getByTestId('quick-edit-toggle')).toHaveCount(0);
  await expect(page.getByTestId('markdown-body')).toBeVisible();

  await page.locator('[data-edit-block-kind="heading"]').first().fill('更新标题');
  await page.locator('[data-edit-block-kind="paragraph"]').first().fill('更新正文');

  await saveFromNativeMenu(electronApp);

  await expect.poll(() => readFile(fixture.filePath, 'utf8')).toBe('# 更新标题\n\n更新正文');

  await closeAppDiscardingDrafts(electronApp);
});

test('quick edit multiline paragraph does not leave stale lines when input changes repeatedly', async () => {
  const fixture = await createEditFixture();
  const electronApp = await launchWithSelectedFile(fixture);
  const page = await electronApp.firstWindow();

  await openFixture(page);

  const paragraph = page.locator('[data-edit-block-kind="paragraph"]').first();
  await paragraph.evaluate((element) => {
    const editableElement = element as HTMLElement;
    editableElement.innerText = '第一行\n第二行';
    editableElement.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    editableElement.innerText = '第一行\n第二行\n第三行';
    editableElement.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  });

  await saveFromNativeMenu(electronApp);

  await expect.poll(() => readFile(fixture.filePath, 'utf8')).toBe('# 原始\n\n第一行\n第二行\n第三行');

  await closeAppDiscardingDrafts(electronApp);
});

test('edits Markdown source with split preview and saves the same file', async () => {
  const fixture = await createEditFixture();
  const electronApp = await launchWithSelectedFile(fixture);
  const page = await electronApp.firstWindow();

  await openFixture(page);
  await enterSourceEditMode(electronApp, page);

  await page.getByTestId('source-editor').fill('# 更新\n\n- 一项');
  await expect(page.getByTestId('editor-preview').locator('h1')).toHaveText('更新');

  await saveFromNativeMenu(electronApp);
  await expect.poll(() => readFile(fixture.filePath, 'utf8')).toBe('# 更新\n\n- 一项');

  await closeAppDiscardingDrafts(electronApp);
});

test('keeps the draft visible when save fails', async () => {
  const fixture = await createEditFixture();
  const electronApp = await launchWithSelectedFile(fixture);
  const page = await electronApp.firstWindow();

  await openFixture(page);
  await enterSourceEditMode(electronApp, page);
  await page.getByTestId('source-editor').fill('# 草稿');
  await rm(fixture.filePath);

  await saveFromNativeMenu(electronApp);

  await expect(page.getByRole('alert')).toContainText('文件不存在或已被移动。');
  await expect(page.getByTestId('source-editor')).toHaveValue('# 草稿');

  await closeAppDiscardingDrafts(electronApp);
});

test('asks before closing with unsaved changes and can cancel the close', async () => {
  const fixture = await createEditFixture();
  const electronApp = await launchWithSelectedFile(fixture);
  const page = await electronApp.firstWindow();

  await openFixture(page);
  await enterSourceEditMode(electronApp, page);
  await page.getByTestId('source-editor').fill('# 未保存');

  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].close();
  });
  await expect(page.getByTestId('source-editor')).toBeVisible();
  await expect
    .poll(() =>
      electronApp.evaluate(() => {
        const state = globalThis as typeof globalThis & { __stage7MessageBoxCount?: number };
        return state.__stage7MessageBoxCount;
      })
    )
    .toBe(1);

  await electronApp.evaluate(() => {
    const state = globalThis as typeof globalThis & { __stage7MessageBoxResponse?: number };
    state.__stage7MessageBoxResponse = 1;
  });
  const pageClosed = page.waitForEvent('close');
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].close();
  });
  await pageClosed;
});

test('opens the current file in the default editor from main process', async () => {
  const fixture = await createEditFixture();
  const electronApp = await launchWithSelectedFile(fixture);
  const page = await electronApp.firstWindow();

  await openFixture(page);
  await clickNativeMenuItem(electronApp, 'File', 'Open in Default Editor');

  await expect
    .poll(() =>
      electronApp.evaluate(() => {
        const state = globalThis as typeof globalThis & { __stage7OpenedPath?: string };
        return state.__stage7OpenedPath;
      })
    )
    .toBe(fixture.filePath);

  await electronApp.close();
});
