import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type Stage5Fixture = {
  documentPath: string;
  linkedPath: string;
  linkedMarkdownPath: string;
  dragPath: string;
};

async function createResourceFixture(): Promise<Stage5Fixture> {
  const dir = join(tmpdir(), `md-viewer-stage5-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(join(dir, 'assets'), { recursive: true });

  const documentPath = join(dir, '入口 文档.md');
  const linkedPath = join(dir, '下一篇.md');
  const linkedMarkdownPath = join(dir, '附录.markdown');
  const dragPath = join(dir, '拖入 文档.markdown');
  const pixelPath = join(dir, 'assets', 'pixel.png');

  await writeFile(
    pixelPath,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lb7T2wAAAABJRU5ErkJggg==',
      'base64'
    )
  );
  await writeFile(
    documentPath,
    `# 入口

![有效图片](assets/pixel.png)

![缺失图片](assets/missing.png)

[外部链接](https://example.com/docs)

[危险链接](javascript:window.__stage5Bad = 1)

[缺失篇](missing.md)

[下一篇](下一篇.md)
`,
    'utf8'
  );
  await writeFile(linkedPath, '# 下一篇\n\n本地链接打开成功。', 'utf8');
  await writeFile(linkedMarkdownPath, '# 附录\n\nMarkdown 扩展名链接打开成功。', 'utf8');
  await writeFile(dragPath, '# 拖入文档\n\n![拖入图片](assets/pixel.png)\n\n拖放打开成功。', 'utf8');

  return { documentPath, linkedPath, linkedMarkdownPath, dragPath };
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
    async ({ dialog, shell }, selectedPath) => {
      const state = globalThis as typeof globalThis & {
        __stage5DiscardPromptCount?: number;
        __stage5DiscardPromptResponse?: number;
        __stage5OpenDialogCanceled?: boolean;
        __stage5OpenedExternal?: string;
      };
      state.__stage5DiscardPromptCount = 0;
      state.__stage5DiscardPromptResponse = 0;
      state.__stage5OpenDialogCanceled = false;
      dialog.showOpenDialog = async () => {
        if (state.__stage5OpenDialogCanceled) {
          return {
            canceled: true,
            filePaths: [],
            bookmarks: []
          };
        }

        return {
          canceled: false,
          filePaths: [selectedPath],
          bookmarks: []
        };
      };
      dialog.showMessageBox = async () => {
        state.__stage5DiscardPromptCount = (state.__stage5DiscardPromptCount ?? 0) + 1;
        return {
          response: state.__stage5DiscardPromptResponse ?? 0,
          checkboxChecked: false
        };
      };
      shell.openExternal = async (url: string) => {
        state.__stage5OpenedExternal = url;
      };
    },
    filePath
  );

  return electronApp;
}

async function openFixture(page: Page): Promise<void> {
  await page.getByRole('button', { name: '打开文件', exact: true }).click();
  await expect(page.getByTestId('markdown-body')).toBeVisible();
}

function linkOpenModifier(): 'Control' | 'Meta' {
  return process.platform === 'darwin' ? 'Meta' : 'Control';
}

async function setDiscardPromptAction(
  electronApp: ElectronApplication,
  action: 'cancel' | 'discard'
): Promise<void> {
  await electronApp.evaluate((_app, nextAction) => {
    const state = globalThis as typeof globalThis & { __stage5DiscardPromptResponse?: number };
    state.__stage5DiscardPromptResponse = nextAction === 'discard' ? 1 : 0;
  }, action);
}

async function setOpenDialogCanceled(electronApp: ElectronApplication, canceled: boolean): Promise<void> {
  await electronApp.evaluate((_app, nextCanceled) => {
    const state = globalThis as typeof globalThis & { __stage5OpenDialogCanceled?: boolean };
    state.__stage5OpenDialogCanceled = nextCanceled;
  }, canceled);
}

async function expectDiscardPromptCount(electronApp: ElectronApplication, expected: number): Promise<void> {
  await expect
    .poll(() =>
      electronApp.evaluate(() => {
        const state = globalThis as typeof globalThis & { __stage5DiscardPromptCount?: number };
        return state.__stage5DiscardPromptCount ?? 0;
      })
    )
    .toBe(expected);
}

async function makeDirtyDraftWithLocalLink(page: Page): Promise<void> {
  await page.getByRole('button', { name: /源码|Source/ }).click();
  await expect(page.getByTestId('source-editor')).toBeVisible();
  await page.getByTestId('source-editor').fill(`# 入口草稿

未保存内容。

[下一篇](下一篇.md)
`);
  await expect(page.locator('.save-badge.dirty')).toBeVisible();
  await page.getByRole('button', { name: /富文本|Rich/ }).click();
  await expect(page.getByTestId('markdown-body')).toBeVisible();
  await expect(page.locator('.markdown-body h1')).toHaveText('入口草稿');
  await expect(page.getByRole('link', { name: '下一篇' })).toBeVisible();
}

async function makeDirtyDraftWithEncodedLocalLink(
  page: Page,
  heading: string,
  linkName: string,
  href: string
): Promise<void> {
  await page.getByRole('button', { name: /源码|Source/ }).click();
  await expect(page.getByTestId('source-editor')).toBeVisible();
  await page.getByTestId('source-editor').fill(`# ${heading}

未保存内容。

[${linkName}](${href})
`);
  await expect(page.locator('.save-badge.dirty')).toBeVisible();
  await page.getByRole('button', { name: /富文本|Rich/ }).click();
  await expect(page.getByTestId('markdown-body')).toBeVisible();
  await expect(page.locator('.markdown-body h1')).toHaveText(heading);
  await expect(page.getByTestId('markdown-body').getByRole('link', { name: linkName })).toBeVisible();
}

async function makeDirtyDraftWithMissingLocalLink(page: Page): Promise<void> {
  await page.getByRole('button', { name: /源码|Source/ }).click();
  await expect(page.getByTestId('source-editor')).toBeVisible();
  await page.getByTestId('source-editor').fill(`# 缺失链接草稿

未保存内容。

[缺失篇](missing.md)
`);
  await expect(page.locator('.save-badge.dirty')).toBeVisible();
  await page.getByRole('button', { name: /富文本|Rich/ }).click();
  await expect(page.getByTestId('markdown-body')).toBeVisible();
  await expect(page.locator('.markdown-body h1')).toHaveText('缺失链接草稿');
  await expect(page.getByTestId('markdown-body').getByRole('link', { name: '缺失篇' })).toBeVisible();
}

async function makeDirtyDraftWithUnsupportedLinks(page: Page): Promise<void> {
  await page.getByRole('button', { name: /源码|Source/ }).click();
  await expect(page.getByTestId('source-editor')).toBeVisible();
  await page.getByTestId('source-editor').fill(`# 非 Markdown 链接草稿

未保存内容。

## Section

[页内锚点](#section)

[普通文本](notes.txt)

[邮件链接](mailto:test@example.com)
`);
  await expect(page.locator('.save-badge.dirty')).toBeVisible();
  await page.getByRole('button', { name: /富文本|Rich/ }).click();
  await expect(page.getByTestId('markdown-body')).toBeVisible();
  await expect(page.locator('.markdown-body h1')).toHaveText('非 Markdown 链接草稿');
  await expect(page.getByTestId('markdown-body').getByRole('link', { name: '页内锚点' })).toBeVisible();
  await expect(page.getByTestId('markdown-body').getByRole('link', { name: '普通文本' })).toBeVisible();
  await expect(page.getByTestId('markdown-body').getByRole('link', { name: '邮件链接' })).toBeVisible();
}

async function createFileDataTransfer(page: Page, filePath: string) {
  await page.evaluate(() => {
    document.getElementById('stage5-drag-source')?.remove();
    const input = document.createElement('input');
    input.id = 'stage5-drag-source';
    input.type = 'file';
    input.style.display = 'none';
    document.body.append(input);
  });
  await page.locator('#stage5-drag-source').setInputFiles(filePath);

  return page.evaluateHandle(() => {
    const input = document.querySelector<HTMLInputElement>('#stage5-drag-source');
    const transfer = new DataTransfer();
    const file = input?.files?.item(0);
    if (file) {
      transfer.items.add(file);
    }
    return transfer;
  });
}

async function dropMarkdownFile(page: Page, filePath: string): Promise<void> {
  const dataTransfer = await createFileDataTransfer(page, filePath);
  await page.dispatchEvent('[data-testid="app-shell"]', 'drop', { dataTransfer });
  await dataTransfer.dispose();
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
        'Open File': ['Open File', '打开文件']
      };
      const normalize = (value: string) => value.replaceAll('&', '').replace(/\([^)]*\)$/, '');
      const candidatesFor = (value: string) => aliases[value] ?? [value];
      const menu = Menu.getApplicationMenu();
      const topLevel = menu?.items.find((item) => candidatesFor(labels.topLevelLabel).includes(normalize(item.label)));
      const target = topLevel?.submenu?.items.find((item) => candidatesFor(labels.itemLabel).includes(normalize(item.label)));
      if (!target) throw new Error(`Missing menu item: ${labels.topLevelLabel} -> ${labels.itemLabel}`);
      (target.click as (...args: unknown[]) => void)(target, BrowserWindow.getFocusedWindow(), undefined);
    },
    { topLevelLabel, itemLabel }
  );
}

test('resolves local images, reports missing images, and opens links through safe routes', async () => {
  const fixture = await createResourceFixture();
  const electronApp = await launchWithSelectedFile(fixture.documentPath);
  const page = await electronApp.firstWindow();

  await openFixture(page);

  await expect(page.locator('.markdown-body img[alt="有效图片"]')).toHaveAttribute(
    'src',
    /^data:image\/png;base64,/
  );
  await expect(page.getByTestId('missing-image')).toContainText('missing.png');

  const initialUrl = page.url();

  // 1. Ctrl/Cmd-click external link to trigger confirmation modal
  await page.getByRole('link', { name: '外部链接' }).click({ modifiers: [linkOpenModifier()] });
  expect(page.url()).toBe(initialUrl);

  // Verify safety modal is visible
  await expect(page.getByRole('heading', { name: '安全提示' })).toBeVisible();
  await expect(page.locator('.target-url-text')).toContainText('https://example.com/docs');

  // 2. Click "取消" (Cancel)
  await page.getByRole('button', { name: '取消' }).click();
  await expect(page.getByRole('heading', { name: '安全提示' })).not.toBeVisible();

  // Check that external link was NOT opened
  let openedUrl = await electronApp.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      __stage5OpenedExternal?: string;
    };
    return state.__stage5OpenedExternal;
  });
  expect(openedUrl).toBeUndefined();

  // 3. Ctrl/Cmd-click external link again
  await page.getByRole('link', { name: '外部链接' }).click({ modifiers: [linkOpenModifier()] });
  await expect(page.getByRole('heading', { name: '安全提示' })).toBeVisible();

  // Click "继续访问" (Confirm/Proceed)
  await page.getByRole('button', { name: '继续访问' }).click();
  await expect(page.getByRole('heading', { name: '安全提示' })).not.toBeVisible();

  // Verify external link WAS opened
  await expect
    .poll(() =>
      electronApp.evaluate(() => {
        const state = globalThis as typeof globalThis & {
          __stage5OpenedExternal?: string;
        };
        return state.__stage5OpenedExternal;
      })
    )
    .toBe('https://example.com/docs');

  await expect(page.getByTestId('markdown-body')).toContainText('危险链接');
  const dangerousMarkup = await page.getByTestId('markdown-body').evaluate((element) => element.innerHTML);
  expect(dangerousMarkup).not.toContain('href="javascript:');
  const dangerousResult = await page.evaluate(
    (documentPath) => window.mdViewer.openMarkdownLink(documentPath, 'javascript:window.__stage5Bad = 1'),
    fixture.documentPath
  );
  expect(dangerousResult).toEqual({
    ok: false,
    code: 'DANGEROUS_PROTOCOL',
    message: '已阻止不安全链接。'
  });
  const dangerousState = await page.evaluate(
    () => (globalThis as typeof globalThis & { __stage5Bad?: unknown }).__stage5Bad
  );
  expect(dangerousState).toBeUndefined();

  await page.getByTestId('markdown-body').getByRole('link', { name: '下一篇' }).click({
    modifiers: [linkOpenModifier()]
  });
  await expect(page.locator('.markdown-body h1')).toHaveText('下一篇');
  await expect(page.getByTestId('status-file-name')).toContainText('下一篇.md');

  await electronApp.close();
});

test('asks before replacing a dirty document from a local Markdown link', async () => {
  const fixture = await createResourceFixture();
  const electronApp = await launchWithSelectedFile(fixture.documentPath);
  const page = await electronApp.firstWindow();

  await openFixture(page);
  await makeDirtyDraftWithLocalLink(page);

  await setDiscardPromptAction(electronApp, 'cancel');
  await page.getByTestId('markdown-body').getByRole('link', { name: '下一篇' }).click({
    modifiers: [linkOpenModifier()]
  });

  await expectDiscardPromptCount(electronApp, 1);
  await expect(page.locator('.markdown-body h1')).toHaveText('入口草稿');
  await expect(page.getByTestId('status-file-name')).toContainText('入口 文档.md');
  await expect(page.getByTestId('status-file-path')).toHaveText(fixture.documentPath);
  await expect(page.locator('.save-badge.dirty')).toBeVisible();

  await setDiscardPromptAction(electronApp, 'discard');
  await page.getByTestId('markdown-body').getByRole('link', { name: '下一篇' }).click({
    modifiers: [linkOpenModifier()]
  });

  await expectDiscardPromptCount(electronApp, 2);
  await expect(page.locator('.markdown-body h1')).toHaveText('下一篇');
  await expect(page.getByTestId('status-file-name')).toContainText('下一篇.md');
  await expect(page.getByTestId('status-file-path')).toHaveText(fixture.linkedPath);
  await expect(page.locator('.save-badge.saved')).toBeVisible();

  await electronApp.close();
});

test('asks before replacing a dirty document from URL-encoded Markdown links', async () => {
  const scenarios = [
    {
      heading: '编码 md 草稿',
      linkName: '编码下一篇',
      href: '%E4%B8%8B%E4%B8%80%E7%AF%87%2Emd?source=encoded#top',
      openedHeading: '下一篇',
      openedPath: (fixture: Stage5Fixture) => fixture.linkedPath
    },
    {
      heading: '编码 markdown 草稿',
      linkName: '编码附录',
      href: '%E9%99%84%E5%BD%95%2Emarkdown#top',
      openedHeading: '附录',
      openedPath: (fixture: Stage5Fixture) => fixture.linkedMarkdownPath
    }
  ];

  for (const scenario of scenarios) {
    const fixture = await createResourceFixture();
    const electronApp = await launchWithSelectedFile(fixture.documentPath);
    const page = await electronApp.firstWindow();

    await openFixture(page);
    await makeDirtyDraftWithEncodedLocalLink(page, scenario.heading, scenario.linkName, scenario.href);

    await setDiscardPromptAction(electronApp, 'cancel');
    await page.getByTestId('markdown-body').getByRole('link', { name: scenario.linkName }).click({
      modifiers: [linkOpenModifier()]
    });

    await expectDiscardPromptCount(electronApp, 1);
    await expect(page.locator('.markdown-body h1')).toHaveText(scenario.heading);
    await expect(page.getByTestId('status-file-name')).toContainText('入口 文档.md');
    await expect(page.getByTestId('status-file-path')).toHaveText(fixture.documentPath);
    await expect(page.locator('.save-badge.dirty')).toBeVisible();

    await setDiscardPromptAction(electronApp, 'discard');
    await page.getByTestId('markdown-body').getByRole('link', { name: scenario.linkName }).click({
      modifiers: [linkOpenModifier()]
    });

    await expectDiscardPromptCount(electronApp, 2);
    await expect(page.locator('.markdown-body h1')).toHaveText(scenario.openedHeading);
    await expect(page.getByTestId('status-file-path')).toHaveText(scenario.openedPath(fixture));
    await expect(page.locator('.save-badge.saved')).toBeVisible();

    await electronApp.close();
  }
});

test('keeps unsaved protection when a dirty local Markdown link fails to open', async () => {
  const fixture = await createResourceFixture();
  const electronApp = await launchWithSelectedFile(fixture.documentPath);
  const page = await electronApp.firstWindow();

  await openFixture(page);
  await makeDirtyDraftWithMissingLocalLink(page);

  await setDiscardPromptAction(electronApp, 'discard');
  await page.getByTestId('markdown-body').getByRole('link', { name: '缺失篇' }).click({
    modifiers: [linkOpenModifier()]
  });

  await expect(page.getByTestId('save-error')).toContainText('文件不存在或已被移动。');
  await expectDiscardPromptCount(electronApp, 1);
  await expect(page.locator('.markdown-body h1')).toHaveText('缺失链接草稿');
  await expect(page.locator('.save-badge.dirty')).toBeVisible();

  await setDiscardPromptAction(electronApp, 'cancel');
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.close();
  });
  await expectDiscardPromptCount(electronApp, 2);
  await expect(page.locator('.markdown-body h1')).toHaveText('缺失链接草稿');

  await setDiscardPromptAction(electronApp, 'discard');
  await electronApp.close();
});

test('does not ask before reporting unsupported dirty draft links', async () => {
  const fixture = await createResourceFixture();
  const electronApp = await launchWithSelectedFile(fixture.documentPath);
  const page = await electronApp.firstWindow();

  await openFixture(page);
  await makeDirtyDraftWithUnsupportedLinks(page);

  for (const linkName of ['页内锚点', '普通文本', '邮件链接']) {
    await page.getByTestId('markdown-body').getByRole('link', { name: linkName }).click({
      modifiers: [linkOpenModifier()]
    });
    await expectDiscardPromptCount(electronApp, 0);
    await expect(page.getByTestId('save-error')).toContainText('只能打开 Markdown 链接或安全外部链接。');
    await expect(page.locator('.markdown-body h1')).toHaveText('非 Markdown 链接草稿');
    await expect(page.getByTestId('status-file-path')).toHaveText(fixture.documentPath);
    await expect(page.locator('.save-badge.dirty')).toBeVisible();
  }

  await setDiscardPromptAction(electronApp, 'discard');
  await electronApp.close();
});

test('does not mark a clean document dirty when a local Markdown link fails to open', async () => {
  const fixture = await createResourceFixture();
  const electronApp = await launchWithSelectedFile(fixture.documentPath);
  const page = await electronApp.firstWindow();

  await openFixture(page);
  await expect(page.locator('.save-badge.saved')).toBeVisible();
  await page.getByTestId('markdown-body').getByRole('link', { name: '缺失篇' }).click({
    modifiers: [linkOpenModifier()]
  });

  await expect(page.getByTestId('save-error')).toContainText('文件不存在或已被移动。');
  await expect(page.locator('.save-badge.saved')).toBeVisible();
  await expectDiscardPromptCount(electronApp, 0);

  await setDiscardPromptAction(electronApp, 'cancel');
  const pageClosed = page.waitForEvent('close');
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.close();
  });
  await pageClosed;
});

test('restores main unsaved protection when discarding then canceling the open file dialog', async () => {
  const fixture = await createResourceFixture();
  const electronApp = await launchWithSelectedFile(fixture.documentPath);
  const page = await electronApp.firstWindow();

  await openFixture(page);
  await makeDirtyDraftWithLocalLink(page);

  await setDiscardPromptAction(electronApp, 'discard');
  await setOpenDialogCanceled(electronApp, true);
  await clickNativeMenuItem(electronApp, 'File', 'Open File');

  await expectDiscardPromptCount(electronApp, 1);
  await expect(page.locator('.markdown-body h1')).toHaveText('入口草稿');
  await expect(page.getByTestId('status-file-path')).toHaveText(fixture.documentPath);
  await expect(page.locator('.save-badge.dirty')).toBeVisible();

  await setDiscardPromptAction(electronApp, 'cancel');
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.close();
  });

  await expectDiscardPromptCount(electronApp, 2);
  await expect(page.locator('.markdown-body h1')).toHaveText('入口草稿');

  await setDiscardPromptAction(electronApp, 'discard');
  await electronApp.close();
});

test('opens a dropped Markdown file through preload path extraction', async () => {
  const fixture = await createResourceFixture();
  const electronApp = await launchWithSelectedFile(fixture.documentPath);
  const page = await electronApp.firstWindow();

  await dropMarkdownFile(page, fixture.dragPath);

  await expect(page.locator('.markdown-body h1')).toHaveText('拖入文档');
  await expect(page.locator('.markdown-body img[alt="拖入图片"]')).toHaveAttribute(
    'src',
    /^data:image\/png;base64,/
  );
  await expect(page.getByTestId('status-file-name')).toContainText('拖入 文档.markdown');

  await electronApp.close();
});

test('asks before replacing a dirty document from a dropped Markdown file', async () => {
  const fixture = await createResourceFixture();
  const electronApp = await launchWithSelectedFile(fixture.documentPath);
  const page = await electronApp.firstWindow();

  await openFixture(page);
  await makeDirtyDraftWithLocalLink(page);

  await setDiscardPromptAction(electronApp, 'cancel');
  await dropMarkdownFile(page, fixture.dragPath);

  await expectDiscardPromptCount(electronApp, 1);
  await expect(page.locator('.markdown-body h1')).toHaveText('入口草稿');
  await expect(page.getByTestId('status-file-name')).toContainText('入口 文档.md');
  await expect(page.getByTestId('status-file-path')).toHaveText(fixture.documentPath);
  await expect(page.locator('.save-badge.dirty')).toBeVisible();

  await setDiscardPromptAction(electronApp, 'discard');
  await dropMarkdownFile(page, fixture.dragPath);

  await expectDiscardPromptCount(electronApp, 2);
  await expect(page.locator('.markdown-body h1')).toHaveText('拖入文档');
  await expect(page.locator('.markdown-body img[alt="拖入图片"]')).toHaveAttribute(
    'src',
    /^data:image\/png;base64,/
  );
  await expect(page.getByTestId('status-file-name')).toContainText('拖入 文档.markdown');
  await expect(page.getByTestId('status-file-path')).toHaveText(fixture.dragPath);
  await expect(page.locator('.save-badge.saved')).toBeVisible();

  await electronApp.close();
});
