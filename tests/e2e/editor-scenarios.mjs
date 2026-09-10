import assert from 'node:assert/strict';

export async function runEditorScenarios(page, pressModifierKey, capture) {
  const body = '[data-testid="markdown-body"]';
  const original = await page.evaluate(() => window.__e2eSavedContent);
  const setSource = async content => {
    await page.click('[data-testid="btn-edit"]');
    await page.$eval('[data-testid="source-editor"]', (element, value) => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }, content);
    await page.click('[data-testid="btn-read"]');
  };
  const selectNodeText = async (type, text, all = false) => {
    await page.$eval(body, (element, args) => {
      const editor = element.editor;
      let found = false;
      editor.state.doc.descendants((node, pos) => {
        if (!found && node.type.name === args.type && node.textContent.includes(args.text)) {
          const from = pos + 1;
          editor.commands.setTextSelection(args.all ? { from, to: from + node.content.size } : from);
          found = true;
          return false;
        }
      });
      if (!found) throw new Error(`Node not found: ${args.type} ${args.text}`);
      editor.commands.focus();
    }, { type, text, all });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const button = name => page.locator(`button::-p-text(${name})`);
  const save = async () => {
    await pressModifierKey(page, 's');
    await page.waitForFunction(() => document.querySelector('[data-testid="status-text"]')?.textContent === '已保存');
    return page.evaluate(() => window.__e2eSavedContent);
  };
  await setSource('# 编辑验收\n\n第一段文字\n\n普通内容\n\n- 父项\n  - 子项\n\n```unknown\noriginal\n```\n\n| 名称 | 状态 |\n| --- | --- |\n| 单元格 | 正常 |\n\n<!-- 保留注释 -->\n\n<section><strong>HTML 内容</strong></section>\n\n![示例图](ok.png)');

  // Real keyboard editing in a highlighted code node, including literal fences.
  await selectNodeText('codeBlock', 'original', true);
  await page.keyboard.type('const x = 1;');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.down('Shift');
  await page.keyboard.press('Tab');
  await page.keyboard.up('Shift');
  await page.keyboard.press('Tab');
  await page.keyboard.type('```');
  await page.keyboard.press('Enter');
  await page.keyboard.type('tail  ');
  await button('格式').click();
  await page.locator('[aria-label="代码语言"]').fill('javascript');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '代码语言');
  let saved = await save();
  assert.match(saved, /````javascript\nconst x = 1;\n  ```\n.*tail  \n````/);
  assert(saved.includes('<!-- 保留注释 -->'));
  assert(saved.includes('<section><strong>HTML 内容</strong></section>'));

  // Ordinary punctuation is content; explicit formatting is a separate action.
  await selectNodeText('paragraph', '普通内容', true);
  await page.keyboard.type('# literal **text**');
  await selectNodeText('paragraph', '第一段文字', true);
  await page.locator('button[aria-label="加粗"]').click();
  saved = await save();
  assert(saved.includes('**第一段文字**'));
  assert(saved.includes('\\# literal'));

  // Rich clipboard input stays plain text; nested list splitting is reversible.
  await selectNodeText('paragraph', '# literal', true);
  await page.$eval(body, element => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', '# literal **text**');
    clipboardData.setData('text/html', '<h1>unexpected heading</h1>');
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
  });
  assert.equal(await page.$eval(body, element => element.editor.state.selection.$from.parent.type.name), 'paragraph');
  await selectNodeText('paragraph', '子项');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('新增子项');
  assert.equal(await page.$$eval(`${body} ul ul li`, nodes => nodes.length), 2);
  await page.keyboard.press('Home');
  await page.keyboard.press('Backspace');
  assert.equal(await page.$$eval(`${body} ul ul li`, nodes => nodes.length), 1);
  await pressModifierKey(page, 'z');
  assert.equal(await page.$$eval(`${body} ul ul li`, nodes => nodes.length), 2);

  // Table text and structure remain editable after Markdown export/import.
  await selectNodeText('paragraph', '单元格', true);
  await page.keyboard.type('A|B');
  await button('格式').click();
  await button('下方插入行').click();
  await button('格式').click();
  await button('居中').click();
  assert.equal(await page.$$eval(`${body} tr`, rows => rows.length), 3);
  saved = await save();
  assert(saved.includes('A\\|B'));
  assert(saved.includes(':---'));

  // Editing a raw node uses ProseMirror text and participates in undo/save.
  await selectNodeText('rawSource', '保留注释', true);
  await page.keyboard.type('<!-- 已编辑注释 -->');
  saved = await save();
  assert(saved.includes('<!-- 已编辑注释 -->'));
  await pressModifierKey(page, 'z');
  await page.waitForFunction(() => document.querySelector('[data-testid="markdown-body"]').editor.getMarkdown().includes('<!-- 保留注释 -->'));

  await page.click('.document-image');
  await button('图片').click();
  await page.locator('[aria-label="图片相对路径"]').fill('assets/edited.png');
  const imageAlt = '更新图片[1]\\ *标记* `代码` &copy;';
  await page.locator('[aria-label="图片替代文字"]').fill(imageAlt);
  await page.locator('[aria-label="标题"]').fill('图片标题');
  await button('应用').click();
  saved = await save();
  assert(saved.includes('assets/edited.png "图片标题"'));
  assert.equal(await page.$$eval('.document-image img', images => images.some(image => /^https?:/.test(image.getAttribute('src') ?? ''))), false);

  await selectNodeText('paragraph', '第一段文字', true);
  await button('格式').click();
  await capture('editor-format-desktop.png');
  const initialViewport = page.viewport();
  await page.setViewport({ width: 640, height: 700, deviceScaleFactor: 1 });
  await capture('editor-format-narrow.png');
  const geometry = await page.$eval('.editor-tools', element => {
    const bounds = element.getBoundingClientRect();
    return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom,
      width: window.innerWidth, height: window.innerHeight };
  });
  assert(geometry.left >= 0 && geometry.right <= geometry.width, 'format menu fits narrow viewport');
  assert(geometry.top >= 0 && geometry.bottom <= geometry.height, 'format menu is not clipped');
  await page.setViewport(initialViewport);

  await save();
  const expected = await page.$eval(body, element => element.editor.getJSON());
  for (let round = 0; round < 3; round += 1) {
    await page.$eval(body, element => { window.__e2eEditorBeforeReopen = element.editor; });
    await page.click('[data-testid="btn-open"]');
    await page.waitForFunction(() => window.__e2eEditorBeforeReopen.isDestroyed &&
      document.querySelector('[data-testid="markdown-body"]')?.editor !== window.__e2eEditorBeforeReopen);
    assert.deepEqual(await page.$eval(body, element => element.editor.getJSON()), expected);
    assert.equal(await page.$eval(body, element => {
      let alt;
      element.editor.state.doc.descendants(node => { if (node.type.name === 'image') alt = node.attrs.alt; });
      return alt;
    }), imageAlt);
    await save();
  }
  assert.equal(await page.$$eval(`${body} tr`, rows => rows.length), 3);
  const text = await page.$eval(body, element => element.editor.state.doc.textContent);
  assert(text.includes('# literal **text**'));
  assert(text.includes('A|B'));
  assert(text.includes('tail  '));
  assert(text.includes('保留注释'));
  await pressModifierKey(page, 'f');
  await page.locator('[data-testid="search-input"]').fill('第一段文字');
  await page.waitForFunction(() => document.querySelectorAll('[data-search-hit]').length === 1);
  await setSource((await page.evaluate(() => window.__e2eSavedContent)) + '\n\n追加正文');
  await page.waitForFunction(() => document.querySelectorAll('[data-search-hit]').length === 1);
  assert.equal(await page.$eval('[data-testid="search-input"]', element => element.value), '第一段文字');
  await page.locator('[data-testid="search-input"]').fill('');
  await page.keyboard.press('Escape');
  await setSource(original);
  await save();
  console.log('Editor E2E OK: keyboard code/table/raw edits, formatting, undo, round-trip, narrow layout');
}
