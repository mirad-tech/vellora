import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function createNavigationFixture(): Promise<string> {
  const dir = join(tmpdir(), `md-viewer-stage4-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  const filler = Array.from({ length: 24 }, (_value, index) => `段落 ${index} alpha 内容。\n`).join('\n');
  const filePath = join(dir, '导航 搜索 验证.md');
  await writeFile(
    filePath,
    `# 项目记录

alpha 起点。

## 背景

${filler}

### 深入

这里有中文关键字，也有 Alpha 大写。

#### 细节

${filler}

##### 复核

继续包含中文关键字。

###### 终点

最后一个 alpha。

${filler}
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

async function clickNativeMenuItem(
  electronApp: ElectronApplication,
  topLevelLabel: string,
  itemLabel: string
): Promise<void> {
  await electronApp.evaluate(
    ({ BrowserWindow, Menu }, labels) => {
      const aliases: Record<string, string[]> = {
        Edit: ['Edit', '编辑'],
        View: ['View', '查看'],
        Find: ['Find', '查找'],
        'Toggle Sidebar': ['Toggle Sidebar', '切换侧边栏']
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

async function openOutline(electronApp: ElectronApplication, page: Page): Promise<void> {
  await clickNativeMenuItem(electronApp, 'View', 'Toggle Sidebar');
  await page.getByTestId('sidebar-tab-outline').click();
  await expect(page.getByTestId('sidebar-panel')).toBeVisible();
}

test('outline hierarchy is accurate and clicking a heading scrolls to it', async () => {
  const filePath = await createNavigationFixture();
  const electronApp = await launchWithSelectedFile(filePath);
  const page = await electronApp.firstWindow();

  await openFixture(page);
  await openOutline(electronApp, page);

  const levels = await page.getByTestId('outline-item').evaluateAll((items) =>
    items.map((item) => ({
      text: item.textContent?.trim(),
      level: item.getAttribute('data-level')
    }))
  );
  expect(levels).toEqual([
    { text: '项目记录', level: '1' },
    { text: '背景', level: '2' },
    { text: '深入', level: '3' },
    { text: '细节', level: '4' },
    { text: '复核', level: '5' },
    { text: '终点', level: '6' }
  ]);

  await page.getByTestId('outline-item').filter({ hasText: '终点' }).click();
  await expect(page.getByTestId('outline-item').filter({ hasText: '终点' })).toHaveAttribute(
    'aria-current',
    'true'
  );

  const headingTop = await page.locator('#heading-终点').evaluate((element) => {
    const reader = document.querySelector('[data-testid="reader-main"]') as HTMLElement;
    return element.getBoundingClientRect().top - reader.getBoundingClientRect().top;
  });
  expect(headingTop).toBeGreaterThanOrEqual(0);
  expect(headingTop).toBeLessThan(140);

  await electronApp.close();
});

test('document search highlights English and Chinese results with previous and next controls', async () => {
  const filePath = await createNavigationFixture();
  const electronApp = await launchWithSelectedFile(filePath);
  const page = await electronApp.firstWindow();

  await openFixture(page);
  await openOutline(electronApp, page);

  await clickNativeMenuItem(electronApp, 'Edit', 'Find');
  await page.getByTestId('document-search').fill('alpha');
  await expect(page.getByTestId('search-status')).toContainText('1/');
  await expect(page.locator('mark.search-hit')).toHaveCount(75);
  await expect(page.locator('mark[data-active-search="true"]')).toHaveText(/alpha/i);

  await page.getByTestId('search-next').click();
  await expect(page.getByTestId('search-status')).toContainText('2/75');
  await page.getByTestId('search-previous').click();
  await expect(page.getByTestId('search-status')).toContainText('1/75');

  await page.getByTestId('document-search').fill('中文关键字');
  await expect(page.getByTestId('search-status')).toContainText('1/2');
  await expect(page.locator('mark.search-hit')).toHaveCount(2);

  await page.getByTestId('document-search').fill('不存在');
  await expect(page.getByTestId('search-status')).toContainText('无结果');
  await expect(page.locator('mark.search-hit')).toHaveCount(0);

  await electronApp.close();
});

test('narrow window keeps search controls from covering the document', async () => {
  const filePath = await createNavigationFixture();
  const electronApp = await launchWithSelectedFile(filePath);
  await setWindowSize(electronApp, 520, 760);
  const page = await electronApp.firstWindow();

  await openFixture(page);
  await clickNativeMenuItem(electronApp, 'Edit', 'Find');
  await page.getByTestId('document-search').fill('中文关键字');

  const layout = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    findWidth: document.querySelector('[data-testid="find-bar"]')?.getBoundingClientRect().width,
    readerTop: document.querySelector('[data-testid="reader-main"]')?.getBoundingClientRect().top
  }));

  expect(layout.clientWidth).toBeLessThanOrEqual(540);
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
  expect(layout.findWidth ?? 0).toBeLessThanOrEqual(layout.clientWidth);
  await expect(page.getByTestId('markdown-body')).toContainText('中文关键字');
  await expect(page.locator('mark.search-hit')).toHaveCount(2);

  await electronApp.close();
});
