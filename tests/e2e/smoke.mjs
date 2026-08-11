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
    const eventHandlers = new Map();
    let nextEventId = 1;
    const handler = async (cmd, args = {}) => {
      if (cmd === 'plugin:event|listen') {
        const eventId = nextEventId++;
        eventHandlers.set(eventId, { event: args.event, handler: args.handler });
        return eventId;
      }
      if (cmd === 'plugin:event|unlisten') {
        eventHandlers.delete(args.eventId);
        return null;
      }
      if (cmd === 'get_initial_document') {
        return { ok: false, code: 'NO_INITIAL', message: '没有初始文档。' };
      }
      if (cmd === 'set_unsaved_changes') return { ok: true };
      if (cmd === 'confirm_close') {
        window.__e2eConfirmCloseCalls = [...(window.__e2eConfirmCloseCalls ?? []), args.allow];
        return { ok: true };
      }
      if (cmd === 'choose_markdown_file' || cmd === 'open_markdown_file') {
        return {
          ok: true,
          document: { ...state.document, content: state.saved, modifiedAt: Date.now() }
        };
      }
      if (cmd === 'save_markdown_file') {
        if (window.__e2eSaveFailureMessage) {
          return {
            ok: false,
            code: 'SAVE_FAILED',
            message: window.__e2eSaveFailureMessage
          };
        }
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
    window.__e2eEmitTauriEvent = (event, payload = null) => {
      for (const registered of eventHandlers.values()) {
        if (registered.event === event) {
          registered.handler({ event, id: 0, payload });
        }
      }
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

async function readSvgPathAlignment(page, selector) {
  return page.$eval(selector, (element) => {
    const icon = element.querySelector('.search-control-icon');
    const path = icon?.querySelector('path');
    if (!(icon instanceof SVGSVGElement) || !(path instanceof SVGGraphicsElement)) {
      throw new Error(`Missing geometric search icon in ${selector}`);
    }
    const buttonBounds = element.getBoundingClientRect();
    const iconBounds = icon.getBoundingClientRect();
    const pathBounds = path.getBBox();
    const viewBox = icon.viewBox.baseVal;
    const style = getComputedStyle(icon);
    const buttonStyle = getComputedStyle(element);
    return {
      iconWidth: iconBounds.width,
      iconHeight: iconBounds.height,
      iconHorizontalOffset:
        iconBounds.x + iconBounds.width / 2 - (buttonBounds.x + buttonBounds.width / 2),
      iconVerticalOffset:
        iconBounds.y + iconBounds.height / 2 - (buttonBounds.y + buttonBounds.height / 2),
      pathHorizontalOffset:
        pathBounds.x + pathBounds.width / 2 - (viewBox.x + viewBox.width / 2),
      pathVerticalOffset:
        pathBounds.y + pathBounds.height / 2 - (viewBox.y + viewBox.height / 2),
      strokeWidth: Number.parseFloat(style.strokeWidth),
      stroke: style.stroke,
      fill: style.fill,
      closedPath: /z\s*$/i.test(path.getAttribute('d') ?? ''),
      buttonColor: buttonStyle.color,
      buttonText: element.textContent?.trim() ?? '',
      ariaHidden: icon.getAttribute('aria-hidden'),
      focusable: icon.getAttribute('focusable'),
      ariaLabel: element.getAttribute('aria-label')
    };
  });
}

async function readSvgCenterCoverage(page, selector) {
  return page.$eval(selector, (element) => {
    const icon = element.querySelector('.search-control-icon');
    const pathElement = icon?.querySelector('path');
    if (!(icon instanceof SVGSVGElement) || !(pathElement instanceof SVGPathElement)) {
      throw new Error(`Missing geometric search icon in ${selector}`);
    }

    const style = getComputedStyle(icon);
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D context is unavailable');

    const path = new Path2D(pathElement.getAttribute('d') ?? '');
    if (style.fill !== 'none') {
      context.fillStyle = '#000';
      context.fill(path);
    }
    if (style.stroke !== 'none') {
      context.strokeStyle = '#000';
      context.lineWidth = Number.parseFloat(style.strokeWidth);
      context.lineCap = style.strokeLinecap;
      context.lineJoin = style.strokeLinejoin;
      context.stroke(path);
    }

    const pixels = context.getImageData(0, 0, 16, 16).data;
    const alphaAt = (x, y) => pixels[(y * 16 + x) * 4 + 3];
    const centerAlphas = [alphaAt(7, 7), alphaAt(8, 7), alphaAt(7, 8), alphaAt(8, 8)];
    return {
      centerAlphas,
      minimumCenterAlpha: Math.min(...centerAlphas),
      centerAlphaSpread: Math.max(...centerAlphas) - Math.min(...centerAlphas)
    };
  });
}

async function assertHoverVisual(
  page,
  selector,
  label,
  backgroundVariable = '--control-hover',
  expectedRadius = 8
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
  assertApprox(after.borderRadius, expectedRadius, `${label} hover radius`);
  assert(
    after.backgroundColor === expectedBackground,
    `${label} hover background: expected ${expectedBackground}, got ${after.backgroundColor}`
  );
  return after;
}

async function assertInsetHoverVisual(page, selector, label, expectedRadius = 8) {
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
  assert(after.insetZIndex === '-1', `${label} keeps the icon above the inset background`);
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
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
    await installMocks(page);

    // 1 empty
    await page.goto(DEV_URL, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-testid="empty-state"]');
    const emptyText = await page.$eval('[data-testid="empty-state"]', (el) => el.textContent || '');
    assert(emptyText.includes('未打开文件'), 'empty state text');
    const emptyVisual = await readVisualMetrics(
      page,
      [
        '.toolbar',
        '.button--toolbar',
        '.mode-toggle',
        '.mode-btn',
        '.button--primary',
        '.empty-app-icon'
      ],
      ['--faint', '--surface']
    );
    assert(emptyVisual.overflowX <= 0, 'desktop empty state has no horizontal overflow');
    assertApprox(emptyVisual.elements['.toolbar'].height, 48, 'toolbar height');
    assertApprox(emptyVisual.elements['.button--toolbar'].height, 32, 'toolbar button height');
    assertApprox(emptyVisual.elements['.button--toolbar'].borderRadius, 8, 'toolbar button radius');
    assertApprox(emptyVisual.elements['.mode-toggle'].height, 32, 'mode toggle height');
    assertApprox(emptyVisual.elements['.mode-toggle'].borderRadius, 10, 'mode toggle radius');
    assertApprox(emptyVisual.elements['.mode-btn'].height, 28, 'mode button height');
    assertApprox(emptyVisual.elements['.mode-btn'].borderRadius, 8, 'mode button radius');
    assertApprox(emptyVisual.elements['.button--primary'].height, 32, 'primary button height');
    assertApprox(emptyVisual.elements['.empty-app-icon'].width, 56, 'empty app icon width');
    assertApprox(emptyVisual.elements['.empty-app-icon'].height, 56, 'empty app icon height');
    assertApprox(emptyVisual.elements['.empty-app-icon'].borderRadius, 12, 'empty app icon radius');
    const emptyIconLoaded = await page.$eval('[data-testid="empty-app-icon"]', (element) =>
      element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0
    );
    assert(emptyIconLoaded, 'empty state uses a loaded application icon');
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
    const modeHoverVisual = await assertHoverVisual(
      page,
      '[data-testid="btn-edit"]',
      'mode button',
      '--control-active'
    );
    assert(
      modeHoverVisual.backgroundColor !== previewVisual.elements['.mode-toggle'].backgroundColor,
      'mode button hover is visibly deeper than the toggle surface'
    );

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
    const discardVisual = await readVisualMetrics(page, [
      '.modal',
      '.modal-actions',
      '.button--danger'
    ]);
    assertApprox(discardVisual.elements['.modal'].borderRadius, 20, 'discard modal uses floating surface radius');
    assertIntegerGeometry(discardVisual.elements['.modal'], 'discard modal');
    assertIntegerGeometry(discardVisual.elements['.modal-actions'], 'discard modal actions');
    assertApprox(discardVisual.elements['.button--danger'].height, 32, 'danger button height');
    assertApprox(discardVisual.elements['.button--danger'].borderRadius, 8, 'danger button radius');
    assertIntegerGeometry(discardVisual.elements['.button--danger'], 'danger button');
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
    assertApprox(searchVisual.elements['.search-bar'].width, 340, 'empty search matches reference width');
    assertApprox(searchVisual.elements['.search-bar'].height, 46, 'empty search includes its inset edge');
    assertApprox(searchVisual.elements['.search-bar'].borderRadius, 20, 'empty search matches reference radius');
    assertApprox(searchVisual.elements['.search-bar'].paddingTop, 1, 'search uses a one-pixel inset edge');
    assertApprox(searchVisual.elements['.search-bar'].outlineWidth, 0, 'search has no focus outline');
    const emptySearchState = await page.$eval('[data-testid="search-bar"]', (element) => {
      const navigation = element.querySelector('.search-navigation-row');
      const navigationStyle = getComputedStyle(navigation);
      return {
        expanded: element.getAttribute('data-expanded'),
        navigationAriaHidden: navigation.getAttribute('aria-hidden'),
        navigationOpacity: Number.parseFloat(navigationStyle.opacity),
        navigationVisibility: navigationStyle.visibility,
        transitionDuration: navigationStyle.transitionDuration,
        transitionTimingFunction: navigationStyle.transitionTimingFunction,
        transitionProperty: navigationStyle.transitionProperty
      };
    });
    assert(emptySearchState.expanded === 'false', 'empty search is marked collapsed');
    assert(emptySearchState.navigationAriaHidden === 'true', 'empty search navigation is aria-hidden');
    assertApprox(emptySearchState.navigationOpacity, 0, 'empty search navigation is transparent');
    assert(emptySearchState.navigationVisibility === 'hidden', 'empty search navigation is hidden');
    assert(
      emptySearchState.transitionProperty.split(',').map((value) => value.trim()).includes('max-height'),
      'search navigation animates max-height'
    );
    assert(
      emptySearchState.transitionDuration.split(',').map((value) => value.trim()).includes('0.36s'),
      'search navigation uses the 360ms expand transition'
    );
    const searchTransitionProperties = emptySearchState.transitionProperty
      .split(',')
      .map((value) => value.trim());
    const searchTransitionDurations = emptySearchState.transitionDuration
      .split(',')
      .map((value) => value.trim());
    const opacityTransitionIndex = searchTransitionProperties.indexOf('opacity');
    assert(opacityTransitionIndex >= 0, 'search navigation animates opacity');
    assert(
      searchTransitionDurations[opacityTransitionIndex] === '0.36s',
      'search navigation content fades through the full expand duration'
    );
    assert(
      emptySearchState.transitionTimingFunction.includes('ease-in-out'),
      'search navigation uses a gradual ease-in-out curve'
    );
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
      12
    );
    const closeIconAlignment = await readSvgPathAlignment(page, '[data-testid="search-close"]');
    assertApprox(closeIconAlignment.iconWidth, 16, 'search close icon width');
    assertApprox(closeIconAlignment.iconHeight, 16, 'search close icon height');
    assertApprox(closeIconAlignment.iconHorizontalOffset, 0, 'search close icon is horizontally centered');
    assertApprox(closeIconAlignment.iconVerticalOffset, 0, 'search close icon is vertically centered');
    assertApprox(closeIconAlignment.pathHorizontalOffset, 0, 'search close path is horizontally centered');
    assertApprox(closeIconAlignment.pathVerticalOffset, 0, 'search close path is vertically centered');
    assert(closeIconAlignment.stroke === 'none', 'search close icon has no intersecting strokes');
    assert(closeIconAlignment.fill === closeIconAlignment.buttonColor, 'search close icon follows button color');
    assert(closeIconAlignment.closedPath, 'search close icon uses one closed silhouette');
    const closeCenterCoverage = await readSvgCenterCoverage(page, '[data-testid="search-close"]');
    assert(
      closeCenterCoverage.minimumCenterAlpha >= 160,
      `search close center has continuous ink: got ${closeCenterCoverage.centerAlphas.join(', ')}`
    );
    assert(
      closeCenterCoverage.centerAlphaSpread <= 8,
      `search close center rasterization is symmetric: got ${closeCenterCoverage.centerAlphas.join(', ')}`
    );
    assert(closeIconAlignment.buttonText === '', 'search close button has no font glyph');
    assert(closeIconAlignment.ariaHidden === 'true', 'search close icon is hidden from assistive technology');
    assert(closeIconAlignment.focusable === 'false', 'search close icon is not focusable');
    assert(closeIconAlignment.ariaLabel === '关闭查找', 'search close button keeps its accessible name');
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--motion-expand-duration', '1000ms');
    });
    await page.type('[data-testid="search-input"]', '搜');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="search-bar"]')?.getAttribute('data-expanded') === 'true',
      { timeout: 5000 }
    );
    const expandingSearchState = await page.evaluate(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const search = document.querySelector('[data-testid="search-bar"]');
      const navigation = document.querySelector('.search-navigation-row');
      return {
        searchHeight: search.getBoundingClientRect().height,
        navigationHeight: navigation.getBoundingClientRect().height,
        runningAnimations: navigation.getAnimations().filter((animation) => animation.playState === 'running').length
      };
    });
    assert(
      expandingSearchState.searchHeight > 46 && expandingSearchState.searchHeight < 82,
      `search expands through intermediate height: got ${expandingSearchState.searchHeight}`
    );
    assert(
      expandingSearchState.navigationHeight > 0 && expandingSearchState.navigationHeight < 36,
      `search navigation reveals progressively: got ${expandingSearchState.navigationHeight}`
    );
    assert(expandingSearchState.runningAnimations > 0, 'search navigation has a running expand transition');
    await page.type('[data-testid="search-input"]', '索词');
    await page.waitForFunction(() => {
      const t = document.querySelector('[data-testid="search-count"]')?.textContent || '';
      return t.includes('/');
    }, { timeout: 5000 });
    await page.waitForFunction(() => {
      const search = document.querySelector('[data-testid="search-bar"]');
      const navigation = document.querySelector('.search-navigation-row');
      return Boolean(
        search &&
        navigation &&
        Math.abs(search.getBoundingClientRect().height - 82) <= 0.05 &&
        Math.abs(navigation.getBoundingClientRect().height - 36) <= 0.05
      );
    }, { timeout: 5000 });
    await page.evaluate(() => {
      document.documentElement.style.removeProperty('--motion-expand-duration');
    });
    const populatedSearchVisual = await readVisualMetrics(page, [
      '.search-bar',
      '.search-navigation-row',
      '.search-navigation-actions .search-icon-btn',
      '.search-count'
    ]);
    assertApprox(populatedSearchVisual.elements['.search-bar'].height, 82, 'populated search shows two rows and inset edge');
    assertApprox(populatedSearchVisual.elements['.search-bar'].borderRadius, 20, 'populated search matches reference radius');
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
      12,
      'search icon button radius'
    );
    const searchNavigationButtonRadii = await page.$$eval(
      '.search-navigation-actions .search-icon-btn',
      (buttons) =>
        buttons.map((button) =>
          Number.parseFloat(getComputedStyle(button).borderTopLeftRadius)
        )
    );
    assert(searchNavigationButtonRadii.length === 2, 'search exposes both navigation buttons');
    searchNavigationButtonRadii.forEach((radius, index) => {
      assertApprox(radius, 12, `search navigation button ${index + 1} uses surface radius`);
    });
    assertIntegerGeometry(
      populatedSearchVisual.elements['.search-navigation-actions .search-icon-btn'],
      'search navigation button'
    );
    const searchCountCenterOffset =
      populatedSearchVisual.elements['.search-count'].y +
      populatedSearchVisual.elements['.search-count'].height / 2 -
      (populatedSearchVisual.elements['.search-navigation-row'].y +
        populatedSearchVisual.elements['.search-navigation-row'].height / 2);
    assertApprox(searchCountCenterOffset, -1, 'search result count is optically raised');
    for (const [selector, ariaLabel] of [
      ['[data-testid="search-prev"]', '上一个匹配项'],
      ['[data-testid="search-next"]', '下一个匹配项']
    ]) {
      const arrowAlignment = await readSvgPathAlignment(page, selector);
      assertApprox(arrowAlignment.iconHorizontalOffset, 0, `${selector} icon is horizontally centered`);
      assertApprox(arrowAlignment.iconVerticalOffset, 0, `${selector} icon is vertically centered`);
      assertApprox(arrowAlignment.pathHorizontalOffset, 0, `${selector} path is horizontally centered`);
      assertApprox(arrowAlignment.pathVerticalOffset, 0, `${selector} path is vertically centered`);
      assert(arrowAlignment.stroke === arrowAlignment.buttonColor, `${selector} icon follows button color`);
      assert(arrowAlignment.buttonText === '', `${selector} has no font glyph`);
      assert(arrowAlignment.ariaHidden === 'true', `${selector} icon is hidden from assistive technology`);
      assert(arrowAlignment.focusable === 'false', `${selector} icon is not focusable`);
      assert(arrowAlignment.ariaLabel === ariaLabel, `${selector} keeps its accessible name`);
    }
    await assertInsetHoverVisual(
      page,
      '[data-testid="search-close"]',
      'populated search close button',
      12
    );
    await assertHoverVisual(
      page,
      '[data-testid="search-next"]',
      'search navigation button',
      '--control-hover',
      12
    );

    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    const reducedMotionVisual = await page.$eval('[data-testid="search-close"]', (element) => {
      const navigation = document.querySelector('.search-navigation-row');
      const closeStyle = getComputedStyle(element, '::before');
      const navigationStyle = getComputedStyle(navigation);
      return {
        closeDuration: closeStyle.transitionDuration,
        closeDelay: closeStyle.transitionDelay,
        navigationDuration: navigationStyle.transitionDuration,
        navigationDelay: navigationStyle.transitionDelay
      };
    });
    const allDurationsAreMinimal = [
      reducedMotionVisual.closeDuration,
      reducedMotionVisual.navigationDuration
    ].every((value) =>
      value
        .split(',')
        .map((part) => Number.parseFloat(part))
        .every((duration) => duration <= 0.001)
    );
    const allDelaysAreZero = [
      reducedMotionVisual.closeDelay,
      reducedMotionVisual.navigationDelay
    ].every((value) =>
      value
        .split(',')
        .map((part) => Number.parseFloat(part))
        .every((delay) => delay === 0)
    );
    assert(allDurationsAreMinimal, 'reduced motion removes search transitions');
    assert(allDelaysAreZero, 'reduced motion removes search transition delays');
    await page.evaluate(() => {
      window.__e2eScrollCalls = [];
      Element.prototype.scrollIntoView = function scrollIntoView(options) {
        window.__e2eScrollCalls.push(options);
      };
    });
    await page.$eval('[data-testid="search-input"]', (input) => input.select());
    await page.type('[data-testid="search-input"]', '搜索');
    await page.waitForFunction(() => window.__e2eScrollCalls.length > 0, { timeout: 5000 });
    const reducedMotionScroll = await page.evaluate(() => window.__e2eScrollCalls.at(-1));
    assert(reducedMotionScroll?.behavior === 'auto', 'reduced motion uses instant result scrolling');
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);

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
    const outlineVisual = await readVisualMetrics(page, ['.outline-heading', '.outline-item']);
    assertApprox(outlineVisual.elements['.outline-heading'].height, 32, 'outline heading height');
    assertIntegerGeometry(outlineVisual.elements['.outline-heading'], 'outline heading');
    assertApprox(outlineVisual.elements['.outline-item'].height, 32, 'outline item height');
    assertApprox(outlineVisual.elements['.outline-item'].borderRadius, 8, 'outline item radius');
    const outlineItemGeometry = await page.$$eval('.outline-item', (items) =>
      items.map((item) => {
        const bounds = item.getBoundingClientRect();
        return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
      })
    );
    outlineItemGeometry.forEach((geometry, index) => {
      assertIntegerGeometry(geometry, `outline item ${index + 1}`);
    });
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
    const externalVisual = await readVisualMetrics(page, [
      '.modal',
      '.modal-actions',
      '[data-testid="external-cancel"]',
      '[data-testid="external-confirm"]'
    ]);
    assertApprox(externalVisual.elements['.modal'].borderRadius, 20, 'external modal uses floating surface radius');
    assertIntegerGeometry(externalVisual.elements['.modal'], 'external modal');
    assertIntegerGeometry(externalVisual.elements['.modal-actions'], 'external modal actions');
    assertIntegerGeometry(
      externalVisual.elements['[data-testid="external-cancel"]'],
      'external cancel button'
    );
    assertIntegerGeometry(
      externalVisual.elements['[data-testid="external-confirm"]'],
      'external confirm button'
    );
    await page.click('[data-testid="external-cancel"]');
    await page.waitForSelector('[data-testid="external-link-modal"]', { hidden: true, timeout: 5000 });

    // 10 close confirmation: backdrop cancels, failure is visible, retry saves before exit
    await page.click('[data-testid="btn-edit"]');
    const closeDraft = '# CLOSE_SAVE_DRAFT\n';
    await setTextareaValue(page, '[data-testid="source-editor"]', closeDraft);
    await page.evaluate(() => window.__e2eEmitTauriEvent('close-requested'));
    await page.waitForSelector('[data-testid="discard-modal"]', { timeout: 5000 });
    const closeLabels = await page.$$eval(
      '[data-testid="discard-modal"] button',
      (buttons) => buttons.map((button) => button.textContent?.trim())
    );
    assert(
      closeLabels.join('|') === '不保存并退出|保存并退出',
      `close actions are explicit: got ${closeLabels.join('|')}`
    );
    await page.click('[data-testid="discard-modal"]', { offset: { x: 4, y: 4 } });
    await page.waitForSelector('[data-testid="discard-modal"]', { hidden: true, timeout: 5000 });
    const canceledCloseCalls = await page.evaluate(() => window.__e2eConfirmCloseCalls ?? []);
    assert(canceledCloseCalls.at(-1) === false, 'backdrop click continues editing');
    assert(
      await page.$eval('[data-testid="source-editor"]', (editor) => editor.value === '# CLOSE_SAVE_DRAFT\n'),
      'backdrop cancellation preserves the draft'
    );

    await page.setViewport({ width: 640, height: 800, deviceScaleFactor: 1 });
    await page.evaluate(() => {
      window.__e2eSaveFailureMessage = '无法保存测试文档。';
      window.__e2eEmitTauriEvent('close-requested');
    });
    await page.waitForSelector('[data-testid="close-save"]', { timeout: 5000 });
    await page.click('[data-testid="close-save"]');
    await page.waitForSelector('[data-testid="close-save-feedback"]', { timeout: 5000 });
    const failedCloseState = await page.evaluate(() => {
      const feedback = document.querySelector('[data-testid="close-save-feedback"]');
      const toolbarStatus = document.querySelector('[data-testid="status-text"]');
      return {
        feedbackText: feedback?.textContent?.trim(),
        feedbackRole: feedback?.getAttribute('role'),
        feedbackVisible: feedback instanceof HTMLElement && feedback.getBoundingClientRect().height > 0,
        toolbarStatusVisible:
          toolbarStatus instanceof HTMLElement && toolbarStatus.getClientRects().length > 0,
        closeCalls: window.__e2eConfirmCloseCalls ?? []
      };
    });
    assert(failedCloseState.feedbackText === '无法保存测试文档。', 'save failure appears in close dialog');
    assert(failedCloseState.feedbackRole === 'alert', 'save failure is announced as an alert');
    assert(failedCloseState.feedbackVisible, 'save failure remains visible at the minimum window width');
    assert(!failedCloseState.toolbarStatusVisible, 'narrow layout hides the toolbar status');
    assert(failedCloseState.closeCalls.at(-1) === false, 'failed save does not confirm native close');

    await page.evaluate(() => {
      window.__e2eSaveFailureMessage = null;
    });
    await page.click('[data-testid="close-save"]');
    await page.waitForSelector('[data-testid="discard-modal"]', { hidden: true, timeout: 5000 });
    const savedCloseState = await page.evaluate(() => ({
      content: window.__e2eSavedContent,
      closeCalls: window.__e2eConfirmCloseCalls ?? []
    }));
    assert(savedCloseState.content === closeDraft, 'save-and-exit writes the current draft');
    assert(savedCloseState.closeCalls.at(-1) === true, 'save-and-exit confirms native close');

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
    assertApprox(narrowOutline.elements['.outline-panel'].borderRadius, 20, '390px outline uses floating surface radius');
    await pressModifierKey(page, 'f');
    await page.waitForSelector('[data-testid="search-bar"]');
    const narrowSearch = await readVisualMetrics(page, ['.search-bar']);
    assert(narrowSearch.overflowX <= 0, '390px search has no horizontal overflow');
    assertApprox(narrowSearch.elements['.search-bar'].x, 38, '390px search keeps its right alignment');
    assertApprox(narrowSearch.elements['.search-bar'].width, 340, '390px search keeps reference width');
    assertApprox(narrowSearch.elements['.search-bar'].height, 46, '390px empty search includes its inset edge');
    assertApprox(narrowSearch.elements['.search-bar'].borderRadius, 20, '390px empty search matches reference radius');

    console.log('E2E OK: 10 scenarios and visual consistency checks passed');
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
