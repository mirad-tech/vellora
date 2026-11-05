import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { launchChromium } from './tooling/chromium.mjs';

export const repository = fileURLToPath(new URL('../../', import.meta.url));
export const fixturePath = path.join(repository, 'tests/fixtures/markdown/06-ui-polish.md');
export const defaultViewport = { width: 820, height: 900, deviceScaleFactor: 1 };
export const fixtureName = 'Vellora 界面精修与交互验收——这是一份包含长中文文件名的工作区设计说明.md';
export const at = testId => '[data-testid="' + testId + '"]';
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

export async function withBrowser(sourceRoot, useBrowser) {
  const server = await createServer({
    root: sourceRoot,
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: false, open: false, hmr: false, watch: null }
  });
  let browser;
  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Vite did not open a test port.');
    browser = await launchChromium();
    return await useBrowser(browser, 'http://127.0.0.1:' + address.port);
  } finally {
    try { await browser?.close(); } finally { await server.close(); }
  }
}

// Installed only on disposable pages by Puppeteer before the application boots.
async function installFixture(page) {
  const content = fs.readFileSync(fixturePath, 'utf8');
  const fixture = {
    path: 'C:\\vellora-ui-e2e\\' + fixtureName,
    name: fixtureName,
    content,
    modifiedAt: Date.UTC(2026, 0, 1),
    size: Buffer.byteLength(content, 'utf8')
  };
  await page.evaluateOnNewDocument(document => {
    const handlers = new Map();
    const test = {
      document, saveError: null, saved: null, dirty: false, external: [], close: [],
      emit(event, payload = null) {
        let delivered = 0;
        for (const [id, listener] of handlers) {
          if (listener.event === event) {
            listener.handler({ event, id, payload });
            delivered++;
          }
        }
        return delivered;
      }
    };
    let eventId = 0;
    window.__velloraE2e = test;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };
    window.__TAURI_INTERNALS__ = {
      transformCallback: callback => callback,
      unregisterCallback: () => undefined,
      async invoke(command, args = {}) {
        switch (command) {
          case 'plugin:event|listen':
            handlers.set(++eventId, args);
            return eventId;
          case 'plugin:event|unlisten':
            handlers.delete(args.eventId);
            return null;
          case 'get_initial_document':
            return { ok: false, code: 'NO_INITIAL', message: '没有初始文档。' };
          case 'choose_markdown_file':
          case 'open_markdown_file':
            return { ok: true, document: { ...test.document } };
          case 'set_unsaved_changes':
            test.dirty = args.value;
            return { ok: true };
          case 'confirm_close':
            test.close.push(args.allow);
            return { ok: true };
          case 'save_markdown_file':
            if (args.path !== test.document.path) {
              return { ok: false, code: 'SESSION_MISMATCH', message: '文档会话不匹配。' };
            }
            if (test.saveError) return { ok: false, code: 'SAVE_FAILED', message: test.saveError };
            test.saved = args.content;
            test.document = {
              ...test.document, content: args.content, modifiedAt: Date.now(),
              size: new TextEncoder().encode(args.content).length
            };
            return { ok: true, document: { ...test.document } };
          case 'resolve_local_image':
            return { ok: false, code: 'IMAGE_NOT_FOUND', message: '图片不存在或已被移动。' };
          case 'inspect_markdown_link':
            return /^https?:\/\//i.test(args.href)
              ? { ok: true, action: 'external', url: args.href }
              : { ok: false, code: 'UNSUPPORTED_LINK', message: '无法打开这个链接。' };
          case 'open_external_url':
            test.external.push(args.url);
            return { ok: true };
          default:
            throw new Error('Missing fixture response for ' + command);
        }
      }
    };
  }, fixture);
}

export async function fixturePage(browser, url, viewport = defaultViewport) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const location = message.location().url;
    // Chromium requests a web favicon automatically. Vellora supplies a native app icon.
    if (location === new URL('/favicon.ico', url).href && message.text().includes('404')) return;
    errors.push((location || '(page)') + ': ' + message.text());
  });
  try {
    page.setDefaultTimeout(15_000);
    await page.setViewport(viewport);
    await installFixture(page);
    await page.goto(url, { waitUntil: 'networkidle0' });
    await page.waitForSelector(at('empty-state'), { visible: true });
    return { page, errors };
  } catch (error) {
    await page.close();
    throw error;
  }
}

export async function chord(page, action) {
  await page.keyboard.down(modifier);
  try { await action(); } finally { await page.keyboard.up(modifier); }
}

export function shortcut(page, key) {
  return chord(page, () => page.keyboard.press(key));
}

export async function openFixture(page) {
  await page.click(at('btn-open'));
  await page.waitForSelector(at('markdown-body'), { visible: true });
  await page.waitForSelector(at('missing-image'), { visible: true });
  await page.waitForFunction(name => document.title.includes(name), {}, fixtureName);
}

export async function appendSourceDraft(page, text) {
  await page.click(at('btn-edit'));
  await page.waitForSelector(at('source-editor'), { visible: true });
  await page.focus(at('source-editor'));
  await page.$eval(at('source-editor'), source => source.setSelectionRange(source.value.length, source.value.length));
  await page.keyboard.type(text);
  await page.waitForFunction(() => document.title.startsWith('•'));
}

export async function openFixtureExternalLink(page) {
  const selector = '.markdown-body a[data-md-href="https://example.com/"]';
  if (await page.$('.document-editor')) await chord(page, () => page.click(selector));
  else await page.click(selector);
  await page.waitForSelector(at('external-link-modal'), { visible: true });
}

export async function settleRendering(page) {
  await page.mouse.move(0, 0);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(requestAnimationFrame);
    const animations = document.getAnimations().filter(animation =>
      animation.effect?.getComputedTiming().iterations !== Infinity
    );
    await Promise.allSettled(animations.map(animation => animation.finished));
    await new Promise(requestAnimationFrame);
  });
}
