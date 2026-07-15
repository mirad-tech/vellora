// @vitest-environment jsdom

import { describe, expect, test } from 'vitest';

import { applySearchHighlights } from './searchHtml';

describe('HTML search highlighting', () => {
  test('highlights Chinese and English matches without changing existing markup', () => {
    const result = applySearchHighlights(
      '<h1 id="intro">项目记录</h1><p>Search 中文 search</p>',
      'search',
      1
    );

    expect(result.count).toBe(2);
    expect(result.html).toContain('<h1 id="intro">项目记录</h1>');
    expect(result.html).toContain('data-search-hit="0"');
    expect(result.html).toContain('data-search-hit="1"');
    expect(result.html).toContain('data-active-search="true"');
  });

  test('returns a clear zero-count state when query has no match', () => {
    const result = applySearchHighlights('<p>只有中文内容</p>', 'missing', 0);

    expect(result).toEqual({
      html: '<p>只有中文内容</p>',
      count: 0,
      activeIndex: -1
    });
  });

  test('inserts query text as text content instead of executable HTML', () => {
    const result = applySearchHighlights('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>', '<script>', 0);

    expect(result.count).toBe(1);
    expect(result.html).not.toContain('<script>alert');
    expect(result.html).toContain('&lt;script&gt;');
    expect(result.html).toContain('<mark');
  });
});
