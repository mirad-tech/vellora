// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { App } from './App';
import { I18nProvider } from './i18n/I18nContext';
import type { MdViewerApi } from '../../preload/types';
import type { MarkdownDocument } from '../../shared/documentTypes';

const mockMdxEditor = vi.hoisted(() => ({
  setMarkdown: vi.fn(),
  getMarkdown: vi.fn(() => '')
}));

vi.mock('@mdxeditor/editor', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  const plugin = () => ({});

  return {
    MDXEditor: React.forwardRef((props: { markdown: string }, ref) => {
      mockMdxEditor.getMarkdown.mockImplementation(() => props.markdown);
      React.useImperativeHandle(ref, () => ({
        setMarkdown: mockMdxEditor.setMarkdown,
        getMarkdown: mockMdxEditor.getMarkdown
      }));
      return React.createElement('div', null, props.markdown);
    }),
    codeBlockPlugin: plugin,
    codeMirrorPlugin: plugin,
    headingsPlugin: plugin,
    imagePlugin: plugin,
    linkDialogPlugin: plugin,
    linkPlugin: plugin,
    listsPlugin: plugin,
    markdownShortcutPlugin: plugin,
    quotePlugin: plugin,
    tablePlugin: plugin,
    thematicBreakPlugin: plugin
  };
});

function createDocument(content: string): MarkdownDocument {
  return {
    path: 'G:\\docs\\same.md',
    name: 'same.md',
    content,
    modifiedAt: Date.now(),
    size: content.length
  };
}

function createApi(documents: MarkdownDocument[]): MdViewerApi & {
  emitOpenRequest: (filePath: string) => void;
} {
  let openRequestHandler: ((filePath: string) => void) | null = null;

  return {
    openMarkdownFile: vi.fn().mockResolvedValue({ ok: false, code: 'CANCELED', message: '已取消。' }),
    openMarkdownByPath: vi.fn().mockImplementation(async () => ({
      ok: true,
      document: documents.shift()
    })),
    onMarkdownOpenRequested: vi.fn((callback) => {
      openRequestHandler = callback;
      return () => {
        openRequestHandler = null;
      };
    }),
    openDroppedMarkdownFile: vi.fn().mockResolvedValue({ ok: false, code: 'CANCELED', message: '已取消。' }),
    openWorkspaceFolder: vi.fn().mockResolvedValue({ ok: false, code: 'CANCELED', message: '已取消。' }),
    openWorkspaceByPath: vi.fn().mockResolvedValue({ ok: false, code: 'CANCELED', message: '已取消。' }),
    getRecentItems: vi.fn().mockResolvedValue({ ok: true, items: [] }),
    saveMarkdownFile: vi.fn().mockResolvedValue({ ok: true }),
    openDefaultEditor: vi.fn().mockResolvedValue({ ok: true }),
    onMenuAction: vi.fn(() => () => {}),
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
    removeRecentItem: vi.fn().mockResolvedValue({ ok: true }),
    emitOpenRequest: (filePath: string) => {
      if (!openRequestHandler) throw new Error('open request handler was not registered');
      openRequestHandler(filePath);
    }
  };
}

describe('App MDX refresh behavior', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.requestAnimationFrame = (callback) => {
      window.setTimeout(() => callback(performance.now()), 0);
      return 1;
    };
    window.cancelAnimationFrame = () => {};
    container = document.createElement('div');
    document.body.appendChild(container);
    mockMdxEditor.setMarkdown.mockReset();
    mockMdxEditor.getMarkdown.mockReset();
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    document.body.innerHTML = '';
    localStorage.clear();
    vi.restoreAllMocks();
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  test('pushes fresh Markdown into MDXEditor when reopening the same document path', async () => {
    const api = createApi([
      createDocument('# 第一版'),
      createDocument('# 第二版')
    ]);
    window.mdViewer = api;
    root = createRoot(container);

    await act(async () => {
      root.render(<I18nProvider><App /></I18nProvider>);
    });

    await act(async () => {
      api.emitOpenRequest('G:\\docs\\same.md');
    });
    expect(mockMdxEditor.setMarkdown).toHaveBeenLastCalledWith('# 第一版');

    mockMdxEditor.setMarkdown.mockClear();

    await act(async () => {
      api.emitOpenRequest('G:\\docs\\same.md');
    });

    expect(mockMdxEditor.setMarkdown).toHaveBeenCalledWith('# 第二版');
  });
});
