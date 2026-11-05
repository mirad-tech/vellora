// @vitest-environment jsdom

import { describe, expect, test } from 'vitest';

import {
  normalizeLocalImageSource,
  updatePreviewImages
} from './resolveImages';

describe('resolved local image HTML', () => {
  test('rejects dangerous image protocols including file://', () => {
    expect(normalizeLocalImageSource('file:///c:/secret.png')).toBe('');
    expect(normalizeLocalImageSource('javascript:alert(1)')).toBe('');
    expect(normalizeLocalImageSource('data:image/png;base64,xx')).toBe('');
    expect(normalizeLocalImageSource('assets/ok.png')).toBe('assets/ok.png');
  });

  test('sets safe data URLs on resolved images', () => {
    const html = '<p><img data-local-src="a.png" alt="示例"></p>';
    const root = document.createElement('div');
    root.innerHTML = html;
    updatePreviewImages(root, {
      'a.png': {
        ok: true,
        src: 'data:image/png;base64,AAAA',
        mime: 'image/png'
      }
    });

    expect(root.innerHTML).toContain('src="data:image/png;base64,AAAA"');
    expect(root.innerHTML).toContain('alt="示例"');
  });

  test('replaces missing images with a clear placeholder', () => {
    const html = '<p><img data-local-src="missing.png" alt="缺图"></p>';
    const root = document.createElement('div');
    root.innerHTML = html;
    const image = root.querySelector('img');
    updatePreviewImages(root, {
      'missing.png': {
        ok: false,
        code: 'IMAGE_NOT_FOUND',
        message: '图片不存在或已被移动。'
      }
    });

    expect(root.querySelector('img')).toBeNull();
    expect(root.innerHTML).toContain('data-testid="missing-image"');
    expect(root.textContent).toContain('图片缺失：missing.png');
    updatePreviewImages(root, {
      'missing.png': { ok: true, src: 'data:image/png;base64,AAAA', mime: 'image/png' }
    });
    expect(root.querySelector('img')).toBe(image);
    expect(image?.alt).toBe('缺图');
  });
});
