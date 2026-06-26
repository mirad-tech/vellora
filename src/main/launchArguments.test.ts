import { describe, expect, test } from 'vitest';

import { findMarkdownPathInArgs } from './launchArguments';

describe('Windows launch arguments', () => {
  test('finds the first Markdown path passed by the shell', () => {
    const result = findMarkdownPathInArgs([
      'G:\\apps\\Vellora.exe',
      '--some-electron-flag',
      'G:\\文档\\daily note.md'
    ]);

    expect(result).toBe('G:\\文档\\daily note.md');
  });

  test('ignores unsupported file types and flags', () => {
    const result = findMarkdownPathInArgs([
      'G:\\apps\\Vellora.exe',
      '--inspect',
      'G:\\文档\\notes.txt'
    ]);

    expect(result).toBeNull();
  });

  test('supports markdown extension variants', () => {
    expect(findMarkdownPathInArgs(['G:\\docs\\设计说明.markdown'])).toBe('G:\\docs\\设计说明.markdown');
  });
});
