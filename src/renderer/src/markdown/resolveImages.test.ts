// @vitest-environment jsdom

import { describe, expect, test } from 'vitest';

import { applyImageResolutions } from './resolveImages';

describe('resolved local image HTML', () => {
  test('sets safe data URLs on resolved images', () => {
    const html = '<p><img data-local-src="a.png" alt="示例"></p>';
    const result = applyImageResolutions(html, {
      'a.png': {
        ok: true,
        src: 'data:image/png;base64,AAAA',
        mime: 'image/png'
      }
    });

    expect(result).toContain('src="data:image/png;base64,AAAA"');
    expect(result).toContain('alt="示例"');
  });

  test('replaces missing images with a clear placeholder', () => {
    const html = '<p><img data-local-src="missing.png" alt="缺图"></p>';
    const result = applyImageResolutions(html, {
      'missing.png': {
        ok: false,
        code: 'IMAGE_NOT_FOUND',
        message: '图片不存在或已被移动。'
      }
    });

    expect(result).not.toContain('<img');
    expect(result).toContain('data-testid="missing-image"');
    expect(result).toContain('图片缺失');
    expect(result).toContain('missing.png');
  });
});
