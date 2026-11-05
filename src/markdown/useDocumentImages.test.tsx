import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useDocumentImages } from './useDocumentImages';
const { resolveLocalImage } = vi.hoisted(() => ({ resolveLocalImage: vi.fn() }));
vi.mock('../api/tauri', () => ({ resolveLocalImage }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); });

test('normalizes aliases and caps the current document at 80 image sources', async () => {
  vi.useFakeTimers();
  resolveLocalImage.mockImplementation(async (_path, source) => ({ ok: true, src: source, mime: 'image/png' }));
  const sources = ['assets/pixel%20one.png', 'assets/pixel one.png?cache=1',
    ...Array.from({ length: 81 }, (_, index) => `${index}.png`), 'file:///blocked.png'];
  const { result } = renderHook(() => useDocumentImages('C:/docs/a.md', 1, sources));
  await act(async () => vi.advanceTimersByTimeAsync(320));
  expect(resolveLocalImage).toHaveBeenCalledTimes(80);
  expect(result.current[sources[0]]).toBe(result.current[sources[1]]);
  expect(result.current[sources[0]]).toMatchObject({ ok: true, src: 'assets/pixel one.png' });
  expect(result.current['78.png']?.ok).toBe(true);
  expect(result.current['79.png']).toBeUndefined();
  expect(result.current['file:///blocked.png']).toBeUndefined();
});

test('rejected and timed out image requests report errors and release the shared queue', async () => {
  vi.useFakeTimers();
  resolveLocalImage.mockImplementation((_path, source) => {
    if (source === 'rejected.png') return Promise.reject(new Error('read failed'));
    if (source === 'ready.png') return Promise.resolve({ ok: true, src: source, mime: 'image/png' });
    return new Promise(() => undefined);
  });
  const sources = ['rejected.png', 'slow1.png', 'slow2.png', 'slow3.png', 'slow4.png', 'ready.png'];
  const { result } = renderHook(() => useDocumentImages('C:/docs/a.md', 1, sources));
  await act(async () => vi.advanceTimersByTimeAsync(320));
  expect(resolveLocalImage).toHaveBeenCalledTimes(5);
  expect(result.current['rejected.png']).toMatchObject({ ok: false, message: 'read failed' });
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(result.current['slow1.png']).toMatchObject({ ok: false, code: 'IMAGE_READ_FAILED', message: '解析超时: slow1.png' });
  expect(result.current['ready.png']).toMatchObject({ ok: true });
  expect(resolveLocalImage).toHaveBeenCalledTimes(6);
});

test('reuses session image results on body edits and refreshes on focus', async () => {
  resolveLocalImage.mockResolvedValue({ ok: true, src: 'data:image/png;base64,AA', mime: 'image/png' });
  const { result, rerender } = renderHook(({ sources, session }) => useDocumentImages('C:/docs/a.md', session, sources), {
    initialProps: { sources: ['a.png', './a.png'], session: 1 },
  });
  await waitFor(() => expect(result.current['a.png']?.ok).toBe(true));
  const calls = resolveLocalImage.mock.calls.length;
  rerender({ sources: ['a.png', './a.png'], session: 1 });
  await act(() => new Promise(resolve => setTimeout(resolve, 350)));
  expect(resolveLocalImage).toHaveBeenCalledTimes(calls);
  const displayed = result.current;
  act(() => window.dispatchEvent(new Event('focus')));
  expect(result.current).toBe(displayed);
  await waitFor(() => expect(resolveLocalImage.mock.calls.length).toBe(calls * 2));
  await act(() => new Promise(resolve => setTimeout(resolve, 30)));
  expect(result.current).toBe(displayed);
  rerender({ sources: ['a.png', './a.png'], session: 2 });
  expect(result.current).toEqual({});
  await waitFor(() => expect(resolveLocalImage.mock.calls.length).toBe(calls * 3));
});

test('late previous session requests cannot replace current images', async () => {
  let finish!: (value: unknown) => void;
  resolveLocalImage.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  resolveLocalImage.mockResolvedValue({ ok: true, src: 'new', mime: 'image/png' });
  const { result, rerender } = renderHook(({ session }) => useDocumentImages('C:/docs/a.md', session, ['a.png']), { initialProps: { session: 1 } });
  await waitFor(() => expect(resolveLocalImage).toHaveBeenCalledTimes(1));
  rerender({ session: 2 });
  await waitFor(() => expect(result.current['a.png']).toMatchObject({ src: 'new' }));
  await act(async () => finish({ ok: true, src: 'old', mime: 'image/png' }));
  expect(result.current['a.png']).toMatchObject({ src: 'new' });
});

test('rapid refresh and session changes keep four shared requests and skip obsolete queued images', async () => {
  vi.useFakeTimers();
  const pending: Array<() => void> = [];
  let active = 0;
  let maximum = 0;
  resolveLocalImage.mockImplementation((_path, source) => new Promise(resolve => {
    maximum = Math.max(maximum, ++active);
    pending.push(() => { active--; resolve({ ok: true, src: source, mime: 'image/png' }); });
  }));
  const sources = Array.from({ length: 8 }, (_, index) => `${index}.png`);
  const { result, rerender, unmount } = renderHook(({ session }) => useDocumentImages('C:/docs/a.md', session, sources), { initialProps: { session: 1 } });
  await act(async () => vi.advanceTimersByTimeAsync(300));
  expect(resolveLocalImage).toHaveBeenCalledTimes(4);
  for (let i = 0; i < 3; i++) {
    act(() => window.dispatchEvent(new Event('focus')));
    await act(async () => vi.advanceTimersByTimeAsync(300));
  }
  rerender({ session: 2 });
  await act(async () => vi.advanceTimersByTimeAsync(300));
  for (let i = 0; i < 3; i++) await act(async () => pending.splice(0).forEach(finish => finish()));
  expect(resolveLocalImage).toHaveBeenCalledTimes(12);
  expect(maximum).toBe(4);
  await act(async () => vi.advanceTimersByTimeAsync(20));
  expect(Object.keys(result.current)).toHaveLength(8);
  act(() => window.dispatchEvent(new Event('focus')));
  await act(async () => vi.advanceTimersByTimeAsync(300));
  expect(resolveLocalImage).toHaveBeenCalledTimes(16);
  unmount();
  await act(async () => pending.splice(0).forEach(finish => finish()));
  expect(resolveLocalImage).toHaveBeenCalledTimes(16);
});

test('publishes ready images before slow ones and ignores an older refresh result', async () => {
  vi.useFakeTimers();
  const pending: Array<{ source: string; finish: (value: unknown) => void }> = [];
  resolveLocalImage.mockImplementation((_path, source) => new Promise(finish => pending.push({ source, finish })));
  const { result, rerender } = renderHook(({ sources }) => useDocumentImages('C:/docs/a.md', 1, sources), {
    initialProps: { sources: ['a.png', 'slow.png'] },
  });
  await act(async () => vi.advanceTimersByTimeAsync(300));
  await act(async () => pending[0].finish({ ok: true, src: 'first', mime: 'image/png' }));
  await act(async () => vi.advanceTimersByTimeAsync(20));
  expect(result.current['a.png']).toMatchObject({ src: 'first' });
  expect(result.current['slow.png']).toBeUndefined();
  act(() => window.dispatchEvent(new Event('focus')));
  expect(result.current['a.png']).toMatchObject({ src: 'first' });
  await act(async () => vi.advanceTimersByTimeAsync(300));
  await act(async () => pending[2].finish({ ok: true, src: 'updated', mime: 'image/png' }));
  await act(async () => vi.advanceTimersByTimeAsync(20));
  await act(async () => pending[1].finish({ ok: true, src: 'obsolete', mime: 'image/png' }));
  await act(async () => vi.advanceTimersByTimeAsync(20));
  expect(result.current['a.png']).toMatchObject({ src: 'updated' });
  expect(result.current['slow.png']).toBeUndefined();
  rerender({ sources: [] });
  expect(result.current).toEqual({});
  await act(async () => pending[3].finish({ ok: false, code: 'IMAGE_NOT_FOUND', message: 'missing' }));
  await act(async () => vi.advanceTimersByTimeAsync(20));
  expect(result.current).toEqual({});
});

test('a decoding failure uses the existing image error state and can recover on refresh', async () => {
  const decode = vi.fn().mockRejectedValueOnce(new Error('Invalid image')).mockResolvedValue(undefined);
  vi.stubGlobal('Image', class { src = ''; decode() { return decode(); } });
  try {
    resolveLocalImage.mockResolvedValue({ ok: true, src: 'data:image/png;base64,AA', mime: 'image/png' });
    const { result } = renderHook(() => useDocumentImages('C:/docs/a.md', 1, ['a.png']));
    await waitFor(() => expect(result.current['a.png']).toMatchObject({ ok: false, code: 'IMAGE_READ_FAILED' }));
    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(result.current['a.png']).toMatchObject({ ok: true }));
  } finally { vi.unstubAllGlobals(); }
});

test('removing image sources drops queued work in the same document session', async () => {
  vi.useFakeTimers();
  const pending: Array<() => void> = [];
  resolveLocalImage.mockImplementation(() => new Promise(resolve => pending.push(() =>
    resolve({ ok: true, src: 'image', mime: 'image/png' }))));
  const { result, rerender } = renderHook(({ sources }) => useDocumentImages('C:/docs/a.md', 1, sources), {
    initialProps: { sources: Array.from({ length: 8 }, (_, i) => `${i}.png`) },
  });
  await act(async () => vi.advanceTimersByTimeAsync(300));
  expect(resolveLocalImage).toHaveBeenCalledTimes(4);
  rerender({ sources: [] });
  await act(async () => pending.splice(0).forEach(finish => finish()));
  await act(async () => vi.advanceTimersByTimeAsync(400));
  expect(resolveLocalImage).toHaveBeenCalledTimes(4);
  expect(result.current).toEqual({});
});
