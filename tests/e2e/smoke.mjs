/**
 * Vellora browser E2E using local Edge + puppeteer-core (no driver download).
 * Starts Vite, injects Tauri invoke mocks, exercises UI flows.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import process from 'node:process';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');
const DEV_URL = 'http://127.0.0.1:1420';

const sampleDoc = {
  path: 'C:\\e2e\\sample.md',
  name: 'sample.md',
  content: '# 标题一\n\n正文搜索词 hello\n\n## 标题二\n\n[外链](https://example.com/path)\n',
  modifiedAt: Date.now(),
  size: 80
};

function findEdge() {
  const candidates = [
    process.env.EDGE_PATH,
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
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

async function run() {
  const edge = findEdge();
  if (!edge) throw new Error('Microsoft Edge not found. Set EDGE_PATH.');

  const dev = spawn('npm', ['run', 'dev:web'], {
    cwd: root,
    shell: true,
    stdio: 'ignore',
    env: { ...process.env, BROWSER: 'none' }
  });

  let browser;
  const failures = [];
  try {
    await waitForUrl(DEV_URL);
    browser = await puppeteer.launch({
      executablePath: edge,
      headless: true,
      args: ['--no-sandbox', '--disable-gpu', '--window-size=1280,800']
    });
    const page = await browser.newPage();
    await installMocks(page);

    // 1 empty
    await page.goto(DEV_URL, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-testid="empty-state"]');
    const emptyText = await page.$eval('[data-testid="empty-state"]', (el) => el.textContent || '');
    assert(emptyText.includes('未打开文件'), 'empty state text');

    // 2 open + render
    await openSample(page);
    const body1 = await page.$eval('[data-testid="markdown-body"]', (el) => el.textContent || '');
    assert(body1.includes('标题一'), 'render heading');

    // 3 quick edit in read mode + save through the existing draft flow
    await page.click('[data-testid="markdown-body"] h1');
    await page.waitForSelector('[data-testid="quick-edit-surface"]');
    await page.$eval('[data-testid="quick-edit-surface"]', (element) => {
      element.textContent = '阅读模式标题';
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    });
    await page.keyboard.down('Control');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Control');
    await page.waitForSelector('[data-testid="quick-edit-surface"]', { hidden: true });
    const quickEdited = await page.$eval('[data-testid="markdown-body"]', (el) => el.textContent || '');
    assert(quickEdited.includes('阅读模式标题'), 'quick edit reflected in read mode');
    await page.click('[data-testid="btn-save"]');
    await page.waitForFunction(() => {
      return String(window.__e2eSavedContent || '').includes('阅读模式标题');
    }, { timeout: 10000 });

    // 4 edit mode
    await page.click('[data-testid="btn-edit"]');
    await page.waitForSelector('[data-testid="source-editor"]');
    await setTextareaValue(page, '[data-testid="source-editor"]', '# 新标题\n\n编辑内容');
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
    await page.click('[data-testid="btn-save"]');
    await page.waitForFunction(() => {
      const t = document.querySelector('[data-testid="btn-save"]')?.textContent || '';
      return t === '已保存' || t === '保存' || Boolean(window.__e2eSavedContent);
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
    await page.click('[data-testid="discard-cancel"]');
    await page.waitForSelector('[data-testid="discard-modal"]', { hidden: true, timeout: 5000 });

    // 7 search
    await page.goto(DEV_URL, { waitUntil: 'networkidle0' });
    await openSample(page);
    await page.click('[data-testid="btn-search"]');
    await page.waitForSelector('[data-testid="search-input"]');
    await page.type('[data-testid="search-input"]', '搜索词');
    await page.waitForFunction(() => {
      const t = document.querySelector('[data-testid="search-count"]')?.textContent || '';
      return t.includes('/');
    }, { timeout: 5000 });

    // 8 outline
    await page.click('[data-testid="btn-outline"]');
    await page.waitForSelector('[data-testid="outline-panel"]');
    const outlineCount = await page.$$eval('[data-testid="outline-item"]', (els) => els.length);
    assert(outlineCount >= 1, 'outline items');

    // 9 external link
    await page.click('[data-testid="markdown-body"] a');
    await page.waitForSelector('[data-testid="external-link-modal"]', { timeout: 5000 });
    await page.click('[data-testid="external-cancel"]');
    await page.waitForSelector('[data-testid="external-link-modal"]', { hidden: true, timeout: 5000 });

    console.log('E2E OK: 9 scenarios passed');
  } catch (err) {
    failures.push(err);
    console.error('E2E FAILED:', err);
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    if (process.platform === 'win32' && dev.pid) {
      spawn('taskkill', ['/pid', String(dev.pid), '/T', '/F'], { shell: true, stdio: 'ignore' });
    } else {
      dev.kill('SIGTERM');
    }
  }

  if (failures.length) process.exit(1);
}

run();
