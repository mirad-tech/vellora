/**
 * Desktop E2E against release binary (see wdio.desktop.conf.js).
 * Same scenarios as browser-mode smoke; uses real IPC where possible.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sampleContent =
  '# 标题一\n\n正文搜索词 hello\n\n## 标题二\n\n[外链](https://example.com/path)\n';

function writeTempMarkdown() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vellora-e2e-'));
  const filePath = path.join(dir, 'sample.md');
  fs.writeFileSync(filePath, sampleContent, 'utf8');
  return filePath;
}

async function waitForAppReady() {
  await $('[data-testid="app-shell"]').waitForDisplayed({ timeout: 60000 });
}

async function installBridge(filePath) {
  return browser.execute((p) => {
    const internals = window.__TAURI_INTERNALS__;
    if (!internals?.invoke) return { ok: false, reason: 'no-invoke' };
    if (!internals.__velloraOriginalInvoke) {
      internals.__velloraOriginalInvoke = internals.invoke.bind(internals);
    }
    const original = internals.__velloraOriginalInvoke;
    internals.invoke = async (cmd, args) => {
      if (cmd === 'choose_markdown_file') {
        return original('open_markdown_file', { path: p });
      }
      if (cmd === 'open_external_url') return { ok: true };
      return original(cmd, args);
    };
    return { ok: true };
  }, filePath);
}

async function openSample() {
  const openBtn = await $('[data-testid="btn-open"]');
  await openBtn.click();
  const discard = await $('[data-testid="discard-modal"]');
  if (await discard.isDisplayed().catch(() => false)) {
    await $('[data-testid="discard-confirm"]').click();
    await openBtn.click();
  }
  await $('[data-testid="markdown-body"]').waitForDisplayed({ timeout: 20000 });
}

describe('Vellora 2.0 desktop smoke', () => {
  let tempMd;

  before(async () => {
    tempMd = writeTempMarkdown();
    await waitForAppReady();
    const bridge = await installBridge(tempMd);
    if (!bridge?.ok) throw new Error(`bridge: ${bridge?.reason}`);
  });

  beforeEach(() => {
    fs.writeFileSync(tempMd, sampleContent, 'utf8');
  });

  after(() => {
    try {
      fs.unlinkSync(tempMd);
      fs.rmdirSync(path.dirname(tempMd));
    } catch {
      // ignore
    }
  });

  it('opens, edits, searches, outlines, and confirms external links', async () => {
    await openSample();
    expect(await $('[data-testid="markdown-body"]').getText()).toContain('标题一');

    await $('[data-testid="btn-edit"]').click();
    await (await $('[data-testid="source-editor"]')).setValue('# 保存测试\n');
    await $('[data-testid="btn-save"]').click();
    await browser.waitUntil(async () => fs.readFileSync(tempMd, 'utf8').includes('保存测试'), {
      timeout: 10000
    });

    fs.writeFileSync(tempMd, sampleContent, 'utf8');
    await openSample();
    await $('[data-testid="btn-search"]').click();
    await (await $('[data-testid="search-input"]')).setValue('搜索词');
    await browser.waitUntil(
      async () => (await $('[data-testid="search-count"]').getText()).includes('/'),
      { timeout: 8000 }
    );

    await $('[data-testid="btn-outline"]').click();
    expect((await $$('[data-testid="outline-item"]')).length).toBeGreaterThanOrEqual(1);

    const link = await $('[data-testid="markdown-body"] a');
    await link.click();
    await $('[data-testid="external-link-modal"]').waitForDisplayed({ timeout: 8000 });
    await $('[data-testid="external-cancel"]').click();
  });
});
