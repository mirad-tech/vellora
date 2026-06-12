import { readFile } from 'node:fs/promises';

import { describe, expect, test } from 'vitest';

describe('print and PDF export styles', () => {
  test('hides application chrome and defines PDF page margins', async () => {
    const css = await readFile('src/renderer/src/styles.css', 'utf8');
    const printBlock = css.slice(css.indexOf('@media print'));

    expect(printBlock).toContain('@page');
    expect(printBlock).toContain('margin: 18mm 16mm');
    expect(printBlock).toContain('.find-bar');
    expect(printBlock).toContain('.sidebar-panel');
    expect(printBlock).toContain('.status-bar');
    expect(printBlock).toContain('.modal-overlay');
    expect(printBlock).toContain('print-color-adjust: exact');
    expect(printBlock).toContain('overflow: visible !important');
  });
});
