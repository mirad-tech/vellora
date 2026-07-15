// @vitest-environment jsdom

import { describe, expect, test } from 'vitest';

import {
  applyImageResolutions,
  collectLocalImageResolutionGroups,
  normalizeLocalImageSource,
  resolveImageGroupsWithLimit
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

  test('normalizes and caps local image resolution groups before IPC resolution', () => {
    const html = [
      '<img data-local-src="assets/pixel%20one.png">',
      '<img data-local-src="assets/pixel one.png?cache=1">',
      '<img data-local-src="assets/two.png">',
      '<img data-local-src="assets/three.png">'
    ].join('');

    const groups = collectLocalImageResolutionGroups(html, 2);

    expect(groups).toEqual([
      {
        normalizedSource: 'assets/pixel one.png',
        sources: ['assets/pixel%20one.png', 'assets/pixel one.png?cache=1']
      },
      {
        normalizedSource: 'assets/two.png',
        sources: ['assets/two.png']
      }
    ]);
  });

  test('resolves image groups with a concurrency limit and maps every original source', async () => {
    const groups = [
      { normalizedSource: 'one.png', sources: ['one.png'] },
      { normalizedSource: 'two.png', sources: ['two.png'] },
      { normalizedSource: 'three.png', sources: ['three.png'] }
    ];
    let active = 0;
    let peakActive = 0;

    const result = await resolveImageGroupsWithLimit(
      groups,
      async (source) => {
        active += 1;
        peakActive = Math.max(peakActive, active);
        await Promise.resolve();
        active -= 1;
        return {
          ok: true,
          mime: 'image/png',
          src: `data:image/png;base64,${source}`
        };
      },
      2
    );

    expect(peakActive).toBeLessThanOrEqual(2);
    expect(result['one.png']).toMatchObject({ ok: true, src: 'data:image/png;base64,one.png' });
    expect(result['two.png']).toMatchObject({ ok: true, src: 'data:image/png;base64,two.png' });
    expect(result['three.png']).toMatchObject({ ok: true, src: 'data:image/png;base64,three.png' });
  });
});
