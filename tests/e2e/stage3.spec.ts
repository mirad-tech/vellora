import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function createReadingFixture(): Promise<string> {
  const dir = join(tmpdir(), `md-viewer-stage3-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, '阅读 界面 验证.md');
  await writeFile(
    filePath,
    `# 项目记录

这是一段用于检查阅读宽度、行高和状态栏信息的正文。

## 背景

> 本地文档需要稳定阅读。

## 操作

- 打开文件
- 查看大纲
- 切换主题

\`\`\`ts
const readable = true;
\`\`\`
`,
    'utf8'
  );
  return filePath;
}

async function launchWithSelectedFile(filePath: string): Promise<ElectronApplication> {
  const appPath = join(process.cwd(), 'out/main/index.js');
  const electronApp = await electron.launch({
    args: [appPath],
    env: {
      ...process.env,
      ELECTRON_ENABLE_SECURITY_WARNINGS: 'true',
      PLAYWRIGHT_TEST: 'true'
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
    filePath
  );

  return electronApp;
}

async function setWindowSize(electronApp: ElectronApplication, width: number, height: number): Promise<void> {
  await electronApp.evaluate(
    async ({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setSize(size.width, size.height);
    },
    { width, height }
  );
}

async function getWindowSize(electronApp: ElectronApplication): Promise<number[]> {
  return electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize());
}

async function getPrimaryWorkAreaSize(electronApp: ElectronApplication): Promise<{ width: number; height: number }> {
  return electronApp.evaluate(({ screen }) => {
    const { workAreaSize } = screen.getPrimaryDisplay();
    return workAreaSize;
  });
}

function expectedInitialWindowSize(workAreaSize: { width: number; height: number }): number[] {
  return [
    Math.max(480, Math.min(880, workAreaSize.width - 24)),
    Math.max(520, Math.min(980, workAreaSize.height - 24))
  ];
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
        Edit: ['Edit', '编辑'],
        View: ['View', '查看'],
        Window: ['Window', '窗口'],
        Find: ['Find', '查找'],
        'Command Palette': ['Command Palette', '命令面板'],
        'Toggle Sidebar': ['Toggle Sidebar', '切换侧边栏'],
        'Toggle Theme': ['Toggle Theme', '切换主题'],
        Settings: ['Settings', '设置']
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

async function openFixture(page: Page): Promise<void> {
  await page.getByRole('button', { name: '打开文件', exact: true }).click();
  await expect(page.getByTestId('markdown-body')).toBeVisible();
}

test('default window size uses a reading-focused document shape', async () => {
  const filePath = await createReadingFixture();
  const electronApp = await launchWithSelectedFile(filePath);
  const page = await electronApp.firstWindow();

  const workAreaSize = await getPrimaryWorkAreaSize(electronApp);
  expect(await getWindowSize(electronApp)).toEqual(expectedInitialWindowSize(workAreaSize));

  await openFixture(page);
  await expect(page.getByTestId('reader-main')).toBeVisible();
  await expect(page.getByTestId('markdown-body')).toBeVisible();
  await expect(page.getByTestId('status-bar')).toBeVisible();

  await electronApp.close();
});

test('desktop reading interface keeps sidebar closed until requested', async () => {
  const filePath = await createReadingFixture();
  const electronApp = await launchWithSelectedFile(filePath);
  await setWindowSize(electronApp, 1366, 768);
  const page = await electronApp.firstWindow();

  const topLevelMenu = await electronApp.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()?.items.map((item) => item.label.replaceAll('&', '').replace(/\([^)]*\)$/, '')) ?? []
  );
  expect([
    ['File', 'Edit', 'View', 'Window'],
    ['文件', '编辑', '查看', '窗口']
  ]).toContainEqual(topLevelMenu);
  await expect(page.locator('.app-logo-group')).toHaveCount(0);
  await expect(page.locator('.command-palette-card')).toBeHidden();

  await openFixture(page);

  await expect(page.locator('.app-name-label')).toHaveCount(0);
  await expect(page.getByTestId('app-shell')).toBeVisible();
  await expect(page.getByTestId('top-toolbar')).toHaveCount(0);
  await expect(page.getByTestId('sidebar-panel')).toBeHidden();
  await expect(page.getByTestId('reader-main')).toBeVisible();
  await expect(page.getByTestId('status-bar')).toBeVisible();
  await expect(page.getByTestId('status-file-name')).toContainText('阅读 界面 验证.md');
  await expect(page.getByTestId('status-file-path')).toContainText(filePath);
  await expect(page.getByTestId('status-modified-time')).toContainText('修改');
  await expect(page.getByTestId('status-word-count')).toContainText('字');
  await expect(page.locator('.document-meta')).toHaveCount(0);
  await expect(page.getByTestId('read-mode-toggle')).toHaveCount(0);
  await expect(page.getByTestId('quick-edit-toggle')).toHaveCount(0);

  await clickNativeMenuItem(electronApp, 'View', 'Toggle Sidebar');
  await expect(page.getByTestId('sidebar-panel')).toBeVisible();
  await expect(page.getByTestId('sidebar-tab-outline')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('sidebar-panel')).toContainText('项目记录');
  await expect(page.getByTestId('sidebar-panel')).toContainText('背景');

  await clickNativeMenuItem(electronApp, 'View', 'Toggle Theme');
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-theme', 'dark');
  await clickNativeMenuItem(electronApp, 'View', 'Toggle Theme');
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-theme', 'light');

  await electronApp.close();
});

test('sidebar can toggle without hiding the document', async () => {
  const filePath = await createReadingFixture();
  const electronApp = await launchWithSelectedFile(filePath);
  const page = await electronApp.firstWindow();

  await openFixture(page);
  await expect(page.getByTestId('sidebar-panel')).toBeHidden();
  await clickNativeMenuItem(electronApp, 'View', 'Toggle Sidebar');
  await expect(page.getByTestId('sidebar-panel')).toBeVisible();
  await clickNativeMenuItem(electronApp, 'View', 'Toggle Sidebar');

  await expect(page.getByTestId('sidebar-panel')).toBeHidden();
  await expect(page.getByTestId('reader-main')).toBeVisible();
  await expect(page.getByTestId('markdown-body')).toContainText('项目记录');

  await electronApp.close();
});

test('command palette, settings diagnostics, and file info open in the window', async () => {
  const filePath = await createReadingFixture();
  const electronApp = await launchWithSelectedFile(filePath);
  const page = await electronApp.firstWindow();

  await openFixture(page);

  await clickNativeMenuItem(electronApp, 'Edit', 'Command Palette');
  await expect(page.locator('.command-palette-card')).toBeVisible();
  await page.locator('.command-palette-card input').fill('元数据');
  await expect(page.locator('.palette-item-btn')).toContainText('查看文档元数据详情');
  await page.keyboard.press('Enter');

  await expect(page.getByRole('heading', { name: '文件详细信息' })).toBeVisible();
  await expect(page.locator('.file-info-modal-card')).toContainText('阅读 界面 验证.md');
  await expect(page.locator('.file-info-modal-card')).toContainText(filePath);
  await expect(page.locator('.file-info-modal-card')).toContainText('字符数');
  await page.keyboard.press('Escape');
  await expect(page.locator('.file-info-modal-card')).toBeHidden();

  await clickNativeMenuItem(electronApp, 'View', 'Settings');
  await expect(page.getByRole('heading', { name: '设置与安全诊断' })).toBeVisible();
  await expect(page.locator('.settings-drawer-card')).toContainText('上下文隔离 (Context Isolation)');
  await expect(page.locator('.settings-drawer-card')).toContainText('Node.js 集成 (Node Integration)');
  await expect(page.locator('.settings-drawer-card')).toContainText('已启用');
  await expect(page.locator('.settings-drawer-card')).toContainText('已禁用');
  await expect(page.locator('.settings-drawer-card')).toContainText('menu-action');
  await expect(page.locator('.settings-drawer-card')).toContainText('export-to-pdf');

  await electronApp.close();
});

test('wide and narrow windows keep readable content without horizontal overflow', async () => {
  const filePath = await createReadingFixture();
  const electronApp = await launchWithSelectedFile(filePath);
  const page = await electronApp.firstWindow();

  await setWindowSize(electronApp, 1920, 1080);
  await openFixture(page);
  await expect(page.getByTestId('reader-main')).toBeVisible();
  await expect(page.getByTestId('status-bar')).toBeVisible();

  await setWindowSize(electronApp, 520, 760);
  await page.waitForTimeout(200);
  const layout = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    bodyText: document.body.innerText,
    appShellGridRowCount: window
      .getComputedStyle(document.querySelector('[data-testid="app-shell"]') as HTMLElement)
      .gridTemplateRows.split(/\s+/)
      .filter(Boolean).length
  }));

  expect(layout.clientWidth).toBeLessThanOrEqual(540);
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
  expect(layout.appShellGridRowCount).toBeGreaterThanOrEqual(3);
  await expect(page.getByTestId('reader-main')).toBeVisible();
  await expect(page.getByTestId('status-bar')).toBeVisible();
  await expect(page.getByTestId('sidebar-panel')).toBeHidden();
  expect(layout.bodyText).not.toContain('欢迎');
  expect(layout.bodyText).not.toContain('营销');

  await electronApp.close();
});
