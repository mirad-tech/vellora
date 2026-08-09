/**
 * Vellora browser E2E using a local Chromium browser + puppeteer-core.
 * Starts Vite, injects Tauri invoke mocks, exercises UI flows.
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import process from 'node:process';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');
const DEV_URL = 'http://127.0.0.1:1420';

const sampleDoc = {
  path: 'C:\\e2e\\sample.md',
  name: 'sample.md',
  content:
    '# 标题一\n\n正文搜索词 hello\n\n## 标题二\n\n###### 这是一个用于验证目录单行省略的非常长的六级标题\n\n[外链](https://example.com/path)\n',
  modifiedAt: Date.now(),
  size: 80
};

function findBrowser() {
  const candidates = [
    process.env.BROWSER_PATH,
    process.env.EDGE_PATH,
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium'
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p));
}

function waitForUrl(url, timeoutMs = 120000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) reject(new Error(`Dev server not ready: ${url}`));
        else setTimeout(tick, 400);
      });
    };
    tick();
  });
}

async function installMocks(page) {
  await page.evaluateOnNewDocument((doc) => {
    const state = { document: { ...doc }, saved: doc.content };
    const handler = async (cmd, args = {}) => {
      if (cmd === 'get_initial_document') {
        return { ok: false, code: 'NO_INITIAL', message: '没有初始文档。' };
      }
      if (cmd === 'set_unsaved_changes' || cmd === 'confirm_close') return { ok: true };
      if (cmd === 'choose_markdown_file' || cmd === 'open_markdown_file') {
        return {
          ok: true,
          document: { ...state.document, content: state.saved, modifiedAt: Date.now() }
        };
      }
      if (cmd === 'save_markdown_file') {
        state.saved = args.content ?? state.saved;
        state.document = { ...state.document, content: state.saved, modifiedAt: Date.now() };
        window.__e2eSavedContent = state.saved;
        return { ok: true, document: state.document };
      }
      if (cmd === 'resolve_local_image') {
        return { ok: false, code: 'IMAGE_NOT_FOUND', message: '图片不存在或已被移动。' };
      }
      if (cmd === 'inspect_markdown_link') {
        const href = args.href ?? '';
        if (href.startsWith('http://') || href.startsWith('https://')) {
          return { ok: true, action: 'external', url: href.endsWith('/') ? href : `${href}/` };
        }
        return { ok: false, code: 'UNSUPPORTED_LINK', message: '只能打开 Markdown 链接或安全外部链接。' };
      }
      if (cmd === 'open_external_url') {
        window.__e2eOpenedExternal = args.url;
        return { ok: true };
      }
      return { ok: false, code: 'UNKNOWN', message: `unmocked ${cmd}` };
    };

    window.__TAURI_INTERNALS__ = {
      invoke: handler,
      transformCallback: (cb) => cb,
      unregisterCallback: () => undefined,
      plugins: {}
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: () => undefined
    };
    window.__TAURI__ = {
      core: { invoke: handler },
      event: { listen: async () => () => undefined }
    };
  }, sampleDoc);
}

async function openSample(page) {
  await page.waitForSelector('[data-testid="btn-open"]');
  await page.click('[data-testid="btn-open"]');
  const discard = await page.$('[data-testid="discard-modal"]');
  if (discard) {
    await page.click('[data-testid="discard-confirm"]');
    await page.click('[data-testid="btn-open"]');
  }
  await page.waitForSelector('[data-testid="markdown-body"]', { timeout: 15000 });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertApprox(actual, expected, msg, tolerance = 0.05) {
  assert(Math.abs(actual - expected) <= tolerance, `${msg}: expected ${expected}, got ${actual}`);
}

function assertIntegerGeometry(metric, label) {
  for (const key of ['x', 'y', 'width', 'height']) {
    assertApprox(metric[key], Math.round(metric[key]), `${label} ${key} is pixel-aligned`);
  }
}

function relativeLuminance(color) {
  const value = color.trim();
  const channels = (value.startsWith('#')
    ? [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset + 1, offset + 3), 16))
    : (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number)
  )
    .map((channel) => channel / 255)
    .map((channel) =>
      channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    );
  assert(channels.length === 3 && channels.every(Number.isFinite), `unsupported color: ${color}`);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground, background) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

async function readVisualMetrics(page, selectors, variables = []) {
  return page.evaluate(
    ({ requestedSelectors, requestedVariables }) => {
      const elements = {};
      for (const selector of requestedSelectors) {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) {
          elements[selector] = null;
          continue;
        }
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        elements[selector] = {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          right: rect.right,
          bottom: rect.bottom,
          borderRadius: Number.parseFloat(style.borderTopLeftRadius),
          paddingLeft: Number.parseFloat(style.paddingLeft),
          paddingTop: Number.parseFloat(style.paddingTop),
          outlineWidth: Number.parseFloat(style.outlineWidth),
          outlineOffset: Number.parseFloat(style.outlineOffset),
          color: style.color,
          backgroundColor: style.backgroundColor,
          position: style.position
        };
      }

      const rootStyle = getComputedStyle(document.documentElement);
      const rootVariables = Object.fromEntries(
        requestedVariables.map((name) => [name, rootStyle.getPropertyValue(name).trim()])
      );
      return {
        elements,
        variables: rootVariables,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        overflowX: document.documentElement.scrollWidth - window.innerWidth
      };
    },
    { requestedSelectors: selectors, requestedVariables: variables }
  );
}

async function assertHoverVisual(
  page,
  selector,
  label,
  backgroundVariable = '--control-hover'
) {
  const readState = () =>
    page.$eval(selector, (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        borderRadius: Number.parseFloat(style.borderTopLeftRadius),
        color: style.color,
        backgroundColor: style.backgroundColor
      };
    });
  const before = await readState();
  await page.hover(selector);
  await new Promise((resolve) => setTimeout(resolve, 180));
  const after = await readState();
  const expectedBackground = await page.evaluate((variableName) => {
    const probe = document.createElement('span');
    probe.style.backgroundColor = `var(${variableName})`;
    document.body.append(probe);
    const resolved = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return resolved;
  }, backgroundVariable);

  for (const key of ['x', 'y', 'width', 'height']) {
    assertApprox(after[key], before[key], `${label} hover keeps ${key}`);
  }
  assertApprox(after.borderRadius, 6, `${label} hover radius`);
  assert(
    after.backgroundColor === expectedBackground,
    `${label} hover background: expected ${expectedBackground}, got ${after.backgroundColor}`
  );
  return after;
}

async function assertInsetHoverVisual(page, selector, label, expectedRadius = 6) {
  const readState = () =>
    page.$eval(selector, (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const insetStyle = getComputedStyle(element, '::before');
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        isolation: style.isolation,
        backgroundColor: style.backgroundColor,
        insetWidth: Number.parseFloat(insetStyle.width),
        insetHeight: Number.parseFloat(insetStyle.height),
        insetRadius: Number.parseFloat(insetStyle.borderTopLeftRadius),
        insetZIndex: insetStyle.zIndex,
        insetBackgroundColor: insetStyle.backgroundColor
      };
    });
  const before = await readState();
  await page.hover(selector);
  await new Promise((resolve) => setTimeout(resolve, 180));
  const after = await readState();
  const expectedBackground = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.backgroundColor = 'var(--control-hover)';
    document.body.append(probe);
    const resolved = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return resolved;
  });

  for (const key of ['x', 'y', 'width', 'height']) {
    assertApprox(after[key], before[key], `${label} hover keeps ${key}`);
  }
  assertApprox(after.width, 44, `${label} keeps its click width`);
  assertApprox(after.height, 44, `${label} keeps its click height`);
  assertApprox(after.insetWidth, 28, `${label} hover surface width`);
  assertApprox(after.insetHeight, 28, `${label} hover surface height`);
  assertApprox(after.insetRadius, expectedRadius, `${label} hover surface radius`);
  assert(after.isolation === 'isolate', `${label} keeps the inset background isolated`);
  assert(after.insetZIndex === '-1', `${label} keeps the × above the inset background`);
  assert(
    after.backgroundColor === 'rgba(0, 0, 0, 0)',
    `${label} outer click area stays transparent`
  );
  assert(
    after.insetBackgroundColor === expectedBackground,
    `${label} inset hover background: expected ${expectedBackground}, got ${after.insetBackgroundColor}`
  );
}

async function readToolbarLayout(page) {
  return page.evaluate(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) return null;
      const bounds = element.getBoundingClientRect();
      return { left: bounds.left, right: bounds.right };
    };
    return {
      leading: rect('.toolbar-leading'),
      toggle: rect('.mode-toggle'),
      actions: rect('.toolbar-actions'),
      overflowX: document.documentElement.scrollWidth - window.innerWidth
    };
  });
}

/** Set React-controlled textarea value so onChange/updateDraft runs. */
async function setTextareaValue(page, selector, value) {
  await page.$eval(
    selector,
    (el, v) => {
      const proto = window.HTMLTextAreaElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      desc?.set?.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    value
  );
}

async function pressModifierKey(page, key) {
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.down(modifier);
  await page.keyboard.press(key);
  await page.keyboard.up(modifier);
}

async function run() {
  const browserPath = findBrowser();
  if (!browserPath) throw new Error('Chromium browser not found. Set BROWSER_PATH or EDGE_PATH.');

  let browser;
  let dev;
  const failures = [];
  try {
    dev = await createServer({
      root,
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 1420, strictPort: true }
    });
    await dev.listen();
    await waitForUrl(DEV_URL);
    browser = await puppeteer.launch({
      executablePath: browserPath,
      headless: true,
      args: ['--no-sandbox', '--disable-gpu', '--window-size=1280,800']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    await installMocks(page);

    // 1 empty
    await page.goto(DEV_URL, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-testid="empty-state"]');
    const emptyText = await page.$eval('[data-testid="empty-state"]', (el) => el.textContent || '');
    assert(emptyText.includes('未打开文件'), 'empty state text');
    const emptyVisual = await readVisualMetrics(
      page,
      ['.toolbar', '.button--toolbar', '.mode-toggle', '.mode-btn', '.button--primary'],
      ['--faint', '--surface']
    );
    assert(emptyVisual.overflowX <= 0, 'desktop empty state has no horizontal overflow');
    assertApprox(emptyVisual.elements['.toolbar'].height, 48, 'toolbar height');
    assertApprox(emptyVisual.elements['.button--toolbar'].height, 32, 'toolbar button height');
    assertApprox(emptyVisual.elements['.button--toolbar'].borderRadius, 6, 'toolbar button radius');
    assertApprox(emptyVisual.elements['.mode-toggle'].height, 32, 'mode toggle height');
    assertApprox(emptyVisual.elements['.mode-toggle'].borderRadius, 8, 'mode toggle radius');
    assertApprox(emptyVisual.elements['.mode-btn'].height, 28, 'mode button height');
    assertApprox(emptyVisual.elements['.mode-btn'].borderRadius, 6, 'mode button radius');
    assertApprox(emptyVisual.elements['.button--primary'].height, 32, 'primary button height');
    assertIntegerGeometry(emptyVisual.elements['.button--toolbar'], 'toolbar button');
    assertIntegerGeometry(emptyVisual.elements['.mode-toggle'], 'mode toggle');
    assertIntegerGeometry(emptyVisual.elements['.mode-btn'], 'mode button');
    assert(
      contrastRatio(emptyVisual.variables['--faint'], emptyVisual.variables['--surface']) >= 4.5,
      'small status text contrast is at least 4.5:1'
    );
    await assertHoverVisual(page, '[data-testid="btn-open"]', 'toolbar button');
    await assertHoverVisual(page, '.button--primary', 'primary button', '--primary-hover');
    await page.keyboard.press('Tab');
    const focusedButton = await page.evaluate(
      () => document.activeElement?.getAttribute('data-testid') || ''
    );
    assert(focusedButton === 'btn-open', 'keyboard focus reaches the open button first');
    const focusVisual = await readVisualMetrics(page, ['[data-testid="btn-open"]']);
    assertApprox(focusVisual.elements['[data-testid="btn-open"]'].outlineWidth, 2, 'button focus ring');
    assertApprox(focusVisual.elements['[data-testid="btn-open"]'].outlineOffset, 2, 'button focus offset');

    // 2 open + render
    await openSample(page);
    const body1 = await page.$eval('[data-testid="markdown-body"]', (el) => el.textContent || '');
    assert(body1.includes('标题一'), 'render heading');
    const previewVisual = await readVisualMetrics(page, [
      '.markdown-body',
      '.mode-toggle',
      '[data-testid="btn-edit"]'
    ]);
    assertApprox(previewVisual.elements['.markdown-body'].width, 800, 'preview document width');
    assertApprox(previewVisual.elements['.markdown-body'].paddingLeft, 30, 'preview horizontal padding');
    assertApprox(previewVisual.elements['.markdown-body'].paddingTop, 44, 'preview top padding');
    assert(
      contrastRatio(
        previewVisual.elements['[data-testid="btn-edit"]'].color,
        previewVisual.elements['.mode-toggle'].backgroundColor
      ) >= 4.5,
      'inactive mode button text contrast is at least 4.5:1'
    );
    await assertHoverVisual(page, '[data-testid="btn-edit"]', 'mode button');

    // 3 quick edit in read mode + save through the existing draft flow
    await page.click('[data-testid="markdown-body"] h1');
    await page.waitForSelector('[data-testid="quick-edit-surface"]');
    const quickEditVisual = await readVisualMetrics(page, ['[data-testid="quick-edit-surface"]']);
    assertApprox(
      quickEditVisual.elements['[data-testid="quick-edit-surface"]'].outlineWidth,
      0,
      'quick edit has no gray outline'
    );
    await page.$eval('[data-testid="quick-edit-surface"]', (element) => {
      element.textContent = '阅读模式标题';
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    });
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.down(modifier);
    await page.keyboard.press('Enter');
    await page.keyboard.up(modifier);
    await page.waitForSelector('[data-testid="quick-edit-surface"]', { hidden: true });
    const quickEdited = await page.$eval('[data-testid="markdown-body"]', (el) => el.textContent || '');
    assert(quickEdited.includes('阅读模式标题'), 'quick edit reflected in read mode');
    await pressModifierKey(page, 's');
    await page.waitForFunction(() => {
      return String(window.__e2eSavedContent || '').includes('阅读模式标题');
    }, { timeout: 10000 });

    // 4 edit mode
    await page.click('[data-testid="btn-edit"]');
    await page.waitForSelector('[data-testid="source-editor"]');
    const sourceVisual = await readVisualMetrics(page, ['.source-editor']);
    assertApprox(sourceVisual.elements['.source-editor'].width, 800, 'source document width');
    assertApprox(sourceVisual.elements['.source-editor'].paddingLeft, 30, 'source horizontal padding');
    assertApprox(sourceVisual.elements['.source-editor'].paddingTop, 44, 'source top padding');
    assertApprox(
      sourceVisual.elements['.source-editor'].x,
      previewVisual.elements['.markdown-body'].x,
      'source and preview left edges align'
    );
    await setTextareaValue(
      page,
      '[data-testid="source-editor"]',
      `# 新标题\n\n${Array.from({ length: 80 }, (_, index) => `编辑内容 ${index + 1}`).join('\n')}`
    );
    const editScrollState = await page.evaluate(() => {
      const content = document.querySelector('[data-testid="content"]');
      const editor = document.querySelector('[data-testid="source-editor"]');
      return {
        outerScrollable: Boolean(content && content.scrollHeight > content.clientHeight),
        editorScrollable: Boolean(editor && editor.scrollHeight > editor.clientHeight + 1)
      };
    });
    assert(editScrollState.outerScrollable, 'source mode scrolls through the outer content area');
    assert(!editScrollState.editorScrollable, 'source editor does not create an inner scrollbar');
    await page.click('[data-testid="btn-read"]');
    await page.waitForSelector('[data-testid="markdown-body"]');
    const body2 = await page.$eval('[data-testid="markdown-body"]', (el) => el.textContent || '');
    assert(body2.includes('新标题'), 'edit mode reflected in read');

    // reload clean for remaining cases
    await page.goto(DEV_URL, { waitUntil: 'networkidle0' });
    await openSample(page);

    // 5 save
    await page.click('[data-testid="btn-edit"]');
    await setTextareaValue(page, '[data-testid="source-editor"]', '# 保存测试\n');
    await pressModifierKey(page, 's');
    await page.waitForFunction(() => {
      return Boolean(window.__e2eSavedContent);
    }, { timeout: 10000 });
    const saved = await page.evaluate(() => window.__e2eSavedContent);
    assert(typeof saved === 'string' && saved.includes('保存测试'), `save content got: ${saved}`);

    // 6 discard
    await page.goto(DEV_URL, { waitUntil: 'networkidle0' });
    await openSample(page);
    await page.click('[data-testid="btn-edit"]');
    await setTextareaValue(page, '[data-testid="source-editor"]', 'dirty content');
    await page.click('[data-testid="btn-open"]');
    await page.waitForSelector('[data-testid="discard-modal"]', { timeout: 5000 });
    const discardVisual = await readVisualMetrics(page, ['.modal', '.button--danger']);
    assertApprox(discardVisual.elements['.modal'].borderRadius, 10, 'discard modal radius');
    assertApprox(discardVisual.elements['.button--danger'].height, 32, 'danger button height');
    assertApprox(discardVisual.elements['.button--danger'].borderRadius, 6, 'danger button radius');
    assert(
      contrastRatio(
        discardVisual.elements['.button--danger'].color,
        discardVisual.elements['.button--danger'].backgroundColor
      ) >= 4.5,
      'danger button text contrast is at least 4.5:1'
    );
    await assertHoverVisual(page, '[data-testid="discard-cancel"]', 'modal secondary button');
    const dangerHoverVisual = await assertHoverVisual(
      page,
      '[data-testid="discard-confirm"]',
      'danger button',
      '--danger-hover'
    );
    assert(
      contrastRatio(dangerHoverVisual.color, dangerHoverVisual.backgroundColor) >= 4.5,
      'danger button hover text contrast is at least 4.5:1'
    );
    await page.click('[data-testid="discard-cancel"]');
    await page.waitForSelector('[data-testid="discard-modal"]', { hidden: true, timeout: 5000 });

    // 7 search
    await page.goto(DEV_URL, { waitUntil: 'networkidle0' });
    await openSample(page);
    await pressModifierKey(page, 'f');
    await page.waitForSelector('[data-testid="search-input"]');
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('data-testid') === 'search-input',
      { timeout: 5000 }
    );
    const searchVisual = await readVisualMetrics(page, [
      '.search-bar',
      '.search-query-row',
      '.search-navigation-row',
      '.search-navigation-actions .search-icon-btn'
    ]);
    assertApprox(searchVisual.elements['.search-bar'].height, 44, 'empty search stays one row');
    assertApprox(searchVisual.elements['.search-bar'].borderRadius, 999, 'empty search uses pill radius');
    assertApprox(searchVisual.elements['.search-bar'].outlineWidth, 0, 'search has no focus outline');
    const searchFrame = await page.$eval('[data-testid="search-bar"]', (element) => {
      const style = getComputedStyle(element);
      return {
        borderTopWidth: Number.parseFloat(style.borderTopWidth),
        borderRightWidth: Number.parseFloat(style.borderRightWidth),
        borderBottomWidth: Number.parseFloat(style.borderBottomWidth),
        borderLeftWidth: Number.parseFloat(style.borderLeftWidth)
      };
    });
    for (const width of Object.values(searchFrame)) {
      assertApprox(width, 0, 'search has no outer border');
    }
    assertApprox(searchVisual.elements['.search-query-row'].height, 44, 'search query row height');
    assertApprox(
      searchVisual.elements['.search-navigation-row'].height,
      0,
      'empty search hides its navigation row'
    );
    const closeDivider = await page.$eval('[data-testid="search-close"]', (element) => {
      const style = getComputedStyle(element, '::after');
      return {
        top: Number.parseFloat(style.top),
        width: Number.parseFloat(style.width),
        height: Number.parseFloat(style.height),
        backgroundColor: style.backgroundColor
      };
    });
    const expectedDividerColor = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.backgroundColor = 'var(--border)';
      document.body.append(probe);
      const resolved = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return resolved;
    });
    assertApprox(closeDivider.top, 14, 'search close divider is vertically centered');
    assertApprox(closeDivider.width, 1, 'search close divider width');
    assertApprox(closeDivider.height, 16, 'search close divider is short');
    assert(
      closeDivider.backgroundColor === expectedDividerColor,
      'search close divider uses the shared border color'
    );
    await assertInsetHoverVisual(
      page,
      '[data-testid="search-close"]',
      'empty search close button',
      999
    );
    await page.type('[data-testid="search-input"]', '搜索词');
    await page.waitForFunction(() => {
      const t = document.querySelector('[data-testid="search-count"]')?.textContent || '';
      return t.includes('/');
    }, { timeout: 5000 });
    const populatedSearchVisual = await readVisualMetrics(page, [
      '.search-bar',
      '.search-navigation-row',
      '.search-navigation-actions .search-icon-btn'
    ]);
    assertApprox(populatedSearchVisual.elements['.search-bar'].height, 80, 'populated search shows two rows');
    assertApprox(populatedSearchVisual.elements['.search-bar'].borderRadius, 10, 'populated search radius');
    assertApprox(
      populatedSearchVisual.elements['.search-navigation-row'].height,
      36,
      'search navigation row height'
    );
    assertApprox(
      populatedSearchVisual.elements['.search-navigation-actions .search-icon-btn'].height,
      28,
      'search icon button height'
    );
    assertApprox(
      populatedSearchVisual.elements['.search-navigation-actions .search-icon-btn'].borderRadius,
      6,
      'search icon button radius'
    );
    await assertInsetHoverVisual(
      page,
      '[data-testid="search-close"]',
      'populated search close button'
    );
    await assertHoverVisual(page, '[data-testid="search-next"]', 'search navigation button');

    await page.click('[data-testid="search-close"]');
    await page.click('[data-testid="btn-edit"]');
    const sourceSearchTarget = 'SOURCE_SEARCH_TARGET';
    await setTextareaValue(
      page,
      '[data-testid="source-editor"]',
      `${Array.from({ length: 180 }, (_, index) => `源代码行 ${index + 1}`).join('\n')}\n${sourceSearchTarget} 第一处\n中间内容\n${sourceSearchTarget} 第二处`
    );
    await page.waitForFunction(() => {
      const content = document.querySelector('[data-testid="content"]');
      return Boolean(content && content.scrollHeight > content.clientHeight);
    }, { timeout: 5000 });
    await page.$eval('[data-testid="content"]', (element) => {
      element.scrollTop = 0;
    });
    await pressModifierKey(page, 'f');
    await page.waitForSelector('[data-testid="search-input"]');
    await page.click('[data-testid="search-input"]');
    await page.$eval('[data-testid="search-input"]', (input) => input.select());
    await page.type('[data-testid="search-input"]', sourceSearchTarget);
    await page.waitForFunction((target) => {
      const content = document.querySelector('[data-testid="content"]');
      const editor = document.querySelector('[data-testid="source-editor"]');
      const input = document.querySelector('[data-testid="search-input"]');
      const expectedStart = editor?.value.indexOf(target) ?? -1;
      return Boolean(
        content &&
        editor &&
        input &&
        expectedStart >= 0 &&
        content.scrollTop > 0 &&
        editor.selectionStart === expectedStart &&
        editor.selectionEnd === expectedStart + target.length &&
        document.activeElement === input
      );
    }, { timeout: 5000 }, sourceSearchTarget);
    const sourceHighlightState = await page.evaluate(() => {
      const content = document.querySelector('[data-testid="content"]');
      const editor = document.querySelector('[data-testid="source-editor"]');
      const layer = document.querySelector('[data-testid="source-search-highlight-layer"]');
      const hits = Array.from(document.querySelectorAll('.source-search-hit'));
      if (!(content instanceof HTMLElement) || !(editor instanceof HTMLTextAreaElement)) return null;
      if (!(layer instanceof HTMLElement) || hits.length !== 2) return null;
      const editorRect = editor.getBoundingClientRect();
      const layerRect = layer.getBoundingClientRect();
      const editorStyle = getComputedStyle(editor);
      const layerStyle = getComputedStyle(layer);
      return {
        layerText: layer.textContent,
        editorValue: editor.value,
        editorRect: {
          x: editorRect.x,
          y: editorRect.y,
          width: editorRect.width
        },
        layerRect: {
          x: layerRect.x,
          y: layerRect.y,
          width: layerRect.width
        },
        editorStyle: {
          color: editorStyle.color,
          fontFamily: editorStyle.fontFamily,
          fontSize: editorStyle.fontSize,
          lineHeight: editorStyle.lineHeight,
          paddingLeft: editorStyle.paddingLeft,
          paddingTop: editorStyle.paddingTop
        },
        layerStyle: {
          pointerEvents: layerStyle.pointerEvents,
          fontFamily: layerStyle.fontFamily,
          fontSize: layerStyle.fontSize,
          lineHeight: layerStyle.lineHeight,
          paddingLeft: layerStyle.paddingLeft,
          paddingTop: layerStyle.paddingTop
        },
        activeStates: hits.map((hit) => hit.getAttribute('data-active-search')),
        backgrounds: hits.map((hit) => getComputedStyle(hit).backgroundColor)
      };
    });
    assert(sourceHighlightState !== null, 'source search renders two visual highlights');
    assert(
      sourceHighlightState.layerText === sourceHighlightState.editorValue,
      'source highlight layer mirrors the complete textarea value'
    );
    for (const key of ['x', 'y', 'width']) {
      assertApprox(
        sourceHighlightState.layerRect[key],
        sourceHighlightState.editorRect[key],
        `source highlight layer ${key} aligns with textarea`
      );
    }
    for (const key of ['fontFamily', 'fontSize', 'lineHeight', 'paddingLeft', 'paddingTop']) {
      assert(
        sourceHighlightState.layerStyle[key] === sourceHighlightState.editorStyle[key],
        `source highlight layer ${key} matches textarea`
      );
    }
    assert(sourceHighlightState.layerStyle.pointerEvents === 'none', 'source highlights do not block editing');
    assert(
      sourceHighlightState.editorStyle.color === 'rgba(0, 0, 0, 0)',
      'textarea text becomes transparent while the mirror supplies visible text'
    );
    assert(
      sourceHighlightState.activeStates[0] === 'true' && sourceHighlightState.activeStates[1] === null,
      'first source match starts active'
    );
    assert(
      sourceHighlightState.backgrounds[0] !== sourceHighlightState.backgrounds[1],
      'active source match uses a deeper background'
    );
    await page.keyboard.press('Enter');
    await page.waitForFunction((target) => {
      const input = document.querySelector('[data-testid="search-input"]');
      const editor = document.querySelector('[data-testid="source-editor"]');
      const hits = Array.from(document.querySelectorAll('.source-search-hit'));
      const secondStart = editor?.value.indexOf(target, (editor?.value.indexOf(target) ?? -1) + 1) ?? -1;
      return Boolean(
        input &&
        editor &&
        secondStart >= 0 &&
        hits[0]?.getAttribute('data-active-search') === null &&
        hits[1]?.getAttribute('data-active-search') === 'true' &&
        editor.selectionStart === secondStart &&
        editor.selectionEnd === secondStart + target.length &&
        document.activeElement === input
      );
    }, { timeout: 5000 }, sourceSearchTarget);
    const navigatedBackgrounds = await page.$$eval('.source-search-hit', (hits) =>
      hits.map((hit) => getComputedStyle(hit).backgroundColor)
    );
    assert(
      navigatedBackgrounds[0] === sourceHighlightState.backgrounds[1] &&
        navigatedBackgrounds[1] === sourceHighlightState.backgrounds[0],
      'source highlight backgrounds swap when navigating'
    );

    await page.goto(DEV_URL, { waitUntil: 'networkidle0' });
    await openSample(page);

    // 8 outline
    await page.click('[data-testid="btn-outline"]');
    await page.waitForSelector('[data-testid="outline-panel"]');
    const outlineCount = await page.$$eval('[data-testid="outline-item"]', (els) => els.length);
    assert(outlineCount >= 1, 'outline items');
    const outlineVisual = await readVisualMetrics(page, ['.outline-item']);
    assertApprox(outlineVisual.elements['.outline-item'].height, 32, 'outline item height');
    assertApprox(outlineVisual.elements['.outline-item'].borderRadius, 6, 'outline item radius');
    await assertHoverVisual(page, '.outline-item:not(.current)', 'outline item');
    const longOutlineLabel = await page.$$eval('.outline-item-label', (labels) => {
      const label = labels.find((element) => element.textContent?.includes('目录单行省略'));
      if (!(label instanceof HTMLElement) || !(label.parentElement instanceof HTMLElement)) {
        return null;
      }
      const labelStyle = getComputedStyle(label);
      const labelBounds = label.getBoundingClientRect();
      const itemBounds = label.parentElement.getBoundingClientRect();
      return {
        clientWidth: label.clientWidth,
        scrollWidth: label.scrollWidth,
        labelBottom: labelBounds.bottom,
        itemBottom: itemBounds.bottom,
        overflow: labelStyle.overflow,
        textOverflow: labelStyle.textOverflow,
        whiteSpace: labelStyle.whiteSpace
      };
    });
    assert(longOutlineLabel !== null, 'long nested outline label is rendered');
    assert(
      longOutlineLabel.scrollWidth > longOutlineLabel.clientWidth,
      'long nested outline label reaches the truncation path'
    );
    assert(longOutlineLabel.overflow === 'hidden', 'long outline label clips overflow');
    assert(longOutlineLabel.textOverflow === 'ellipsis', 'long outline label uses ellipsis');
    assert(longOutlineLabel.whiteSpace === 'nowrap', 'long outline label stays on one line');
    assert(
      longOutlineLabel.labelBottom <= longOutlineLabel.itemBottom + 0.05,
      'long outline label stays inside the 32px item'
    );

    // 9 external link
    await page.click('[data-testid="markdown-body"] a');
    await page.waitForSelector('[data-testid="external-link-modal"]', { timeout: 5000 });
    const externalVisual = await readVisualMetrics(page, ['.modal']);
    assertApprox(externalVisual.elements['.modal'].borderRadius, 10, 'external modal radius');
    await page.click('[data-testid="external-cancel"]');
    await page.waitForSelector('[data-testid="external-link-modal"]', { hidden: true, timeout: 5000 });

    for (const viewport of [
      { width: 720, height: 800 },
      { width: 390, height: 844 },
      { width: 320, height: 800 }
    ]) {
      await page.setViewport({ ...viewport, deviceScaleFactor: 1 });
      await page.goto(DEV_URL, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-testid="empty-state"]');
      const layout = await readToolbarLayout(page);
      assert(layout.overflowX <= 0, `${viewport.width}px viewport has no horizontal overflow`);
      assert(
        layout.leading.right <= layout.toggle.left,
        `${viewport.width}px leading controls do not overlap mode toggle`
      );
      assert(
        layout.toggle.right <= layout.actions.left,
        `${viewport.width}px mode toggle does not overlap toolbar actions`
      );
    }

    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await page.goto(DEV_URL, { waitUntil: 'networkidle0' });
    await openSample(page);
    await page.click('[data-testid="btn-outline"]');
    await page.waitForSelector('[data-testid="outline-panel"]');
    const narrowOutline = await readVisualMetrics(page, ['.outline-panel']);
    assert(narrowOutline.overflowX <= 0, '390px outline has no horizontal overflow');
    assert(narrowOutline.elements['.outline-panel'].position === 'absolute', '390px outline is an overlay');
    assertApprox(narrowOutline.elements['.outline-panel'].x, 8, '390px outline left inset');
    assertApprox(narrowOutline.elements['.outline-panel'].width, 264, '390px outline width');
    assertApprox(narrowOutline.elements['.outline-panel'].borderRadius, 10, '390px outline radius');
    await pressModifierKey(page, 'f');
    await page.waitForSelector('[data-testid="search-bar"]');
    const narrowSearch = await readVisualMetrics(page, ['.search-bar']);
    assert(narrowSearch.overflowX <= 0, '390px search has no horizontal overflow');
    assertApprox(narrowSearch.elements['.search-bar'].x, 8, '390px search left inset');
    assertApprox(narrowSearch.elements['.search-bar'].width, 374, '390px search width');
    assertApprox(narrowSearch.elements['.search-bar'].height, 44, '390px empty search stays one row');
    assertApprox(narrowSearch.elements['.search-bar'].borderRadius, 999, '390px empty search uses pill radius');

    console.log('E2E OK: 9 scenarios and visual consistency checks passed');
  } catch (err) {
    failures.push(err);
    console.error('E2E FAILED:', err);
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    if (dev) await dev.close().catch(() => undefined);
  }

  if (failures.length) process.exit(1);
}

run();
