import { useEffect, useMemo, useRef, useState } from 'react';
import { resolveLocalImage } from '../api/tauri';
import type { ImageResolutionResult } from '../types';
import { LOCAL_IMAGE_RESOLUTION_CONCURRENCY, MAX_LOCAL_IMAGE_SOURCES, normalizeLocalImageSource, resolveImageWithTimeout, type ImageResolutionMap } from './resolveImages';

const emptyImages: ImageResolutionMap = {};

function sameImage(left: ImageResolutionResult | undefined, right: ImageResolutionResult): boolean {
  if (!left || left.ok !== right.ok) return false;
  return left.ok && right.ok ? left.src === right.src && left.mime === right.mime
    : !left.ok && !right.ok && left.code === right.code && left.message === right.message;
}

/** Cache is owned by one open session; the shared queue also bounds overlapping refreshes. */
export function useDocumentImages(path: string | null, session: number, sources: string[]): ImageResolutionMap {
  const [refresh, setRefresh] = useState(0);
  const [resolved, setResolved] = useState<{ owner: object; map: ImageResolutionMap }>();
  const documentOwner = useMemo(() => ({}), [path, session]);
  const owner = useMemo(() => ({ cache: new Map<string, Promise<ImageResolutionResult>>() }), [documentOwner, refresh]);
  const currentOwner = useRef<typeof owner | null>(owner);
  currentOwner.current = owner;
  const queue = useRef<Array<() => Promise<void>>>([]);
  const active = useRef(0);
  const sourceKey = JSON.stringify(sources);
  const groups = useMemo(() => {
    const result = new Map<string, string[]>();
    for (const source of JSON.parse(sourceKey) as string[]) {
      const normalized = normalizeLocalImageSource(source);
      if (!normalized || (!result.has(normalized) && result.size >= MAX_LOCAL_IMAGE_SOURCES)) continue;
      result.set(normalized, [...(result.get(normalized) ?? []), source]);
    }
    return result;
  }, [sourceKey]);
  const visible = useMemo(() => {
    if (resolved?.owner !== documentOwner) return emptyImages;
    const aliases = new Set(Array.from(groups.values()).flat());
    const entries = Object.entries(resolved.map).filter(([source]) => aliases.has(source));
    return entries.length === Object.keys(resolved.map).length ? resolved.map : Object.fromEntries(entries);
  }, [resolved, documentOwner, groups]);

  useEffect(() => {
    currentOwner.current = owner;
    return () => { if (currentOwner.current === owner) currentOwner.current = null; };
  }, [owner]);

  useEffect(() => {
    const refreshImages = () => setRefresh(value => value + 1);
    window.addEventListener('focus', refreshImages);
    return () => window.removeEventListener('focus', refreshImages);
  }, []);

  useEffect(() => {
    setResolved(previous => previous?.owner === documentOwner && (groups.size || !Object.keys(previous.map).length)
      ? previous : { owner: documentOwner, map: emptyImages });
    if (!path || !groups.size) { owner.cache.clear(); return; }
    let canceled = false;
    let frame: number | undefined;
    const completed = new Map<string, ImageResolutionResult>();
    const publish = () => {
      frame = undefined;
      if (canceled || currentOwner.current !== owner) return;
      const updates = Array.from(completed);
      completed.clear();
      setResolved(previous => {
        if (canceled || currentOwner.current !== owner) return previous;
        const current = previous?.owner === documentOwner ? previous.map : emptyImages;
        const map = Object.fromEntries(Object.entries(current).filter(([source]) =>
          groups.get(normalizeLocalImageSource(source))?.includes(source)));
        let changed = Object.keys(map).length !== Object.keys(current).length;
        for (const [source, result] of updates) {
          if (!sameImage(map[source], result)) { map[source] = result; changed = true; }
        }
        return !changed && previous?.owner === documentOwner ? previous : { owner: documentOwner, map };
      });
    };
    for (const key of owner.cache.keys()) if (!groups.has(key)) owner.cache.delete(key);
    const pump = () => {
      while (active.current < LOCAL_IMAGE_RESOLUTION_CONCURRENCY && queue.current.length) {
        active.current++;
        void queue.current.shift()!().finally(() => { active.current--; pump(); });
      }
    };
    const timer = window.setTimeout(() => {
      for (const [normalized, aliases] of groups) {
        let request = owner.cache.get(normalized);
        if (!request) {
          request = new Promise<ImageResolutionResult>(resolve => {
            queue.current.push(async () => {
              if (currentOwner.current !== owner || owner.cache.get(normalized) !== request) {
                resolve({ ok: false, code: 'CANCELED', message: '' });
                return;
              }
              let result = await resolveImageWithTimeout(normalized, source => resolveLocalImage(path, source));
              if (result.ok && typeof Image.prototype.decode === 'function' && currentOwner.current === owner) {
                const image = new Image();
                image.src = result.src;
                try { await image.decode(); }
                catch { result = { ok: false, code: 'IMAGE_READ_FAILED', message: '无法读取图片，请检查权限或文件状态。' }; }
              }
              resolve(result);
            });
          });
          owner.cache.set(normalized, request);
          pump();
        }
        void request.then(result => {
          if (canceled || currentOwner.current !== owner) return;
          aliases.forEach(alias => completed.set(alias, result));
          frame ??= window.requestAnimationFrame(publish);
        });
      }
    }, 300);
    return () => {
      canceled = true;
      window.clearTimeout(timer);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [path, owner, documentOwner, groups]);
  return visible;
}
