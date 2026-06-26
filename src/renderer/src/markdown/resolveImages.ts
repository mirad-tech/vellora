import type { ImageResolutionResult } from '../../../shared/documentTypes';

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

  // 1. 安全过滤：阻断 UNC 路径（Windows 共享路径，如 \\attacker-ip\share...）
  // 避免触发 Windows 的 NTLM 凭据自动网络连接泄露
  if (/^[\\/]{2,}/.test(trimmed)) {
    return '';
  }

  // 2. 伪协议过滤：阻断恶意跳转伪协议，仅允许 file:// 及本地相对路径
  if (/^(javascript|data|vbscript|file):/i.test(trimmed)) {
    if (!trimmed.toLowerCase().startsWith('file://')) {
      return '';
    }
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
        // 单个文件解析设置 10 秒超时，防范主进程卡死挂起
        const resolution = await withTimeout(
          resolveSource(group.normalizedSource),
          10000,
          `解析超时: ${group.normalizedSource}`
        );
        for (const source of group.sources) {
          resolutions[source] = resolution;
        }
      } catch (error) {
        // 异常隔离：单个图片解析失败仅记录在 resolutions 中，不导致整个并发崩溃
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
  // 无图片映射，直接跳过 DOM 重构，提升速度
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
