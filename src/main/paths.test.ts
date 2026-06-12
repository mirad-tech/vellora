import { describe, expect, test } from 'vitest';

import { getPreloadPath, getRendererIndexPath } from './paths';

describe('Electron build artifact paths', () => {
  test('points main process to electron-vite output files', () => {
    const mainDir = 'G:\\mirad\\mirad-server\\md\\out\\main';

    expect(getPreloadPath(mainDir)).toBe('G:\\mirad\\mirad-server\\md\\out\\preload\\index.cjs');
    expect(getRendererIndexPath(mainDir)).toBe('G:\\mirad\\mirad-server\\md\\out\\renderer\\index.html');
  });
});
