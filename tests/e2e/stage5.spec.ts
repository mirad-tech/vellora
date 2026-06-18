import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type Stage5Fixture = {
  documentPath: string;
  dragPath: string;
};

async function createResourceFixture(): Promise<Stage5Fixture> {
  const dir = join(tmpdir(), `md-viewer-stage5-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(join(dir, 'assets'), { recursive: true });

  const documentPath = join(dir, '入口 文档.md');
  const linkedPath = join(dir, '下一篇.md');
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

[下一篇](下一篇.md)
`,
    'utf8'
  );
  await writeFile(linkedPath, '# 下一篇\n\n本地链接打开成功。', 'utf8');
  await writeFile(dragPath, '# 拖入文档\n\n![拖入图片](assets/pixel.png)\n\n拖放打开成功。', 'utf8');

  return { documentPath, dragPath };
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
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [selectedPath],
        bookmarks: []
      });

      const state = globalThis as typeof globalThis & {
        __stage5OpenedExternal?: string;
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

  await page.getByRole('link', { name: '下一篇' }).click({ modifiers: [linkOpenModifier()] });
  await expect(page.locator('.markdown-body h1')).toHaveText('下一篇');
  await expect(page.getByTestId('status-file-name')).toContainText('下一篇.md');

  await electronApp.close();
});

test('opens a dropped Markdown file through preload path extraction', async () => {
  const fixture = await createResourceFixture();
  const electronApp = await launchWithSelectedFile(fixture.documentPath);
  const page = await electronApp.firstWindow();

  await page.evaluate(() => {
    const input = document.createElement('input');
    input.id = 'stage5-drag-source';
    input.type = 'file';
    input.style.display = 'none';
    document.body.append(input);
  });
  await page.locator('#stage5-drag-source').setInputFiles(fixture.dragPath);

  const dataTransfer = await page.evaluateHandle(() => {
    const input = document.querySelector<HTMLInputElement>('#stage5-drag-source');
    const transfer = new DataTransfer();
    const file = input?.files?.item(0);
    if (file) {
      transfer.items.add(file);
    }
    return transfer;
  });

  await page.dispatchEvent('[data-testid="app-shell"]', 'drop', { dataTransfer });

  await expect(page.locator('.markdown-body h1')).toHaveText('拖入文档');
  await expect(page.locator('.markdown-body img[alt="拖入图片"]')).toHaveAttribute(
    'src',
    /^data:image\/png;base64,/
  );
  await expect(page.getByTestId('status-file-name')).toContainText('拖入 文档.markdown');

  await electronApp.close();
});
