// @vitest-environment jsdom

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, test, vi } from 'vitest';
import hljs from 'highlight.js/lib/core';
import DOMPurify from 'dompurify';

import {
  renderMarkdownDocument,
  extractMarkdownOutline,
  type MarkdownRenderResult
} from './renderMarkdown';

const fixtureDir = join(process.cwd(), 'tests/fixtures/markdown');

function asReadyResult(result: MarkdownRenderResult) {
  expect(result.status).toBe('ready');
  if (result.status !== 'ready') {
    throw new Error(`Expected ready render result, received ${result.status}`);
  }
  return result;
}

describe('safe Markdown rendering', () => {
  test('extracts the same heading IDs without HTML rendering or code highlighting', () => {
    const source = '# 标题 *A*\n\n## 标题 A\n\n> ### 引用 `代码`\n\n```js\nconst value = 123;\n```';
    const expected = asReadyResult(renderMarkdownDocument(source)).outline;
    const highlight = vi.spyOn(hljs, 'highlight');
    const sanitize = vi.spyOn(DOMPurify, 'sanitize');
    try {
      expect(extractMarkdownOutline(source)).toEqual(expected);
      expect(highlight).not.toHaveBeenCalled();
      expect(sanitize).not.toHaveBeenCalled();
    } finally { highlight.mockRestore(); sanitize.mockRestore(); }
  });
  test('renders five different Markdown structures without errors', async () => {
    const fixtureNames = [
      '01-headings-paragraphs.md',
      '02-lists-quotes.md',
      '03-table.md',
      '04-code.md',
      '05-links-html.md'
    ];

    const rendered = await Promise.all(
      fixtureNames.map(async (name) => {
        const content = await readFile(join(fixtureDir, name), 'utf8');
        return renderMarkdownDocument(content);
      })
    );

    const readyResults = rendered.map(asReadyResult);
    expect(readyResults[0].html).toContain('<h1 id="heading-一级标题"');
    expect(readyResults[0].outline).toEqual([
      {
        id: 'heading-一级标题',
        level: 1,
        text: '一级标题'
      },
      {
        id: 'heading-二级标题',
        level: 2,
        text: '二级标题'
      }
    ]);
    expect(readyResults[0].html).toContain('id="heading-一级标题"');
    expect(readyResults[1].html).toContain('<blockquote>');
    expect(readyResults[1].html).toContain('<ul>');
    expect(readyResults[2].html).toContain('<table>');
    expect(readyResults[3].html).toContain('hljs');
  });

  test('stores link targets in data-md-href and keeps non-hash href non-navigable', () => {
    const result = renderMarkdownDocument(`[外链](https://example.com/path) [本地](./other.md) [锚点](#heading-x)`);
    const ready = asReadyResult(result);
    expect(ready.html).toContain('data-md-href="https://example.com/path"');
    expect(ready.html).toContain('data-md-href="./other.md"');
    expect(ready.html).toContain('data-md-href="#heading-x"');
    // External / relative links must not keep a live navigable URL in href=
    // (avoid matching the substring inside data-md-href="https://...").
    expect(ready.html).not.toMatch(/(?:^|[\s])href="https:\/\//);
    expect(ready.html).toMatch(/href="#heading-x"/);
    expect(ready.html).toMatch(/href="#" rel="noreferrer" data-md-href="https:\/\/example\.com\/path"/);
  });

  test('removes dangerous raw HTML, event handlers, and unsafe protocols', () => {
    const result = renderMarkdownDocument(`
# 安全清洗

<script>window.__mdViewerXss = true</script>
<img src=x onerror="window.__mdViewerImgXss = true">
<a href="javascript:window.__mdViewerLinkXss = true" onclick="window.__mdViewerClickXss = true">危险链接</a>
<p style="position:fixed">样式不应保留</p>
`);

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.html).not.toContain('<script');
    expect(result.html).not.toContain('onerror');
    expect(result.html).not.toContain('onclick');
    expect(result.html).not.toContain('javascript:');
    expect(result.html).not.toContain('style=');
    expect(result.html).not.toContain('<img');
    expect(result.html).toContain('<p>样式不应保留</p>');
  });

  test('generates unique stable heading ids for duplicate headings and H1-H6 levels', () => {
    const result = renderMarkdownDocument(`
# 重复
## 重复
###### 最深
`);

    const ready = asReadyResult(result);
    expect(ready.outline).toEqual([
      { id: 'heading-重复', level: 1, text: '重复' },
      { id: 'heading-重复-2', level: 2, text: '重复' },
      { id: 'heading-最深', level: 6, text: '最深' }
    ]);
    expect(ready.html).toContain('id="heading-重复"');
    expect(ready.html).toContain('id="heading-重复-2"');
    expect(ready.html).toContain('id="heading-最深"');
  });

  test('outline labels and anchors use visible heading text across formatting and links', () => {
    const ready = asReadyResult(renderMarkdownDocument('# [目标](./target.md) **标题** `代码`\n\n## 目标 标题 代码\n\n### A &amp; B'));
    expect(ready.outline).toEqual([
      { id: 'heading-目标-标题-代码', level: 1, text: '目标 标题 代码' },
      { id: 'heading-目标-标题-代码-2', level: 2, text: '目标 标题 代码' },
      { id: 'heading-a-b', level: 3, text: 'A & B' },
    ]);
  });

  test('renders supported and complex blocks without obsolete editing metadata', () => {
    const ready = asReadyResult(renderMarkdownDocument('# 标题\n\n正文\n\n- 父项\n  - 子项\n\n> 引用\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```js\nconst x = 1;\n```\n\n<section>raw</section>\n\n![图片](assets/test.png)'));
    expect(ready).not.toHaveProperty('editableBlocks');
    expect(ready.html).not.toContain('data-edit-block');
    const template = document.createElement('template');
    template.innerHTML = ready.html;
    expect(template.content.querySelectorAll('li')).toHaveLength(2);
    expect(template.content.querySelector('blockquote')?.textContent).toContain('引用');
    expect(template.content.querySelector('pre code')?.textContent).toBe('const x = 1;\n');
    expect(template.content.querySelector('section')?.textContent).toBe('raw');
    expect(template.content.querySelector('img')?.getAttribute('data-local-src')).toBe('assets/test.png');
    expect(ready.outline).toEqual([{ id: 'heading-标题', level: 1, text: '标题' }]);
  });

  test('strips forged legacy editing attributes and active content from raw HTML', () => {
    const ready = asReadyResult(renderMarkdownDocument('<p data-edit-block-id="forged" data-edit-block-kind="heading" data-edit-block-token="token" contenteditable="true" onclick="alert(1)">保留文字</p>'));
    expect(ready.html).toContain('<p>保留文字</p>');
    expect(ready.html).not.toMatch(/data-edit-block|contenteditable|onclick/);
  });

  test('keeps custom parser output sanitized without obsolete metadata', () => {
    const ready = asReadyResult(renderMarkdownDocument('source', {
      render: () => '<p data-edit-block-id="forged">preview</p><script>alert(1)</script>'
    }));
    expect(ready).toEqual({ status: 'ready', html: '<p>preview</p>', outline: [] });
  });

  test('keeps Markdown images as inert local image references before controlled resolution', () => {
    const result = renderMarkdownDocument('![截图](assets/screen.png "标题")');

    const ready = asReadyResult(result);
    expect(ready.html).toContain('<img');
    expect(ready.html).toContain('data-local-src="assets/screen.png"');
    expect(ready.html).toContain('alt="截图"');
    const template = document.createElement('template');
    template.innerHTML = ready.html;
    const image = template.content.querySelector('img');
    expect(image?.getAttribute('src')).toBeNull();
  });

  test('returns a clear empty state for blank documents', () => {
    expect(renderMarkdownDocument('   \n\t  ')).toEqual({
      status: 'empty',
      html: ''
    });
  });

  test('returns a render error instead of throwing when Markdown parsing fails', () => {
    const result = renderMarkdownDocument('# 内容', {
      render: () => {
        throw new Error('parser exploded');
      }
    });

    expect(result).toEqual({
      status: 'error',
      message: 'Markdown 解析失败。'
    });
  });

  test('renders a reasonable large document within the stage limit', () => {
    const lines = Array.from({ length: 4000 }, (_value, index) => {
      return `## 标题 ${index}\n\n- 项目 ${index}\n- 内容 ${index}\n`;
    });
    const content = lines.join('\n');
    const startedAt = performance.now();

    const result = renderMarkdownDocument(content);

    const elapsed = performance.now() - startedAt;
    expect(result.status).toBe('ready');
    // jsdom + highlight + DOMPurify on 4k sections is heavier than Electron's prior budget.
    expect(elapsed).toBeLessThan(10000);
    if (result.status !== 'ready') return;
    expect(result.html).toContain('<h2 id="heading-标题-0"');
    expect(result.html.length).toBeGreaterThan(100_000);
  }, 15_000);
});
