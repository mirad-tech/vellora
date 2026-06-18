import { expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function createMarkdownFixture(name: string, content: string): Promise<string> {
  const dir = join(tmpdir(), `md-viewer-stage2-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, name);
  await writeFile(filePath, content, 'utf8');
  return filePath;
}

async function launchAppWithDialogFixture(filePath: string) {
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

test('renders Markdown structures in the Electron window', async () => {
  const filePath = await createMarkdownFixture(
    '结构 验证.md',
    `# 标题

正文段落。

> 引用

- 列表

| 列 | 值 |
| --- | --- |
| A | B |

\`\`\`ts
const ok: boolean = true;
\`\`\`
`
  );
  const electronApp = await launchAppWithDialogFixture(filePath);
  const page = await electronApp.firstWindow();

  await page.getByRole('button', { name: '打开文件', exact: true }).click();

  await expect(page.getByTestId('markdown-body')).toBeVisible();
  await expect(page.locator('.markdown-body h1')).toHaveText('标题');
  await expect(page.locator('.markdown-body blockquote')).toContainText('引用');
  await expect(page.locator('.markdown-body table')).toContainText('A');
  await expect(page.getByTestId('markdown-body')).toContainText('const ok: boolean = true;');
  await expect(page.getByTestId('markdown-body')).toContainText('TypeScript');

  await electronApp.close();
});

test('does not execute malicious HTML in the Electron renderer', async () => {
  const filePath = await createMarkdownFixture(
    '恶意 验证.md',
    `# 安全

<script>window.__mdViewerXss = 'script'</script>
<img src=x onerror="window.__mdViewerImgXss = 'img'">
<a href="javascript:window.__mdViewerLinkXss = 'link'" onclick="window.__mdViewerClickXss = 'click'">危险链接</a>
`
  );
  const electronApp = await launchAppWithDialogFixture(filePath);
  const page = await electronApp.firstWindow();

  await page.getByRole('button', { name: '打开文件', exact: true }).click();
  await expect(page.getByTestId('markdown-body')).toBeVisible();

  const xssState = await page.evaluate(() => {
    const rendererGlobal = globalThis as typeof globalThis & {
      __mdViewerXss?: unknown;
      __mdViewerImgXss?: unknown;
      __mdViewerLinkXss?: unknown;
      __mdViewerClickXss?: unknown;
      require?: unknown;
      process?: unknown;
    };

    return {
      script: rendererGlobal.__mdViewerXss,
      image: rendererGlobal.__mdViewerImgXss,
      link: rendererGlobal.__mdViewerLinkXss,
      click: rendererGlobal.__mdViewerClickXss,
      requireType: typeof rendererGlobal.require,
      processType: typeof rendererGlobal.process,
      html: document.querySelector('[data-testid="markdown-body"]')?.innerHTML ?? ''
    };
  });

  expect(xssState.script).toBeUndefined();
  expect(xssState.image).toBeUndefined();
  expect(xssState.link).toBeUndefined();
  expect(xssState.click).toBeUndefined();
  expect(xssState.requireType).toBe('undefined');
  expect(xssState.html).not.toContain('<script');
  expect(xssState.html).not.toContain('<img');
  expect(xssState.html).not.toContain('javascript:');
  expect(xssState.html).not.toContain('onclick');

  await electronApp.close();
});

test('shows an empty document state without crashing', async () => {
  const filePath = await createMarkdownFixture('空文件.md', '');
  const electronApp = await launchAppWithDialogFixture(filePath);
  const page = await electronApp.firstWindow();

  await page.getByRole('button', { name: '打开文件', exact: true }).click();

  await expect(page.getByTestId('markdown-empty')).toHaveText('文件为空');

  await electronApp.close();
});
