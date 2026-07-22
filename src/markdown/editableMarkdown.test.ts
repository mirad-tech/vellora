// @vitest-environment jsdom

import { describe, expect, test } from 'vitest';

import {
  isEditableBlockRoundTripSafe,
  rebuildEditableBlockSource,
  serializeEditableBlock
} from './editableMarkdown';

function element(html: string): HTMLElement {
  const template = document.createElement('template');
  template.innerHTML = html;
  const result = template.content.firstElementChild;
  if (!(result instanceof HTMLElement)) throw new Error('Expected an element');
  return result;
}

describe('caret-only Markdown block editing', () => {
  test('serializes supported inline formatting from the rendered block', () => {
    const block = element(
      '<p>普通 <strong>加粗</strong>、<em>斜体</em>、<code>code</code> 和 <a data-md-href="./next.md">链接</a></p>'
    );

    expect(serializeEditableBlock(block)).toBe(
      '普通 **加粗**、*斜体*、`code` 和 [链接](./next.md)'
    );
  });

  test('preserves Markdown container markers while replacing visible content', () => {
    expect(rebuildEditableBlockSource('heading', '## 标题', '新标题', '\n')).toBe('## 新标题');
    expect(rebuildEditableBlockSource('list-item', '- 项目', '新项目', '\n')).toBe('- 新项目');
    expect(rebuildEditableBlockSource('blockquote', '> 引用', '新引用', '\n')).toBe('> 新引用');
  });

  test('preserves CRLF and indents new list-item lines', () => {
    expect(rebuildEditableBlockSource('list-item', '- 第一行', '第一行\n第二行', '\r\n')).toBe(
      '- 第一行\r\n  第二行'
    );
    expect(rebuildEditableBlockSource('paragraph', '第一行\r\n第二行', '修改\n第二行', '\r\n')).toBe(
      '修改\r\n第二行'
    );
  });

  test('ignores renderer whitespace around blockquote paragraphs', () => {
    const block = element('<blockquote>\n<p>引用内容</p>\n</blockquote>');

    expect(serializeEditableBlock(block)).toBe('引用内容');
    expect(isEditableBlockRoundTripSafe('blockquote', '> 引用内容', block, '\n')).toBe(true);
  });

  test('rejects blocks whose rendered DOM cannot reproduce the original Markdown exactly', () => {
    const escaped = element('<p>保留 *星号*</p>');
    const hardBreak = element('<p>第一行<br>\n第二行</p>');

    expect(isEditableBlockRoundTripSafe('paragraph', '保留 \\*星号\\*', escaped, '\n')).toBe(
      false
    );
    expect(isEditableBlockRoundTripSafe('paragraph', '第一行  \n第二行', hardBreak, '\n')).toBe(
      false
    );
  });
});
