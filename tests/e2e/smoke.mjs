import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  appendSourceDraft, at, defaultViewport, fixturePage, openFixture, openFixtureExternalLink,
  repository, settleRendering, shortcut, withBrowser
} from './browser-fixture.mjs';

const screenshots = process.env.VELLORA_E2E_SCREENSHOT_DIR;
const saveError = '无法保存这份文档。目标文件可能正被其他程序使用，或者文件夹权限已发生变化。当前编辑内容仍保留，请关闭占用文件的程序或检查保存位置后重试。若问题持续，请先将当前草稿复制到其他位置，再重新打开文件。';
const feedback = '[data-testid="app-feedback"], [data-testid="status-text"]';

async function scenario(browser, url, label, run) {
  const { page, errors } = await fixturePage(browser, url);
  try {
    await run(page);
    if (screenshots) {
      await fs.mkdir(screenshots, { recursive: true });
      await settleRendering(page);
      await page.screenshot({ path: path.join(screenshots, label + '.png') });
    }
    assert.deepEqual(errors, [], label + ' reported a browser error');
    console.log('[browser E2E] PASS ' + label);
  } finally {
    await page.close();
  }
}

async function toolbarGeometry(page) {
  return page.evaluate(() => {
    const bounds = selector => {
      const rect = document.querySelector(selector)?.getBoundingClientRect();
      return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } : null;
    };
    return {
      toolbar: bounds('.toolbar'), open: bounds('.open-action'), mode: bounds('.mode-toggle'),
      identity: bounds('.document-identity'), actions: bounds('.toolbar-actions'),
      save: bounds('.save-action'), search: bounds('[data-testid="btn-search"]'),
      outline: bounds('[data-testid="btn-outline"]'), feedback: bounds('.toolbar-feedback')
    };
  });
}

function assertToolbarFits(geometry) {
  const { toolbar, open, mode, actions, save, search, outline } = geometry;
  assert.ok(open.right <= mode.left && mode.right <= actions.left, 'toolbar groups must not overlap');
  for (const button of [open, save, search, outline]) {
    assert.ok(button.width > 0 && button.height > 0, 'toolbar action must remain visible');
    assert.ok(button.left >= toolbar.left && button.right <= toolbar.right &&
      button.top >= toolbar.top && button.bottom <= toolbar.bottom, 'toolbar action must fit its surface');
  }
}

async function assertSourceAlignment(page) {
  const aligned = await page.evaluate(() => {
    const textarea = document.querySelector('.source-editor');
    const layer = document.querySelector('.source-search-layer');
    const viewport = document.querySelector('.content');
    const properties = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariantLigatures', 'letterSpacing',
      'lineHeight', 'width', 'boxSizing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
      'whiteSpace', 'tabSize', 'overflowWrap', 'wordBreak'];
    const styles = element => Object.fromEntries(properties.map(property => [property, getComputedStyle(element)[property]]));
    const positions = () => ({
      textarea: textarea.getBoundingClientRect().top, layer: layer.getBoundingClientRect().top,
      textareaInternal: textarea.scrollTop, layerInternal: layer.scrollTop, scroll: viewport.scrollTop
    });
    viewport.scrollTop = 0;
    const start = positions();
    viewport.scrollTop = Math.min(160, viewport.scrollHeight - viewport.clientHeight);
    return { editorStyles: styles(textarea), layerStyles: styles(layer),
      editorLeft: textarea.getBoundingClientRect().left, layerLeft: layer.getBoundingClientRect().left,
      start, end: positions() };
  });
  assert.deepEqual(aligned.editorStyles, aligned.layerStyles, 'textarea and highlights must use identical text metrics');
  assert.equal(aligned.editorLeft, aligned.layerLeft, 'textarea and highlights share the same horizontal origin');
  assert.equal(aligned.start.textarea, aligned.start.layer, 'textarea and highlights share the same vertical origin');
  assert.ok(aligned.end.scroll > 0, 'the long document must use the outer scrollbar');
  assert.ok(Math.abs(aligned.start.textarea - aligned.end.textarea - aligned.end.scroll) < 1);
  assert.ok(Math.abs(aligned.start.layer - aligned.end.layer - aligned.end.scroll) < 1);
  assert.equal(aligned.end.textareaInternal, 0);
  assert.equal(aligned.end.layerInternal, 0);
}

await withBrowser(repository, async (browser, url) => {
  await scenario(browser, url, 'save', async page => {
    assert.equal(await page.$eval(at('btn-save'), button => button.disabled), true);
    assert.equal(await page.$eval(at('btn-search'), button => button.disabled), true);
    await openFixture(page);
    assert.equal(await page.$eval(at('btn-save'), button => button.disabled), true);
    await page.click('.document-editor h1');
    await page.keyboard.press('End');
    await page.keyboard.type(' E2E direct');
    await page.waitForFunction(selector => !document.querySelector(selector).disabled, {}, at('btn-save'));
    await page.click(at('btn-save'));
    await page.waitForFunction(() => window.__velloraE2e.saved?.includes('E2E direct'));
    await page.waitForFunction(() => !window.__velloraE2e.dirty);
    await appendSourceDraft(page, '\n\nE2E source');
    await shortcut(page, 's');
    await page.waitForFunction(() => window.__velloraE2e.saved?.includes('E2E source'));
    assert.match(await page.evaluate(() => window.__velloraE2e.saved), /E2E direct/);
    await page.waitForFunction(() => !window.__velloraE2e.dirty);
  });

  await scenario(browser, url, 'search', async page => {
    await openFixture(page);
    await page.click(at('btn-search'));
    await page.waitForFunction(selector => document.activeElement?.matches(selector), {}, at('search-input'));
    await page.type(at('search-input'), 'Vellora');
    await page.waitForSelector('.document-editor .search-hit', { visible: true });
    const first = await page.$eval(at('search-count'), count => count.textContent);
    await page.keyboard.press('Enter');
    await page.waitForFunction((selector, previous) => document.querySelector(selector)?.textContent !== previous,
      {}, at('search-count'), first);
    await page.keyboard.down('Shift');
    try { await page.keyboard.press('Enter'); } finally { await page.keyboard.up('Shift'); }
    await page.waitForFunction((selector, previous) => document.querySelector(selector)?.textContent === previous,
      {}, at('search-count'), first);
    await shortcut(page, 'f');
    await page.waitForFunction(selector => document.activeElement?.matches(selector), {}, at('search-input'));
    assert.equal(await page.$eval(at('search-input'), input => input.value), 'Vellora');

    await page.$eval(at('search-input'), input => {
      for (const key of ['Enter', 'Escape']) {
        input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, isComposing: true }));
        const legacy = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        Object.defineProperty(legacy, 'keyCode', { value: 229 });
        input.dispatchEvent(legacy);
      }
    });
    await settleRendering(page);
    assert.equal(await page.$eval(at('search-count'), count => count.textContent), first,
      'IME key events neither change the match nor close search');

    await page.click(at('btn-edit'));
    await page.waitForSelector('.source-search-hit', { visible: true });
    await assertSourceAlignment(page);
    await page.click(at('search-close'));
    await page.waitForSelector(at('search-bar'), { hidden: true });
  });

  await scenario(browser, url, 'layout-outline', async page => {
    await openFixture(page);
    await page.click(at('btn-outline'));
    await page.waitForSelector(at('outline-panel'), { visible: true });
    for (const width of [640, 759, 760, 761, 820, 1023, 1024, 1025, 1280]) {
      await page.setViewport({ ...defaultViewport, width });
      await settleRendering(page);
      const sizes = await page.evaluate(() => {
        const panel = document.querySelector('.outline-panel');
        const content = document.querySelector('.content').getBoundingClientRect();
        const outline = panel.getBoundingClientRect();
        return {
          width: innerWidth, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth,
          position: getComputedStyle(panel).position, outlineRight: outline.right, outlineWidth: outline.width,
          contentLeft: content.left, open: document.querySelector('[data-testid="btn-outline"]').getAttribute('aria-expanded')
        };
      });
      assert.equal(sizes.width, width);
      assert.equal(sizes.open, 'true', 'resizing preserves an open outline');
      assert.ok(sizes.documentWidth <= width && sizes.bodyWidth <= width,
        'unexpected page-level horizontal overflow at ' + width + 'px: ' + JSON.stringify(sizes));
      const geometry = await toolbarGeometry(page);
      assertToolbarFits(geometry);
      assert.equal(geometry.toolbar.height, width < 760 ? 80 : 52, 'toolbar height at ' + width + 'px');
      if (width < 760) assert.ok(geometry.identity.top >= geometry.mode.bottom, 'identity moves to the second row');
      if (width < 1024) {
        assert.equal(sizes.position, 'absolute');
        assert.equal(sizes.outlineWidth, 248);
        assert.ok(sizes.contentLeft < sizes.outlineRight, 'the floating outline overlays the reading surface');
      } else {
        assert.equal(sizes.outlineWidth, 232);
        assert.ok(sizes.position !== 'absolute' && sizes.contentLeft >= sizes.outlineRight,
          'the docked outline leaves room for the reading surface');
      }
    }
    assert.equal(await page.$eval('.markdown-body th', cell => getComputedStyle(cell).minWidth), '96px');

    await page.setViewport(defaultViewport);
    await page.click(at('btn-edit'));
    await page.waitForSelector(at('source-editor'), { visible: true });
    await page.waitForSelector(at('outline-panel'), { hidden: true });
    await page.click(at('btn-outline'));
    await page.waitForSelector(at('outline-panel'), { visible: true });
    await page.keyboard.press('Escape');
    await page.waitForSelector(at('outline-panel'), { hidden: true });
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.testid), 'btn-outline');
    await page.click(at('btn-outline'));
    await page.click(at('close-outline'));
    await page.waitForSelector(at('outline-panel'), { hidden: true });
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.testid), 'btn-outline');
  });

  await scenario(browser, url, 'reduced-motion', async page => {
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await openFixture(page);
    await page.evaluate(() => {
      const scroll = Element.prototype.scrollIntoView;
      window.__velloraTestScroll = [];
      Element.prototype.scrollIntoView = function (options) {
        if (this.matches('.search-hit')) window.__velloraTestScroll.push(options?.behavior);
        return scroll.call(this, options);
      };
    });
    await page.click(at('btn-search'));
    await page.type(at('search-input'), 'Vellora');
    await page.waitForFunction(() => window.__velloraTestScroll.includes('auto'));
    await page.click(at('btn-outline'));
    await page.waitForSelector(at('outline-panel'), { visible: true });
    const motion = await page.evaluate(() => {
      const controls = [['.search-bar'], ['.outline-panel'], ['.save-action'], ['.mode-toggle', '::before']];
      return controls.map(([selector, pseudo]) => {
        const css = getComputedStyle(document.querySelector(selector), pseudo);
        return [selector, css.animationName, css.transitionDuration];
      });
    });
    for (const [control, animation, transitions] of motion) {
      assert.equal(animation, 'none', control + ' animation must be disabled');
      assert.ok(transitions.split(',').every(value => parseFloat(value) === 0), control + ' transition must be disabled');
    }
  });

  await scenario(browser, url, 'confirmations', async page => {
    await openFixture(page);
    await openFixtureExternalLink(page);
    await page.click(at('external-cancel'));
    await page.waitForSelector(at('external-link-modal'), { hidden: true });
    assert.deepEqual(await page.evaluate(() => window.__velloraE2e.external), []);
    await appendSourceDraft(page, '\n\nE2E recoverable draft');
    await page.evaluate(() => window.__velloraE2e.emit('close-requested'));
    await page.waitForSelector(at('discard-modal'), { visible: true });
    await page.click(at('close-cancel'));
    await page.waitForSelector(at('discard-modal'), { hidden: true });
    assert.equal(await page.evaluate(() => window.__velloraE2e.close.at(-1)), false);

    await page.setViewport({ ...defaultViewport, width: 640 });
    await settleRendering(page);
    const before = await toolbarGeometry(page);
    await page.evaluate(message => { window.__velloraE2e.saveError = message; }, saveError);
    await page.click(at('btn-save'));
    await page.waitForFunction((selector, message) =>
      Array.from(document.querySelectorAll(selector)).some(element => element.textContent.includes(message)),
      {}, feedback, saveError);
    await page.waitForSelector('.toolbar-feedback[role="alert"]', { visible: true });
    await settleRendering(page);
    const after = await toolbarGeometry(page);
    assertToolbarFits(after);
    for (const control of ['toolbar', 'open', 'mode', 'save', 'search', 'outline']) {
      assert.deepEqual(after[control], before[control], 'a long error must not move ' + control);
    }
    assert.ok(after.feedback.top >= after.toolbar.bottom, 'the long error has its own row');
    assert.match(await page.$eval(at('source-editor'), editor => editor.value), /E2E recoverable draft/);
    assert.equal(await page.evaluate(() => window.__velloraE2e.saved), null);
  });
});

console.log('[browser E2E] 5 scenarios passed');
