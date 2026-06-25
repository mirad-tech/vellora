// @vitest-environment jsdom

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  renderMarkdownDocument,
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

  test('renders Markdown without quick-edit metadata', () => {
    const result = renderMarkdownDocument(`# 标题

正文段落

- 列表项

[链接](https://example.com)

| A | B |
| - | - |
| 1 | 2 |
`);

    const ready = asReadyResult(result);
    expect(ready.html).not.toContain('data-edit-block-id=');
    expect(ready.html).not.toContain('data-edit-block-kind=');
  });

  test('strips forged quick-edit attributes from raw HTML', () => {
    const result = renderMarkdownDocument(`# 标题

<p data-edit-block-id="edit-block-1" data-edit-block-kind="heading">伪造编辑块</p>
`);

    const ready = asReadyResult(result);
    const template = document.createElement('template');
    template.innerHTML = ready.html;

    const heading = template.content.querySelector('h1');
    const forgedParagraph = template.content.querySelector('p');

    expect(heading?.hasAttribute('data-edit-block-id')).toBe(false);
    expect(forgedParagraph?.hasAttribute('data-edit-block-id')).toBe(false);
    expect(forgedParagraph?.hasAttribute('data-edit-block-kind')).toBe(false);
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
    expect(elapsed).toBeLessThan(3000);
    if (result.status !== 'ready') return;
    expect(result.html).toContain('<h2 id="heading-标题-0"');
    expect(result.html.length).toBeGreaterThan(100_000);
  });
});
