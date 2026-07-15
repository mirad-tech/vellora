import type { ImageResolutionResult } from '../types';

export type ImageResolutionMap = Record<string, ImageResolutionResult>;
export type LocalImageResolutionGroup = {
  normalizedSource: string;
  sources: string[];
};

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

export function collectLocalImageResolutionGroups(
  html: string,
  maxGroups = MAX_LOCAL_IMAGE_SOURCES
): LocalImageResolutionGroup[] {
  const template = document.createElement('template');
  template.innerHTML = html;

  const groups = new Map<string, string[]>();
  const limit = Math.max(0, Math.floor(maxGroups));
  const images = Array.from(template.content.querySelectorAll<HTMLImageElement>('img[data-local-src]'));

  for (const image of images) {
    const source = image.getAttribute('data-local-src') ?? '';
    const normalizedSource = normalizeLocalImageSource(source);
    if (normalizedSource.length === 0) continue;

    const existingSources = groups.get(normalizedSource);
    if (existingSources) {
      existingSources.push(source);
      continue;
    }

    if (groups.size >= limit) continue;
    groups.set(normalizedSource, [source]);
  }

  return Array.from(groups, ([normalizedSource, sources]) => ({ normalizedSource, sources }));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, rejectMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(rejectMessage)), timeoutMs);
    promise
      .then((res) => {
        clearTimeout(timer);
        resolve(res);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

export async function resolveImageGroupsWithLimit(
  groups: LocalImageResolutionGroup[],
  resolveSource: (source: string) => Promise<ImageResolutionResult>,
  concurrency = LOCAL_IMAGE_RESOLUTION_CONCURRENCY,
  isCanceled: () => boolean = () => false
): Promise<ImageResolutionMap> {
  const resolutions: ImageResolutionMap = {};
  const workerCount = Math.min(groups.length, Math.max(1, Math.floor(concurrency)));
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (!isCanceled()) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= groups.length) return;

      const group = groups[index];
      try {
        const resolution = await withTimeout(
          resolveSource(group.normalizedSource),
          10000,
          `解析超时: ${group.normalizedSource}`
        );
        for (const source of group.sources) {
          resolutions[source] = resolution;
        }
      } catch (error) {
        const failedResult: ImageResolutionResult = {
          ok: false,
          code: 'IMAGE_READ_FAILED',
          message: error instanceof Error ? error.message : String(error)
        };
        for (const source of group.sources) {
          resolutions[source] = failedResult;
        }
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return resolutions;
}

export function applyImageResolutions(html: string, resolutions: ImageResolutionMap): string {
  if (Object.keys(resolutions).length === 0) {
    return html;
  }

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
