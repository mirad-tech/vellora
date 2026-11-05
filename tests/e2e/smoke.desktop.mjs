import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { waitFor } from './webdriver.mjs';

const at = id => '[data-testid="' + id + '"]';
const visible = (browser, selector) => browser.execute(target => {
  const element = document.querySelector(target);
  return !!(element && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
}, selector);
const show = (browser, id) => waitFor(id, () => visible(browser, at(id)));
const hide = (browser, id) => waitFor(id + ' to close', async () => !await visible(browser, at(id)));

export async function runDesktopSmoke(browser, { source, target, screenshotDirectory }) {
  const read = filename => fs.readFile(filename, 'utf8');
  const confirmSaved = (filename, text) => waitFor('saved Markdown bytes containing ' + text,
    async () => (await read(filename)).includes(text));
  const capture = async filename => {
    if (!screenshotDirectory) return;
    await waitFor('native rendering to settle', () => browser.execute(() => document.fonts.status === 'loaded' &&
      document.getAnimations().every(animation => animation.effect?.getComputedTiming().iterations === Infinity ||
        (animation.playState !== 'running' && !animation.pending))));
    const screenshot = Buffer.from(await browser.screenshot(), 'base64');
    assert.equal(screenshot.subarray(1, 4).toString(), 'PNG');
    await fs.mkdir(screenshotDirectory, { recursive: true });
    await fs.writeFile(path.join(screenshotDirectory, filename + '.png'), screenshot);
  };
  const controlClick = fragment => browser.controlClick('.document-editor a[data-md-href="' + fragment + '"]');
  const writeInput = (selector, value) => browser.execute((target, text) => {
    const input = document.querySelector(target);
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, selector, value);
  const setSource = async content => {
    await browser.click(at('btn-edit'));
    await show(browser, 'source-editor');
    await writeInput(at('source-editor'), content);
  };
  const clickDialogButton = text => browser.execute(label => {
    const button = Array.from(document.querySelectorAll('[role="dialog"] button'))
      .find(element => element.textContent.trim() === label && !element.disabled);
    if (!button) throw new Error('Dialog action is missing: ' + label);
    button.click();
  }, text);

  await show(browser, 'markdown-body');
  const startup = await browser.execute(() => ({
    title: document.title, tauri: window.isTauri, url: location.href, hasFixture: '__velloraE2e' in window
  }));
  assert.ok(startup.tauri && !startup.hasFixture && startup.title.includes(path.basename(source)), JSON.stringify(startup));
  assert.match(startup.url, /^(?:https?:\/\/tauri\.localhost|tauri:\/\/localhost)\//);
  await capture('01-document');

  await browser.click('.document-editor h1');
  await browser.press('\uE010');
  await browser.type(' E2E direct');
  await waitFor('the direct edit to enable Save', () => browser.execute(selector => !document.querySelector(selector)?.disabled, at('btn-save')));
  await browser.click(at('btn-save'));
  await confirmSaved(source, 'E2E direct');

  await setSource((await read(source)) + '\r\n\r\nE2E source draft');
  await capture('02-source-dirty');
  await browser.shortcut('s');
  await confirmSaved(source, '\r\n\r\nE2E source draft');

  const lastSave = await read(source);
  await setSource(lastSave + '\r\n\r\nE2E kept draft');
  await browser.click(at('btn-read'));
  await controlClick('./target.md');
  await show(browser, 'discard-modal');
  await capture('03-unsaved-confirmation');
  await browser.click(at('discard-cancel'));
  await hide(browser, 'discard-modal');
  assert.equal(await read(source), lastSave);

  const targetContents = await read(target);
  await controlClick('./target.md');
  await show(browser, 'discard-modal');
  await fs.unlink(target);
  await browser.click(at('discard-confirm'));
  await waitFor('a failed link to report an error', () => browser.execute(() =>
    Array.from(document.querySelectorAll('[data-testid="app-feedback"], [data-testid="status-text"]'))
      .some(element => /不存在|失败|找不到/.test(element.textContent))
  ));
  await browser.click(at('btn-save'));
  await confirmSaved(source, 'E2E kept draft');

  await fs.writeFile(target, targetContents);
  await controlClick('./target.md');
  await waitFor('the linked document to open', () => browser.execute(name => document.title.includes(name), path.basename(target)));
  await browser.click(at('btn-search'));
  await show(browser, 'search-input');
  await writeInput(at('search-input'), '链接跳转');
  await waitFor('a visible search match', () => visible(browser, '.document-editor .search-hit'));
  await browser.click(at('btn-outline'));
  await show(browser, 'outline-item');
  await capture('04-search-and-outline');
  await browser.click(at('btn-outline'));
  await browser.click(at('search-close'));

  await controlClick('https://example.com/path');
  await show(browser, 'external-link-modal');
  await capture('05-external-confirmation');
  await browser.click(at('external-cancel'));
  await hide(browser, 'external-link-modal');

  await setSource(targetContents + '\r\n\r\nE2E conflict draft');
  const diskChange = targetContents + '\r\n\r\nE2E external revision';
  await fs.writeFile(target, diskChange);
  await browser.click(at('btn-save'));
  await show(browser, 'conflict-modal');
  assert.equal(await read(target), diskChange);
  await capture('06-save-conflict');
  await clickDialogButton('覆盖外部版本');
  await clickDialogButton('确认覆盖');
  await confirmSaved(target, 'E2E conflict draft');
  await hide(browser, 'conflict-modal');

  console.log('[desktop E2E] PASS CLI open, visible save, source save, link recovery, search, outline, external cancel and disk conflict');
  return browser.execute(() => ({ width: innerWidth, height: innerHeight, devicePixelRatio }));
}
