import type { ImageResolutionResult } from '../../../shared/documentTypes';

export type ImageResolutionMap = Record<string, ImageResolutionResult>;

export function applyImageResolutions(html: string, resolutions: ImageResolutionMap): string {
  const template = document.createElement('template');
  template.innerHTML = html;

  const images = Array.from(template.content.querySelectorAll<HTMLImageElement>('img[data-local-src]'));

  for (const image of images) {
    const source = image.getAttribute('data-local-src') ?? '';
    const resolution = resolutions[source];

    if (!resolution) {
      image.removeAttribute('src');
      continue;
    }

    if (resolution.ok) {
      image.setAttribute('src', resolution.src);
      image.setAttribute('loading', 'lazy');
      image.setAttribute('decoding', 'async');
      continue;
    }

    const placeholder = document.createElement('span');
    placeholder.className = 'image-placeholder';
    placeholder.setAttribute('data-testid', 'missing-image');
    placeholder.textContent = `图片缺失：${source}`;
    image.replaceWith(placeholder);
  }

  return template.innerHTML;
}
