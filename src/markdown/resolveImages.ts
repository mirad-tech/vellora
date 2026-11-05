import type { ImageResolutionResult } from '../types';

export type ImageResolutionMap = Record<string, ImageResolutionResult>;

export const MAX_LOCAL_IMAGE_SOURCES = 80;
export const LOCAL_IMAGE_RESOLUTION_CONCURRENCY = 4;

function removeUrlSuffix(value: string): string {
  return value.split(/[?#]/, 1)[0];
}

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function normalizeLocalImageSource(source: string): string {
  const trimmed = source.trim();

  if (/^[\\/]{2,}/.test(trimmed)) {
    return '';
  }

  // Block all dangerous protocols including file:// (backend also rejects protocols).
  if (/^(javascript|data|vbscript|file):/i.test(trimmed)) {
    return '';
  }

  return decodePath(removeUrlSuffix(trimmed));
}

/** Bound one IPC request; the document hook owns scheduling and alias mapping. */
export async function resolveImageWithTimeout(
  source: string,
  resolveSource: (source: string) => Promise<ImageResolutionResult>
): Promise<ImageResolutionResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      resolveSource(source),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`解析超时: ${source}`)), 10000);
      })
    ]);
  } catch (error) {
    return { ok: false, code: 'IMAGE_READ_FAILED', message: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

const placeholderImages = new WeakMap<Element, HTMLImageElement>();

/** Refresh image nodes in a sanitized preview without replacing its other DOM. */
export function updatePreviewImages(root: HTMLElement, resolutions: ImageResolutionMap): void {
  for (const element of root.querySelectorAll<HTMLElement>('img[data-local-src], .image-placeholder[data-local-src]')) {
    const image = element instanceof HTMLImageElement ? element : placeholderImages.get(element);
    if (!image) continue;
    const source = image.getAttribute('data-local-src') ?? '';
    const result = resolutions[source];
    if (!result) continue;
    if (result.ok) {
      if (image.getAttribute('src') !== result.src) image.setAttribute('src', result.src);
      image.loading = 'lazy';
      image.decoding = 'async';
      if (element !== image) element.replaceWith(image);
    } else {
      const placeholder = element === image ? document.createElement('span') : element;
      placeholder.className = 'image-placeholder';
      placeholder.dataset.testid = 'missing-image';
      placeholder.dataset.localSrc = source;
      placeholder.textContent = `图片缺失：${source}`;
      placeholder.title = result.message;
      if (element === image) {
        placeholderImages.set(placeholder, image);
        image.replaceWith(placeholder);
      }
    }
  }
}
