import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Locator, type Page } from 'playwright';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type EditFixture = {
  filePath: string;
  pdfPath: string;
  statePath: string;
};

const pixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lb7T2wAAAABJRU5ErkJggg==',
  'base64'
);

async function createEditFixture(content = '# 原始\n\n正文。'): Promise<EditFixture> {
  const dir = join(tmpdir(), `md-viewer-stage7-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const filePath = join(dir, '编辑 文档.md');
  await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(join(dir, 'assets', 'pixel.png'), pixelPng);
  await writeFile(filePath, content, 'utf8');

  return {
    filePath,
    pdfPath: join(dir, 'export.pdf'),
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
      PLAYWRIGHT_TEST: 'true',
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
  await page.getByRole('button', { name: '打开文件', exact: true }).click();
  await expect(page.getByTestId('markdown-body')).toBeVisible();
}

function complexMarkdown(): string {
  return `# 原始标题

普通段落 初始文本。

带 **强调目标** 和 [链接目标](https://example.com/docs)。

> 引用内容

- 列表目标
- 第二项

| 字段 | 值 |
| --- | --- |
| 状态 | 表格目标 |

\`\`\`ts
const value = "代码目标";
\`\`\`

![有效图片](assets/pixel.png)
`;
}

async function replaceWithKeyboard(
  page: Page,
  locator: Locator,
  replacement: string,
  clickCount = 3
): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  await locator.click({ clickCount });
  await page.keyboard.type(replacement);
}

async function replaceInlineTextWithKeyboard(
  page: Page,
  locator: Locator,
  replacement: string,
  characterCount: number
): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error('Cannot locate inline text box');
  await page.mouse.click(box.x + box.width - 2, box.y + box.height / 2);
  for (let index = 0; index < characterCount; index += 1) {
    await page.keyboard.press('Shift+ArrowLeft');
  }
  await page.keyboard.type(replacement);
}

function shortcutModifier(): 'Control' | 'Meta' {
  return process.platform === 'darwin' ? 'Meta' : 'Control';
}

async function updateLinkTextWithDialog(page: Page, link: Locator, replacement: string): Promise<void> {
  await link.scrollIntoViewIfNeeded();
  await link.click();
  await page.getByRole('button', { name: 'Edit link URL' }).click();
  const textInput = page.locator('#link-text');
  await expect(textInput).toBeVisible();
  await textInput.click();
  await page.keyboard.press(`${shortcutModifier()}+A`);
  await page.keyboard.type(replacement);
  await page.keyboard.press('Enter');
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
        View: ['View', '查看'],
        Save: ['Save', '保存'],
        'Source Edit': ['Source Edit', '源码编辑'],
        'Open in Default Editor': ['Open in Default Editor', '用默认编辑器打开'],
        'Export as PDF': ['Export as PDF', '导出为 PDF']
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

async function enterSourceEditMode(electronApp: ElectronApplication, page: Page): Promise<void> {
  await clickNativeMenuItem(electronApp, 'View', 'Source Edit');
  await expect(page.getByTestId('source-editor-panel')).toBeVisible();
  await expect(page.getByTestId('source-editor')).toBeVisible();
  await expect(page.getByTestId('editor-preview')).toHaveCount(0);
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

test('edits complex Markdown as WYSIWYG in reading mode and saves the same file', async () => {
  const fixture = await createEditFixture(complexMarkdown());
  const electronApp = await launchWithSelectedFile(fixture);
  const page = await electronApp.firstWindow();

  await openFixture(page);
  const markdownBody = page.getByTestId('markdown-body');
  await expect(markdownBody.locator('img[alt="有效图片"]')).toHaveAttribute('src', /^data:image\/png;base64,/);

  await replaceWithKeyboard(page, markdownBody.getByText('普通段落 初始文本。'), '普通段落 已更新。');
  await replaceInlineTextWithKeyboard(page, markdownBody.locator('strong').filter({ hasText: '强调目标' }), '强调更新', 4);
  await updateLinkTextWithDialog(page, markdownBody.getByRole('link', { name: '链接目标' }), '链接更新');
  await replaceWithKeyboard(page, markdownBody.locator('li').filter({ hasText: '列表目标' }), '列表更新');
  await replaceWithKeyboard(page, markdownBody.locator('td').filter({ hasText: '表格目标' }), '表格更新');
  await replaceWithKeyboard(page, markdownBody.getByText('const value = "代码目标";'), 'const value = "代码更新";');

  await saveFromNativeMenu(electronApp);

  await expect.poll(() => readFile(fixture.filePath, 'utf8')).toContain('普通段落 已更新。');
  const saved = await readFile(fixture.filePath, 'utf8');
  expect(saved).toContain('**强调更新**');
  expect(saved).toContain('[链接更新](https://example.com/docs)');
  expect(saved).toMatch(/[-*]\s+列表更新/);
  expect(saved).toContain('表格更新');
  expect(saved).toMatch(/```ts[\s\S]*代码更新[\s\S]*```/);
  expect(saved).toContain('![有效图片](assets/pixel.png)');

  await closeAppDiscardingDrafts(electronApp);
});

test('syncs latest WYSIWYG edits into source mode before showing the textarea', async () => {
  const fixture = await createEditFixture(complexMarkdown());
  const electronApp = await launchWithSelectedFile(fixture);
  const page = await electronApp.firstWindow();

  await openFixture(page);
  const markdownBody = page.getByTestId('markdown-body');
  await updateLinkTextWithDialog(page, markdownBody.getByRole('link', { name: '链接目标' }), '链接同步');

  await enterSourceEditMode(electronApp, page);

  await expect(page.getByTestId('source-editor')).toHaveValue(/^\s*[\s\S]*\[链接同步\]\(https:\/\/example\.com\/docs\)[\s\S]*$/);

  await closeAppDiscardingDrafts(electronApp);
});

test('syncs source edits back into WYSIWYG reading mode', async () => {
  const fixture = await createEditFixture(complexMarkdown());
  const electronApp = await launchWithSelectedFile(fixture);
  const page = await electronApp.firstWindow();

  await openFixture(page);
  await enterSourceEditMode(electronApp, page);

  await page.getByTestId('source-editor').fill('# 源码更新\n\n源码段落\n\n| 字段 | 值 |\n| --- | --- |\n| 状态 | 已同步 |');
  await clickNativeMenuItem(electronApp, 'View', 'Source Edit');

  await expect(page.getByTestId('markdown-body')).toBeVisible();
  await expect(page.locator('.markdown-body h1')).toHaveText('源码更新');
  await expect(page.locator('.markdown-body td').filter({ hasText: '已同步' })).toBeVisible();

  await closeAppDiscardingDrafts(electronApp);
});

test('asks before closing with unsaved WYSIWYG changes and can cancel the close', async () => {
  const fixture = await createEditFixture(complexMarkdown());
  const electronApp = await launchWithSelectedFile(fixture);
  const page = await electronApp.firstWindow();

  await openFixture(page);
  const markdownBody = page.getByTestId('markdown-body');
  await replaceWithKeyboard(page, markdownBody.locator('td').filter({ hasText: '表格目标' }), '关闭前草稿');

  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].close();
  });
  await expect(markdownBody).toContainText('关闭前草稿');
  await expect
    .poll(() =>
      electronApp.evaluate(() => {
        const state = globalThis as typeof globalThis & { __stage7MessageBoxCount?: number };
        return state.__stage7MessageBoxCount;
      })
    )
    .toBe(1);

  await closeAppDiscardingDrafts(electronApp);
});

test('does not ask before closing after a successful WYSIWYG save', async () => {
  const fixture = await createEditFixture(complexMarkdown());
  const electronApp = await launchWithSelectedFile(fixture);
  const page = await electronApp.firstWindow();

  await openFixture(page);
  const markdownBody = page.getByTestId('markdown-body');
  await replaceWithKeyboard(page, markdownBody.getByText('普通段落 初始文本。'), '普通段落 已保存。');
  await saveFromNativeMenu(electronApp);
  await expect.poll(() => readFile(fixture.filePath, 'utf8')).toContain('普通段落 已保存。');

  const pageClosed = page.waitForEvent('close');
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].close();
  });
  await pageClosed;
});

test('edits Markdown source in a full-width editor and saves the same file', async () => {
  const fixture = await createEditFixture();
  const electronApp = await launchWithSelectedFile(fixture);
  const page = await electronApp.firstWindow();

  await openFixture(page);
  await enterSourceEditMode(electronApp, page);

  await page.getByTestId('source-editor').fill('# 更新\n\n- 一项');
  await expect(page.getByTestId('editor-preview')).toHaveCount(0);

  await saveFromNativeMenu(electronApp);
  await expect.poll(() => readFile(fixture.filePath, 'utf8')).toBe('# 更新\n\n- 一项');

  await closeAppDiscardingDrafts(electronApp);
});

test('keeps the WYSIWYG draft visible when save fails', async () => {
  const fixture = await createEditFixture(complexMarkdown());
  const electronApp = await launchWithSelectedFile(fixture);
  const page = await electronApp.firstWindow();

  await openFixture(page);
  const markdownBody = page.getByTestId('markdown-body');
  await replaceWithKeyboard(page, markdownBody.locator('td').filter({ hasText: '表格目标' }), '失败保留草稿');
  await rm(fixture.filePath);

  await saveFromNativeMenu(electronApp);

  await expect(page.getByRole('alert')).toContainText('文件不存在或已被移动。');
  await expect(markdownBody).toContainText('失败保留草稿');

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

test('exports the current window as a PDF from the native menu', async () => {
  const fixture = await createEditFixture();
  const electronApp = await launchWithSelectedFile(fixture);
  const page = await electronApp.firstWindow();

  await electronApp.evaluate(
    async ({ dialog }, pdfPath) => {
      const state = globalThis as typeof globalThis & {
        __stage7SaveDialogOptions?: unknown;
      };
      dialog.showSaveDialog = (async (...args: unknown[]) => {
        const options = args.length === 1 ? args[0] : args[1];
        state.__stage7SaveDialogOptions = options;
        return {
          canceled: false,
          filePath: pdfPath
        };
      }) as typeof dialog.showSaveDialog;
    },
    fixture.pdfPath
  );

  await openFixture(page);
  await clickNativeMenuItem(electronApp, 'File', 'Export as PDF');

  await expect
    .poll(async () => {
      try {
        const pdfData = await readFile(fixture.pdfPath);
        return pdfData.subarray(0, 4).toString('utf8');
      } catch {
        return '';
      }
    })
    .toBe('%PDF');

  const saveDialogOptions = await electronApp.evaluate(() => {
    const state = globalThis as typeof globalThis & { __stage7SaveDialogOptions?: unknown };
    return state.__stage7SaveDialogOptions;
  });
  expect(saveDialogOptions).toMatchObject({
    title: '导出 PDF',
    defaultPath: 'document.pdf'
  });

  await electronApp.close();
});
