import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  appendSourceDraft, at, defaultViewport, fixtureName, fixturePage, fixturePath, openFixture,
  openFixtureExternalLink, repository, settleRendering, shortcut, withBrowser
} from '../../tests/e2e/browser-fixture.mjs';

const label = process.env.VELLORA_UI_REVIEW_LABEL ?? 'after';
if (!['before', 'after'].includes(label)) throw new Error('Use before or after for VELLORA_UI_REVIEW_LABEL.');
const sourceRoot = path.resolve(process.env.VELLORA_UI_REVIEW_ROOT ?? repository);
const output = path.join(path.resolve(process.env.VELLORA_UI_REVIEW_OUTPUT ?? path.join(repository, 'artifacts/ui-review')), label);
const saveError = '无法保存这份文档。目标文件可能正被其他程序使用，或者文件夹权限已发生变化。当前编辑内容仍保留，请检查保存位置后重试。';

async function makeDirty(page) {
  await openFixture(page);
  await appendSourceDraft(page, '\n\n验收草稿：这段内容尚未保存。\n');
  await page.click(at('btn-read'));
  await page.waitForSelector(at('markdown-body'), { visible: true });
  await page.$eval(at('content'), content => { content.scrollTop = 0; });
}

const scenarios = [
  ...[1280, 820, 640].map(width => ({ name: 'document-' + width + 'x900', width, prepare: openFixture })),
  { name: 'empty-820x900' },
  { name: 'source-search-820x900', prepare: async page => {
    await openFixture(page);
    await page.click(at('btn-edit'));
    await shortcut(page, 'f');
    await page.type(at('search-input'), 'Vellora');
    await page.waitForSelector('.source-search-hit', { visible: true });
  } },
  { name: 'outline-820x900', prepare: async page => {
    await openFixture(page);
    await page.click(at('btn-outline'));
    await page.waitForSelector(at('outline-item'), { visible: true });
  } },
  { name: 'external-820x900', prepare: async page => {
    await openFixture(page);
    await openFixtureExternalLink(page);
  } },
  { name: 'unsaved-820x900', prepare: async page => {
    await makeDirty(page);
    await page.evaluate(() => window.__velloraE2e.emit('close-requested'));
    await page.waitForSelector(at('discard-modal'), { visible: true });
  } },
  { name: 'error-820x900', prepare: async page => {
    await makeDirty(page);
    await page.evaluate(message => { window.__velloraE2e.saveError = message; }, saveError);
    await shortcut(page, 's');
    await page.waitForFunction(message =>
      Array.from(document.querySelectorAll('[data-testid="app-feedback"], [data-testid="status-text"]'))
        .some(element => element.textContent.includes(message)),
      {}, saveError);
  } }
];

function readMetrics(page) {
  return page.evaluate(() => {
    const selectors = ['.toolbar', '.document-name', '.markdown-body', '.source-editor',
      '.source-search-layer', '.outline-panel', '.search-bar', '.modal', '.app-feedback', '.toolbar-feedback'];
    return {
      viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio },
      title: document.title,
      focus: document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName,
      overflow: {
        document: Math.max(0, document.documentElement.scrollWidth - innerWidth),
        body: Math.max(0, document.body.scrollWidth - innerWidth)
      },
      elements: Object.fromEntries(selectors.map(selector => {
        const element = document.querySelector(selector);
        if (!element) return [selector, null];
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return [selector, {
          x: box.x, y: box.y, width: box.width, height: box.height, scrollWidth: element.scrollWidth,
          font: style.font, padding: style.padding, borderRadius: style.borderRadius
        }];
      }))
    };
  });
}

await fs.mkdir(output, { recursive: true });
const git = args => execFileSync('git', args, {
  cwd: sourceRoot, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, encoding: 'utf8'
}).trim();
const report = {
  label, sourceCommit: git(['rev-parse', 'HEAD']), worktreeDirty: Boolean(git(['status', '--porcelain'])),
  renderer: 'Chrome with an isolated Tauri fixture bridge', fixtureName,
  fixtureSha256: crypto.createHash('sha256').update(await fs.readFile(fixturePath)).digest('hex'),
  scenarios: []
};

try {
  await withBrowser(sourceRoot, async (browser, url) => {
    report.browser = await browser.version();
    for (const { name, width, prepare } of scenarios) {
      const viewport = width ? { ...defaultViewport, width } : defaultViewport;
      const { page, errors } = await fixturePage(browser, url, viewport);
      const result = { name, errors };
      report.scenarios.push(result);
      try {
        await prepare?.(page);
        await settleRendering(page);
        Object.assign(result, await readMetrics(page));
        if (label === 'after' && (result.overflow.document || result.overflow.body)) {
          errors.push('Page-level horizontal overflow.');
        }
        result.screenshot = name + '.png';
        await page.screenshot({ path: path.join(output, result.screenshot), captureBeyondViewport: false });
        console.log('[' + label + '] ' + result.screenshot);
      } catch (error) {
        errors.push(String(error));
      } finally {
        await page.close();
      }
    }
  });
} finally {
  await fs.writeFile(path.join(output, 'metrics.json'), JSON.stringify(report, null, 2) + '\n');
}
const errors = report.scenarios.flatMap(result => result.errors.map(error => result.name + ': ' + error));
if (errors.length) throw new Error(errors.join('\n'));
console.log('[' + label + '] ' + report.scenarios.length + ' Chrome screenshots at ' + output);
