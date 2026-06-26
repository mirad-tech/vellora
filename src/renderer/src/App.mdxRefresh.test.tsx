// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { App } from './App';
import { I18nProvider } from './i18n/I18nContext';

const mockSetMarkdown = vi.fn();
const mockGetMarkdown = vi.fn(() => '# MOCK_GET_MARKDOWN');

vi.mock('@mdxeditor/editor', async (importOriginal) => {
  const original = await importOriginal<typeof import('@mdxeditor/editor')>();
  return {
    ...original,
    MDXEditor: React.forwardRef((props: any, ref: any) => {
      React.useImperativeHandle(ref, () => ({
        setMarkdown: mockSetMarkdown,
        getMarkdown: mockGetMarkdown
      }));
      return <div data-testid="mock-mdx-editor">{props.markdown}</div>;
    })
  };
});

type TestHarness = {
  container: HTMLDivElement;
  root: Root;
};

let currentHarness: TestHarness | null = null;
let currentApi: any = null;
let openRequestedCallback: ((filePath: string) => void) | null = null;

function createApi() {
  openRequestedCallback = null;
  return {
    openMarkdownFile: vi.fn().mockResolvedValue({ ok: false, code: 'CANCELED', message: '已取消。' }),
    openMarkdownByPath: vi.fn(),
    onMarkdownOpenRequested: vi.fn((callback) => {
      openRequestedCallback = callback;
      return () => {
        openRequestedCallback = null;
      };
    }),
    openDroppedMarkdownFile: vi.fn().mockResolvedValue({ ok: false, code: 'CANCELED', message: '已取消' }),
    openWorkspaceFolder: vi.fn().mockResolvedValue({ ok: false, code: 'CANCELED', message: '已取消' }),
    openWorkspaceByPath: vi.fn().mockResolvedValue({ ok: false, code: 'CANCELED', message: '已取消' }),
    getRecentItems: vi.fn().mockResolvedValue({ ok: true, items: [] }),
    saveMarkdownFile: vi.fn().mockResolvedValue({ ok: false, code: 'SAVE_FAILED', message: '保存失败' }),
    openDefaultEditor: vi.fn().mockResolvedValue({ ok: true }),
    onMenuAction: vi.fn(() => () => {}),
    exportToPdf: vi.fn().mockResolvedValue({ ok: true }),
    setUnsavedChanges: vi.fn().mockResolvedValue({ ok: true }),
    confirmDiscardChanges: vi.fn().mockResolvedValue({ action: 'discard' }),
    resolveMarkdownImage: vi.fn().mockResolvedValue({ ok: false }),
    openMarkdownLink: vi.fn().mockResolvedValue({ ok: false }),
    getSecurityDiagnostics: vi.fn().mockResolvedValue({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      allowedIpcChannels: []
    }),
    setLanguage: vi.fn().mockResolvedValue(undefined),
    removeRecentItem: vi.fn().mockResolvedValue({ ok: true })
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

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );
  });

  return { container, root };
}

describe('MDXEditor refresh behavior', () => {
  beforeEach(() => {
    currentApi = createApi();
    window.mdViewer = currentApi as any;
    mockSetMarkdown.mockClear();
    mockGetMarkdown.mockClear();
  });

  afterEach(async () => {
    if (currentHarness) {
      const { root, container } = currentHarness;
      await act(async () => {
        root.unmount();
      });
      container.remove();
      currentHarness = null;
    }
    vi.restoreAllMocks();
  });

  test('reloads content when opening the same file path but with a new document instance', async () => {
    currentHarness = await renderApp();

    expect(openRequestedCallback).toBeDefined();

    // 第一次打开 same.md -> 内容：# 第一版
    currentApi.openMarkdownByPath.mockResolvedValueOnce({
      ok: true,
      document: {
        path: 'G:\\docs\\same.md',
        name: 'same.md',
        content: '# 第一版',
        modifiedAt: 1000,
        size: 10
      }
    });

    await act(async () => {
      openRequestedCallback!('G:\\docs\\same.md');
    });

    // 等待异步 IPC Promise 解决
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(mockSetMarkdown).toHaveBeenCalledTimes(1);
    expect(mockSetMarkdown).toHaveBeenLastCalledWith('# 第一版');

    // 清除之前的 mock 统计
    mockSetMarkdown.mockClear();

    // 第二次打开 same.md -> 内容：# 第二版（同一路径，但 modifiedAt 和 content 均变化，代表对象身份发生变更）
    currentApi.openMarkdownByPath.mockResolvedValueOnce({
      ok: true,
      document: {
        path: 'G:\\docs\\same.md',
        name: 'same.md',
        content: '# 第二版',
        modifiedAt: 2000,
        size: 10
      }
    });

    await act(async () => {
      openRequestedCallback!('G:\\docs\\same.md');
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    // 断言再次触发了 setMarkdown，使得新编辑的内容刷新到 MDXEditor 中
    expect(mockSetMarkdown).toHaveBeenCalledTimes(1);
    expect(mockSetMarkdown).toHaveBeenLastCalledWith('# 第二版');
  });
});
