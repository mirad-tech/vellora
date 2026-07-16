/**
 * Real desktop E2E: no invoke mocks, no __TAURI_INTERNALS__ overrides.
 * App is launched with VELLORA_E2E_SOURCE as CLI arg (set by run-desktop.mjs).
 */
import fs from 'node:fs';

const sourcePath = process.env.VELLORA_E2E_SOURCE;
const targetPath = process.env.VELLORA_E2E_TARGET;

async function clickLinkByHrefFragment(fragment) {
  const anchors = await $$('[data-testid="markdown-body"] a');
  for (const a of anchors) {
    const href = (await a.getAttribute('data-md-href')) || (await a.getAttribute('href')) || '';
    if (href.includes(fragment)) {
      await a.click();
      return true;
    }
  }
  return false;
}

async function enterEditAndSetValue(value) {
  await $('[data-testid="btn-edit"]').click();
  const editor = await $('[data-testid="source-editor"]');
  await editor.waitForDisplayed({ timeout: 10000 });
  await editor.setValue(value);
  return editor;
}

async function setReactTextareaValue(selector, value) {
  await browser.execute((targetSelector, nextValue) => {
    const element = document.querySelector(targetSelector);
    if (!(element instanceof HTMLTextAreaElement)) {
      throw new Error(`textarea not found: ${targetSelector}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    descriptor?.set?.call(element, nextValue);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, selector, value);
}

describe('Vellora desktop E2E (real IPC)', () => {
  it('CLI open, quick edit, save, failed link, success link, search, outline, external cancel', async () => {
    expect(Boolean(sourcePath && fs.existsSync(sourcePath))).toBe(true);
    expect(Boolean(targetPath && fs.existsSync(targetPath))).toBe(true);

    // 1) Launch arg opens source.md
    const body = await $('[data-testid="markdown-body"]');
    await body.waitForDisplayed({ timeout: 60000 });
    expect(await body.getText()).toContain('源文档');

    // 2) Quick edit in read mode + save source on disk
    await $('[data-testid="markdown-body"] h1').click();
    const quickEditor = await $('[data-testid="quick-edit-textarea"]');
    await quickEditor.waitForDisplayed({ timeout: 10000 });
    await setReactTextareaValue(
      '[data-testid="quick-edit-textarea"]',
      '# 源文档（阅读模式修改）'
    );
    await $('[data-testid="btn-save"]').click();
    await browser.waitUntil(
      async () => fs.readFileSync(sourcePath, 'utf8').includes('阅读模式修改'),
      { timeout: 15000, timeoutMsg: 'quick edit was not saved to disk' }
    );

    // 3) Full source edit + save
    let sourceText = fs.readFileSync(sourcePath, 'utf8');
    await enterEditAndSetValue(sourceText.replace('正文搜索词 alpha', '正文搜索词 alpha 已保存'));
    await $('[data-testid="btn-save"]').click();
    await browser.waitUntil(async () => fs.readFileSync(sourcePath, 'utf8').includes('已保存'), {
      timeout: 15000,
      timeoutMsg: 'disk content not updated after save'
    });

    // 4) Dirty + local link + cancel discard: stay on source; save still works
    sourceText = fs.readFileSync(sourcePath, 'utf8');
    await enterEditAndSetValue(`${sourceText}\n草稿`);
    await $('[data-testid="btn-read"]').click();
    await body.waitForDisplayed();
    expect(await clickLinkByHrefFragment('target.md')).toBe(true);
    const discard = await $('[data-testid="discard-modal"]');
    await discard.waitForDisplayed({ timeout: 10000 });
    await $('[data-testid="discard-cancel"]').click();
    await discard.waitForDisplayed({ reverse: true, timeout: 5000 });

    await enterEditAndSetValue(`${fs.readFileSync(sourcePath, 'utf8')}\n草稿 再保存`);
    await $('[data-testid="btn-save"]').click();
    await browser.waitUntil(async () => fs.readFileSync(sourcePath, 'utf8').includes('再保存'), {
      timeout: 15000,
      timeoutMsg: 'save after cancel local-link failed (session mismatch?)'
    });

    // 4b) Dirty + delete target before discard confirm -> stay on source, can save
    sourceText = fs.readFileSync(sourcePath, 'utf8');
    const draftKeep = `${sourceText}\n失败跳转草稿`;
    await enterEditAndSetValue(draftKeep);
    await $('[data-testid="btn-read"]').click();
    await body.waitForDisplayed();
    expect(await clickLinkByHrefFragment('target.md')).toBe(true);
    await discard.waitForDisplayed({ timeout: 10000 });
    fs.unlinkSync(targetPath);
    await $('[data-testid="discard-confirm"]').click();
    // Should remain on source with draft
    await browser.waitUntil(
      async () => {
        const status = await $('[data-testid="status-text"]').getText();
        return status.includes('不存在') || status.includes('失败') || status.includes('找不到');
      },
      { timeout: 15000, timeoutMsg: 'expected open failure status message' }
    );
    await enterEditAndSetValue(draftKeep + ' 仍可保存');
    await $('[data-testid="btn-save"]').click();
    await browser.waitUntil(
      async () => fs.readFileSync(sourcePath, 'utf8').includes('仍可保存'),
      { timeout: 15000, timeoutMsg: 'save after failed open_markdown_link failed' }
    );

    // Recreate target for success path
    fs.writeFileSync(
      targetPath,
      '# 目标文档\n\n来自链接跳转。\n\n[外链](https://example.com/path)\n',
      'utf8'
    );

    // 5) Local link + 放弃更改 -> target.md
    sourceText = fs.readFileSync(sourcePath, 'utf8');
    await enterEditAndSetValue(`${sourceText}\n临时`);
    await $('[data-testid="btn-read"]').click();
    await body.waitForDisplayed();
    expect(await clickLinkByHrefFragment('target.md')).toBe(true);
    await discard.waitForDisplayed({ timeout: 10000 });
    await $('[data-testid="discard-confirm"]').click();
    await browser.waitUntil(async () => (await body.getText()).includes('目标文档'), {
      timeout: 20000,
      timeoutMsg: 'did not open target.md after discard'
    });

    // 6) Search + outline on target
    await $('[data-testid="btn-search"]').click();
    const input = await $('[data-testid="search-input"]');
    await input.waitForDisplayed();
    await input.setValue('链接跳转');
    await browser.waitUntil(
      async () => (await $('[data-testid="search-count"]').getText()).includes('/'),
      { timeout: 8000 }
    );

    await $('[data-testid="btn-outline"]').click();
    await $('[data-testid="outline-panel"]').waitForDisplayed();
    expect((await $$('[data-testid="outline-item"]')).length).toBeGreaterThanOrEqual(1);

    // 7) External link confirm + cancel
    expect(await clickLinkByHrefFragment('example.com')).toBe(true);
    const external = await $('[data-testid="external-link-modal"]');
    await external.waitForDisplayed({ timeout: 10000 });
    await $('[data-testid="external-cancel"]').click();
    await external.waitForDisplayed({ reverse: true, timeout: 5000 });
    expect(await body.getText()).toContain('目标文档');
  });
});
