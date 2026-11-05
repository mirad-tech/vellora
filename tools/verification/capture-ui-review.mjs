/**
 * Capture the actual Vellora frontend in Chrome with a fixture-only Tauri bridge.
 * Run this script from the review checkout for both revisions so they share the
 * same fixture, browser, and viewport. This does not verify the native backend.
 *
 * VELLORA_UI_REVIEW_ROOT: source checkout to serve (defaults to this repository)
 * VELLORA_UI_REVIEW_LABEL: before | after (defaults to after)
 * VELLORA_UI_REVIEW_OUTPUT: output parent (defaults to artifacts/ui-review)
 * BROWSER_PATH: optional explicit Chrome executable
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';

const reviewRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoot = path.resolve(process.env.VELLORA_UI_REVIEW_ROOT || reviewRoot);
const label = process.env.VELLORA_UI_REVIEW_LABEL || 'after';
if (!['before', 'after'].includes(label)) {
  throw new Error('VELLORA_UI_REVIEW_LABEL must be before or after.');
}
const outputRoot = process.env.VELLORA_UI_REVIEW_OUTPUT
  ? path.resolve(process.env.VELLORA_UI_REVIEW_OUTPUT)
  : path.join(reviewRoot, 'artifacts/ui-review');
const outputDir = path.join(outputRoot, label);
const fixturePath = path.join(reviewRoot, 'tests/fixtures/markdown/06-ui-polish.md');
const documentName = 'Vellora 界面精修与交互验收——这是一份包含长中文文件名的工作区设计说明.md';
const saveError = '无法保存这份文档。目标文件可能正被其他程序使用，或者文件夹权限已发生变化。当前编辑内容仍保留，请关闭占用文件的程序或检查保存位置后重试。';
const at = (testId) => `[data-testid="${testId}"]`;
const defaultViewport = { width: 820, height: 900, deviceScaleFactor: 1 };

function findBrowser() {
  const candidates = process.env.BROWSER_PATH
    ? [process.env.BROWSER_PATH]
    : [
        ...['ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA']
          .filter((name) => process.env[name])
          .map((name) => path.join(process.env[name], 'Google', 'Chrome', 'Application', 'chrome.exe')),
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium'
      ];
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) throw new Error('Google Chrome not found. Set BROWSER_PATH to a Chrome executable.');
  return executable;
}

// Matches the bridge conventions used by tests/e2e/smoke.mjs. Every file and
// native action is synthetic; external navigation is recorded, never opened.
async function installMocks(page, fixture) {
  await page.evaluateOnNewDocument((doc) => {
    const state = { document: { ...doc }, saved: doc.content };
    const handlers = new Map();
    let nextId = 1;
    const invoke = async (command, args = {}) => {
      if (command === 'plugin:event|listen') {
        const id = nextId++;
        handlers.set(id, { event: args.event, handler: args.handler });
        return id;
      }
      if (command === 'plugin:event|unlisten') {
        handlers.delete(args.eventId);
        return null;
      }
      if (command === 'get_initial_document') {
        return { ok: false, code: 'NO_INITIAL', message: '没有初始文档。' };
      }
      if (command === 'set_unsaved_changes') return { ok: true };
      if (command === 'confirm_close') {
        window.__e2eConfirmCloseCalls = [...(window.__e2eConfirmCloseCalls || []), args.allow];
        return { ok: true };
      }
      if (command === 'choose_markdown_file' || command === 'open_markdown_file') {
        return { ok: true, document: { ...state.document, content: state.saved } };
      }
      if (command === 'save_markdown_file') {
        if (window.__e2eSaveFailureMessage) {
          return { ok: false, code: 'SAVE_FAILED', message: window.__e2eSaveFailureMessage };
        }
        state.saved = args.content ?? state.saved;
        state.document = { ...state.document, content: state.saved };
        window.__e2eSavedContent = state.saved;
        return { ok: true, document: state.document };
      }
      if (command === 'resolve_local_image') {
        return { ok: false, code: 'IMAGE_NOT_FOUND', message: '图片不存在或已被移动。' };
      }
      if (command === 'inspect_markdown_link') {
        const href = args.href || '';
        return /^https?:\/\//.test(href)
          ? { ok: true, action: 'external', url: href }
          : { ok: false, code: 'UNSUPPORTED_LINK', message: '只能打开 Markdown 链接或安全外部链接。' };
      }
      if (command === 'open_external_url') {
        window.__e2eOpenedExternal = args.url;
        return { ok: true };
      }
      return { ok: false, code: 'UNKNOWN', message: `unmocked ${command}` };
    };
    window.__TAURI_INTERNALS__ = {
      invoke,
      transformCallback: (callback) => callback,
      unregisterCallback: () => undefined,
      plugins: {}
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };
    window.__TAURI__ = { core: { invoke }, event: { listen: async () => () => undefined } };
    window.__e2eEmitTauriEvent = (event, payload = null) => {
      let delivered = 0;
      for (const registration of handlers.values()) {
        if (registration.event === event) {
          registration.handler({ event, id: 0, payload });
          delivered += 1;
        }
      }
      return delivered;
    };
  }, fixture);
}

async function shortcut(page, key) {
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.down(modifier);
  try {
    await page.keyboard.press(key);
  } finally {
    await page.keyboard.up(modifier);
  }
}

async function openDocument(page) {
  await page.click(at('btn-open'));
  await page.waitForSelector(at('markdown-body'), { visible: true });
  await page.waitForSelector(at('missing-image'));
  await page.waitForFunction((name) => document.title.includes(name), {}, documentName);
}

async function makeDirtyDocument(page) {
  await openDocument(page);
  await page.click(at('btn-edit'));
  await page.waitForSelector(at('source-editor'), { visible: true });
  await page.focus(at('source-editor'));
  await page.$eval(at('source-editor'), (editor) => {
    editor.setSelectionRange(editor.value.length, editor.value.length);
  });
  await page.keyboard.type('\n\n验收草稿：这段内容尚未保存。\n');
  await page.waitForFunction(() => document.title.startsWith('•'));
  await page.click(at('btn-read'));
  await page.waitForSelector(at('markdown-body'), { visible: true });
  await page.$eval(at('content'), (content) => { content.scrollTop = 0; });
}

async function settleRendering(page) {
  await page.mouse.move(0, 0);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(requestAnimationFrame);
    const animations = document.getAnimations().filter((animation) =>
      animation.effect?.getComputedTiming().iterations !== Infinity
    );
    await Promise.allSettled(animations.map((animation) => animation.finished));
    await new Promise(requestAnimationFrame);
  });
}

async function readMetrics(page) {
  return page.evaluate(() => {
    const describe = (selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) return null;
      const rect = element.getBoundingClientRect();
      const css = getComputedStyle(element);
      return {
        x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        fontFamily: css.fontFamily, fontSize: css.fontSize, fontWeight: css.fontWeight,
        lineHeight: css.lineHeight, letterSpacing: css.letterSpacing,
        padding: css.padding, boxSizing: css.boxSizing, whiteSpace: css.whiteSpace,
        overflowWrap: css.overflowWrap, wordBreak: css.wordBreak,
        overflowX: css.overflowX,
        horizontalOverflow: Math.max(0, element.scrollWidth - element.clientWidth)
      };
    };
    return {
      viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio },
      title: document.title,
      focus: document.activeElement?.getAttribute('data-testid') || document.activeElement?.tagName,
      fontsReady: document.fonts.status,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      overflow: {
        document: Math.max(0, document.documentElement.scrollWidth - innerWidth),
        body: Math.max(0, document.body.scrollWidth - document.body.clientWidth)
      },
      elements: Object.fromEntries([
        'body', '.app-shell', '.toolbar', '.document-identity', '.document-name',
        '.main-row', '.content', '.markdown-body', '.source-editor', '.source-search-layer',
        '.outline-panel', '.search-bar', '.modal', '.app-feedback', '.document-status'
      ].map((selector) => [selector, describe(selector)])),
      searchCount: document.querySelector('[data-testid="search-count"]')?.textContent?.trim() || null
    };
  });
}

function scenarios() {
  return [
    ...[1280, 820, 640].map((width) => ({
      name: `document-${width}x900`, viewport: { ...defaultViewport, width }, prepare: openDocument
    })),
    { name: 'empty-820x900', prepare: async () => {} },
    {
      name: 'source-search-820x900',
      prepare: async (page) => {
        await openDocument(page);
        await page.click(at('btn-edit'));
        await page.waitForSelector(at('source-editor'), { visible: true });
        await shortcut(page, 'f');
        await page.waitForSelector(at('search-input'), { visible: true });
        await page.type(at('search-input'), 'Vellora');
        await page.waitForSelector('.source-search-hit', { visible: true });
      }
    },
    {
      name: 'outline-820x900',
      prepare: async (page) => {
        await openDocument(page);
        await page.click(at('btn-outline'));
        await page.waitForSelector(at('outline-item'), { visible: true });
      }
    },
    {
      name: 'external-820x900',
      prepare: async (page) => {
        await openDocument(page);
        await page.click('.markdown-body a[data-md-href="https://example.com/"]');
        await page.waitForSelector(at('external-link-modal'), { visible: true });
      }
    },
    {
      name: 'unsaved-820x900',
      prepare: async (page) => {
        await makeDirtyDocument(page);
        const delivered = await page.evaluate(() => window.__e2eEmitTauriEvent('close-requested'));
        if (!delivered) throw new Error('The existing close-requested listener was not registered.');
        await page.waitForSelector(at('discard-modal'), { visible: true });
      }
    },
    {
      name: 'error-820x900',
      prepare: async (page) => {
        await makeDirtyDocument(page);
        await page.evaluate((message) => { window.__e2eSaveFailureMessage = message; }, saveError);
        await shortcut(page, 's');
        await page.waitForFunction((message) =>
          [...document.querySelectorAll('[data-testid="app-feedback"], [data-testid="status-text"]')]
            .some((element) => element.textContent?.includes(message)), {}, saveError
        );
      }
    }
  ];
}

async function run() {
  fs.mkdirSync(outputDir, { recursive: true });
  const report = {
    label, sourceRoot, fixturePath, documentName, platform: process.platform,
    capturedAt: new Date().toISOString(),
    renderer: 'Chrome with mocked Tauri commands; not a native window',
    scenarios: [], errors: []
  };
  let browser;
  let server;
  try {
    const content = fs.readFileSync(fixturePath, 'utf8');
    report.fixtureSha256 = crypto.createHash('sha256').update(content).digest('hex');
    const fixture = {
      path: `C:\\ui-review\\${documentName}`, name: documentName, content,
      modifiedAt: Date.UTC(2026, 0, 1), size: Buffer.byteLength(content, 'utf8')
    };
    const executablePath = findBrowser();
    server = await createServer({
      root: sourceRoot, logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, strictPort: false, open: false }
    });
    await server.listen();
    const address = server.httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Vite did not expose a local TCP port.');
    const url = `http://127.0.0.1:${address.port}`;
    browser = await puppeteer.launch({
      executablePath, headless: true,
      args: process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : ['--disable-gpu']
    });
    report.browser = { executablePath, version: await browser.version(), userAgent: await browser.userAgent() };
    if (/\bEdg\//i.test(report.browser.userAgent) || !/\b(?:Chrome|HeadlessChrome)\//i.test(report.browser.userAgent)) {
      throw new Error(`UI review requires Chrome: ${report.browser.userAgent}`);
    }
    for (const scenario of scenarios()) {
      const page = await browser.newPage();
      const result = { name: scenario.name, errors: [], consoleErrors: [] };
      page.on('pageerror', (error) => result.errors.push(String(error)));
      page.on('console', (message) => {
        if (message.type() === 'error') result.consoleErrors.push(message.text());
      });
      try {
        page.setDefaultTimeout(15000);
        await page.setViewport(scenario.viewport || defaultViewport);
        await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
        await installMocks(page, fixture);
        await page.goto(url, { waitUntil: 'networkidle0' });
        await page.waitForSelector(at('empty-state'), { visible: true });
        await scenario.prepare(page);
        await settleRendering(page);
        Object.assign(result, await readMetrics(page));
        result.screenshot = `${scenario.name}.png`;
        await page.screenshot({ path: path.join(outputDir, result.screenshot), fullPage: false, captureBeyondViewport: false });
        console.log(`[${label}] captured ${result.screenshot}`);
      } catch (error) {
        result.errors.push(String(error));
        result.failureScreenshot = `${scenario.name}-failed.png`;
        await page.screenshot({ path: path.join(outputDir, result.failureScreenshot) }).catch(() => {
          delete result.failureScreenshot;
        });
      } finally {
        report.scenarios.push(result);
        await page.close();
      }
    }
  } catch (error) {
    report.errors.push(String(error));
  } finally {
    const cleanup = await Promise.allSettled([browser?.close(), server?.close()]);
    for (const result of cleanup) {
      if (result.status === 'rejected') report.errors.push(`Cleanup: ${String(result.reason)}`);
    }
    fs.writeFileSync(path.join(outputDir, 'metrics.json'), `${JSON.stringify(report, null, 2)}\n`);
  }
  const failures = [...report.errors, ...report.scenarios.flatMap((scenario) =>
    scenario.errors.map((error) => `${scenario.name}: ${error}`)
  )];
  if (failures.length) throw new Error(failures.join('\n'));
  console.log(`[${label}] ${report.scenarios.length} screenshots and metrics: ${outputDir}`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
