// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { App } from './App';
import type { MdViewerApi } from '../../preload/types';

type TestHarness = {
  container: HTMLDivElement;
  root: Root;
  getMenuActionHandler: () => ((action: string) => void) | null;
};

let currentHarness: TestHarness | null = null;
let currentApi:
  | (MdViewerApi & {
      getMenuActionHandler: () => ((action: string) => void) | null;
    })
  | null = null;

function createApi(): MdViewerApi & {
  getMenuActionHandler: () => ((action: string) => void) | null;
} {
  let menuActionHandler: ((action: string) => void) | null = null;

  return {
    openMarkdownFile: vi.fn().mockResolvedValue({ ok: false, code: 'CANCELED', message: '已取消。' }),
    openMarkdownByPath: vi.fn().mockResolvedValue({ ok: false, code: 'CANCELED', message: '已取消。' }),
    onMarkdownOpenRequested: vi.fn(() => () => {}),
    openDroppedMarkdownFile: vi.fn().mockResolvedValue({ ok: false, code: 'CANCELED', message: '已取消。' }),
    openWorkspaceFolder: vi.fn().mockResolvedValue({ ok: false, code: 'CANCELED', message: '已取消。' }),
    openWorkspaceByPath: vi.fn().mockResolvedValue({ ok: false, code: 'CANCELED', message: '已取消。' }),
    getRecentItems: vi.fn().mockResolvedValue({ ok: true, items: [] }),
    saveMarkdownFile: vi.fn().mockResolvedValue({ ok: false, code: 'SAVE_FAILED', message: '保存失败。' }),
    openDefaultEditor: vi.fn().mockResolvedValue({ ok: true }),
    onMenuAction: vi.fn((callback) => {
      menuActionHandler = callback;
      return () => {
        menuActionHandler = null;
      };
    }),
    exportToPdf: vi.fn().mockResolvedValue({ ok: true }),
    setUnsavedChanges: vi.fn().mockResolvedValue({ ok: true }),
    confirmDiscardChanges: vi.fn().mockResolvedValue({ action: 'discard' }),
    resolveMarkdownImage: vi.fn().mockResolvedValue({
      ok: false,
      code: 'UNSUPPORTED_IMAGE_SOURCE',
      message: '不支持的图片。'
    }),
    openMarkdownLink: vi.fn().mockResolvedValue({
      ok: false,
      code: 'UNSUPPORTED_LINK',
      message: '不支持的链接。'
    }),
    getSecurityDiagnostics: vi.fn().mockResolvedValue({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      allowedIpcChannels: []
    }),
    setLanguage: vi.fn().mockResolvedValue(undefined),
    getMenuActionHandler: () => menuActionHandler
  };
}

async function renderApp(): Promise<TestHarness> {
  if (!window.requestAnimationFrame) {
    window.requestAnimationFrame = (callback) => {
      window.setTimeout(() => callback(performance.now()), 0);
      return 1;
    };
  }
  if (!window.cancelAnimationFrame) {
    window.cancelAnimationFrame = () => {};
  }

  window.requestAnimationFrame = (callback) => {
    window.setTimeout(() => callback(performance.now()), 0);
    return 1;
  };

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(<App />);
  });

  currentHarness = {
    container,
    root,
    getMenuActionHandler: () => currentApi?.getMenuActionHandler() ?? null
  };
  return currentHarness;
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  currentApi = createApi();
  window.mdViewer = currentApi;
});

afterEach(async () => {
  if (currentHarness) {
    await act(async () => {
      currentHarness?.root.unmount();
    });
  }
  currentHarness = null;
  currentApi = null;
  document.body.innerHTML = '';
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  vi.restoreAllMocks();
});

describe('App native menu integration', () => {
  test('does not render the removed web toolbar', async () => {
    const { container } = await renderApp();

    expect(container.querySelector('[data-testid="top-toolbar"]')).toBeNull();
    expect(container.querySelector('[data-testid="status-bar"]')).not.toBeNull();
  });

  test('responds to native menu actions from preload', async () => {
    const { container, getMenuActionHandler } = await renderApp();

    const handler = getMenuActionHandler();
    expect(handler).not.toBeNull();

    await act(async () => {
      handler?.('toggle-theme');
    });

    expect(container.querySelector('[data-testid="app-shell"]')?.getAttribute('data-theme')).toBe('dark');
  });
});
