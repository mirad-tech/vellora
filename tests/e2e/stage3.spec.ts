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
      ELECTRON_ENABLE_SECURITY_WARNINGS: 'true'
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

async function openFixture(page: Page): Promise<void> {
  await page.getByRole('button', { name: '打开 Markdown 文件' }).click();
  await expect(page.getByTestId('markdown-body')).toBeVisible();
}

test('desktop reading interface keeps sidebar closed until requested', async () => {
  const filePath = await createReadingFixture();
  const electronApp = await launchWithSelectedFile(filePath);
  await setWindowSize(electronApp, 1366, 768);
  const page = await electronApp.firstWindow();

  await expect(page.getByRole('button', { name: '打开文件夹' })).toHaveCount(1);
  await page.locator('.app-logo-group').click();
  await expect(page.locator('.command-palette-card')).toBeHidden();

  await openFixture(page);

  await expect(page.getByTestId('app-shell')).toBeVisible();
  await expect(page.getByTestId('top-toolbar')).toBeVisible();
  await expect(page.getByTestId('sidebar-panel')).toBeHidden();
  await expect(page.getByTestId('reader-main')).toBeVisible();
  await expect(page.getByTestId('status-bar')).toBeVisible();
  await expect(page.getByTestId('status-file-name')).toContainText('阅读 界面 验证.md');
  await expect(page.getByTestId('status-file-path')).toContainText(filePath);
  await expect(page.getByTestId('status-modified-time')).toContainText('修改');
  await expect(page.getByTestId('status-word-count')).toContainText('字');

  await page.getByTestId('sidebar-toggle').click();
  await expect(page.getByTestId('sidebar-panel')).toBeVisible();
  await expect(page.getByTestId('sidebar-tab-outline')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('sidebar-panel')).toContainText('项目记录');
  await expect(page.getByTestId('sidebar-panel')).toContainText('背景');

  await page.getByTestId('theme-toggle').click();
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-theme', 'dark');
  await page.getByTestId('theme-toggle').click();
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-theme', 'light');

  await electronApp.close();
});

test('sidebar can toggle without hiding the document', async () => {
  const filePath = await createReadingFixture();
  const electronApp = await launchWithSelectedFile(filePath);
  const page = await electronApp.firstWindow();

  await openFixture(page);
  await expect(page.getByTestId('sidebar-panel')).toBeHidden();
  await page.getByTestId('sidebar-toggle').click();
  await expect(page.getByTestId('sidebar-panel')).toBeVisible();
  await page.getByTestId('sidebar-toggle').click();

  await expect(page.getByTestId('sidebar-panel')).toBeHidden();
  await expect(page.getByTestId('reader-main')).toBeVisible();
  await expect(page.getByTestId('markdown-body')).toContainText('项目记录');

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
    bodyText: document.body.innerText
  }));

  expect(layout.clientWidth).toBeLessThanOrEqual(540);
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
  await expect(page.getByTestId('reader-main')).toBeVisible();
  await expect(page.getByTestId('status-bar')).toBeVisible();
  await expect(page.getByTestId('sidebar-panel')).toBeHidden();
  expect(layout.bodyText).not.toContain('欢迎');
  expect(layout.bodyText).not.toContain('营销');

  await electronApp.close();
});
