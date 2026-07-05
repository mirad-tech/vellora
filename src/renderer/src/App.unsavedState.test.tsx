// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { App } from './App';
import { I18nProvider } from './i18n/I18nContext';
import type { MdViewerApi } from '../../preload/types';
import type { MarkdownDocument } from '../../shared/documentTypes';

const mockSetMarkdown = vi.fn();
const mockGetMarkdown = vi.fn(() => '# Sample\n');
let latestMdxOnChange: ((markdown: string, initialMarkdownNormalize: boolean) => void) | null = null;

vi.mock('@mdxeditor/editor', async (importOriginal) => {
  const original = await importOriginal<typeof import('@mdxeditor/editor')>();
  return {
    ...original,
    MDXEditor: React.forwardRef((props: any, ref: any) => {
      latestMdxOnChange = props.onChange;
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
  getMenuActionHandler: () => ((action: string) => void) | null;
};

let currentHarness: TestHarness | null = null;
let currentApi:
  | (MdViewerApi & {
      getMenuActionHandler: () => ((action: string) => void) | null;
    })
  | null = null;

function createDocument(overrides: Partial<MarkdownDocument> = {}): MarkdownDocument {
  return {
    path: 'G:\\docs\\sample.md',
    name: 'sample.md',
    content: '# Sample',
    modifiedAt: 1_700_000_000_000,
    size: 8,
    ...overrides
  };
}

function createApi(): MdViewerApi & {
  getMenuActionHandler: () => ((action: string) => void) | null;
} {
  let menuActionHandler: ((action: string) => void) | null = null;

  return {
    openMarkdownFile: vi.fn().mockResolvedValue({ ok: true, document: createDocument() }),
    openMarkdownByPath: vi.fn().mockResolvedValue({ ok: false, code: 'CANCELED', message: 'Canceled.' }),
    onMarkdownOpenRequested: vi.fn(() => () => {}),
    openDroppedMarkdownFile: vi.fn().mockResolvedValue({ ok: false, code: 'CANCELED', message: 'Canceled.' }),
    openWorkspaceFolder: vi.fn().mockResolvedValue({ ok: false, code: 'CANCELED', message: 'Canceled.' }),
    openWorkspaceByPath: vi.fn().mockResolvedValue({ ok: false, code: 'CANCELED', message: 'Canceled.' }),
    getRecentItems: vi.fn().mockResolvedValue({ ok: true, items: [] }),
    saveMarkdownFile: vi.fn().mockResolvedValue({ ok: true, document: createDocument() }),
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
      message: 'Unsupported image.'
    }),
    openMarkdownLink: vi.fn().mockResolvedValue({
      ok: false,
      code: 'UNSUPPORTED_LINK',
      message: 'Unsupported link.'
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
    getMenuActionHandler: () => menuActionHandler
  };
}

async function renderApp(): Promise<TestHarness> {
  window.requestAnimationFrame = (callback) => {
    window.setTimeout(() => callback(performance.now()), 0);
    return 1;
  };
  window.cancelAnimationFrame = () => {};

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(<I18nProvider><App /></I18nProvider>);
  });

  currentHarness = {
    container,
    root,
    getMenuActionHandler: () => currentApi?.getMenuActionHandler() ?? null
  };
  return currentHarness;
}

async function openDocument(getMenuActionHandler: () => ((action: string) => void) | null): Promise<void> {
  const handler = getMenuActionHandler();
  await act(async () => {
    handler?.('open-file');
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function enterSourceEditMode(getMenuActionHandler: () => ((action: string) => void) | null): Promise<void> {
  const handler = getMenuActionHandler();
  await act(async () => {
    handler?.('toggle-source-edit');
  });
}

async function changeTextareaValue(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function waitForAsyncWork(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function setUnsavedCalls(): boolean[] {
  const mock = vi.mocked(currentApi!.setUnsavedChanges);
  return mock.mock.calls.map(([value]) => value);
}

async function waitForSetUnsavedValue(value: boolean): Promise<void> {
  await vi.waitFor(() => {
    expect(setUnsavedCalls()).toContain(value);
  });
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  currentApi = createApi();
  window.mdViewer = currentApi;
  latestMdxOnChange = null;
  mockSetMarkdown.mockClear();
  mockGetMarkdown.mockClear();
});

afterEach(async () => {
  if (currentHarness) {
    await act(async () => {
      currentHarness?.root.unmount();
    });
  }
  currentHarness = null;
  currentApi = null;
  latestMdxOnChange = null;
  document.body.innerHTML = '';
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  vi.restoreAllMocks();
});

describe('App unsaved state', () => {
  test('keeps an untouched document clean when switching to source mode', async () => {
    const { container, getMenuActionHandler } = await renderApp();
    await openDocument(getMenuActionHandler);

    const handler = getMenuActionHandler();
    await act(async () => {
      handler?.('toggle-source-edit');
    });

    expect(container.querySelector('[data-testid="source-editor"]')).not.toBeNull();
    expect((container.querySelector('[data-testid="source-editor"]') as HTMLTextAreaElement).value).toBe('# Sample');
    expect(container.querySelector('.save-badge')?.textContent).toContain('Saved');
    expect(setUnsavedCalls()).not.toContain(true);
  });

  test('does not save MDX-normalized output when the document is clean', async () => {
    const { getMenuActionHandler } = await renderApp();
    await openDocument(getMenuActionHandler);

    const handler = getMenuActionHandler();
    await act(async () => {
      handler?.('save-document');
    });

    expect(currentApi!.saveMarkdownFile).not.toHaveBeenCalled();
    expect(setUnsavedCalls()).not.toContain(true);
  });

  test('does not mark a clean document dirty when exporting to PDF', async () => {
    const { getMenuActionHandler } = await renderApp();
    await openDocument(getMenuActionHandler);

    const handler = getMenuActionHandler();
    await act(async () => {
      handler?.('export-pdf');
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(currentApi!.exportToPdf).toHaveBeenCalledTimes(1);
    expect(setUnsavedCalls()).not.toContain(true);
  });

  test('still syncs real WYSIWYG edits into source mode', async () => {
    mockGetMarkdown.mockReturnValue('# Changed');
    const { container, getMenuActionHandler } = await renderApp();
    await openDocument(getMenuActionHandler);

    await act(async () => {
      latestMdxOnChange?.('# Changed', false);
    });

    const handler = getMenuActionHandler();
    await act(async () => {
      handler?.('toggle-source-edit');
    });

    expect((container.querySelector('[data-testid="source-editor"]') as HTMLTextAreaElement).value).toBe('# Changed');
    expect(setUnsavedCalls()).toContain(true);
  });

  test('asks before opening URL-encoded Markdown links from a dirty document', async () => {
    const encodedLinks = [
      {
        href: '%E4%B8%8B%E4%B8%80%E7%AF%87%2Emd?source=encoded#top',
        target: createDocument({ path: 'G:\\docs\\next.md', name: 'next.md', content: '# Next' })
      },
      {
        href: '%E9%99%84%E5%BD%95%2Emarkdown#top',
        target: createDocument({ path: 'G:\\docs\\appendix.markdown', name: 'appendix.markdown', content: '# Appendix' })
      }
    ];

    for (const link of encodedLinks) {
      const { container, getMenuActionHandler } = await renderApp();
      await openDocument(getMenuActionHandler);
      await enterSourceEditMode(getMenuActionHandler);
      await changeTextareaValue(container.querySelector('[data-testid="source-editor"]') as HTMLTextAreaElement, '# Draft');
      vi.mocked(currentApi!.confirmDiscardChanges).mockResolvedValueOnce({ action: 'cancel' });
      vi.mocked(currentApi!.openMarkdownLink).mockResolvedValueOnce({
        ok: true,
        action: 'markdown',
        document: link.target
      });
      vi.mocked(currentApi!.confirmDiscardChanges).mockClear();
      vi.mocked(currentApi!.openMarkdownLink).mockClear();

      await enterSourceEditMode(getMenuActionHandler);
      const anchor = document.createElement('a');
      anchor.href = link.href;
      anchor.textContent = 'Encoded';
      container.querySelector('[data-testid="markdown-body"]')?.append(anchor);

      await act(async () => {
        anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
      });
      await waitForAsyncWork();

      expect(currentApi!.confirmDiscardChanges).toHaveBeenCalledTimes(1);
      expect(currentApi!.openMarkdownLink).not.toHaveBeenCalled();
      expect(container.querySelector('.save-badge')?.textContent).toContain('Draft');

      vi.mocked(currentApi!.confirmDiscardChanges).mockResolvedValueOnce({ action: 'discard' });
      await act(async () => {
        anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
      });
      await waitForAsyncWork();

      expect(currentApi!.confirmDiscardChanges).toHaveBeenCalledTimes(2);
      expect(currentApi!.openMarkdownLink).toHaveBeenCalledWith('G:\\docs\\sample.md', link.href);
      expect(container.querySelector('[data-testid="status-file-path"]')?.textContent).toBe(link.target.path);

      await act(async () => {
        currentHarness?.root.unmount();
      });
      currentHarness = null;
      document.body.innerHTML = '';
      currentApi = createApi();
      window.mdViewer = currentApi;
    }
  });

  test('resyncs main unsaved protection after discarding then canceling open file', async () => {
    let mainUnsaved = false;
    const mainUnsavedSnapshots: boolean[] = [];
    currentApi!.setUnsavedChanges = vi.fn().mockImplementation((value: boolean) => {
      mainUnsaved = value;
      return Promise.resolve({ ok: true });
    });
    currentApi!.confirmDiscardChanges = vi.fn().mockImplementation(() => {
      mainUnsaved = false;
      return Promise.resolve({ action: 'discard' });
    });
    currentApi!.getRecentItems = vi.fn().mockImplementation(() => {
      mainUnsavedSnapshots.push(mainUnsaved);
      return Promise.resolve({ ok: true, items: [] });
    });
    const { container, getMenuActionHandler } = await renderApp();
    await openDocument(getMenuActionHandler);
    await enterSourceEditMode(getMenuActionHandler);
    await changeTextareaValue(container.querySelector('[data-testid="source-editor"]') as HTMLTextAreaElement, '# Draft');
    await waitForSetUnsavedValue(true);
    await waitForAsyncWork();
    await waitForAsyncWork();
    vi.mocked(currentApi!.setUnsavedChanges).mockClear();
    mainUnsaved = true;
    await waitForAsyncWork();
    expect(setUnsavedCalls()).toEqual([]);
    vi.mocked(currentApi!.openMarkdownFile).mockResolvedValueOnce({
      ok: false,
      code: 'CANCELED',
      message: 'Canceled.'
    });

    const handler = getMenuActionHandler();
    await act(async () => {
      handler?.('open-file');
    });
    await waitForAsyncWork();

    expect(currentApi!.confirmDiscardChanges).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="source-editor"]')).not.toBeNull();
    expect(container.querySelector('.save-badge')?.textContent).toContain('Draft');
    expect(mainUnsaved).toBe(true);
    expect(mainUnsavedSnapshots.at(-1)).toBe(true);
    expect(setUnsavedCalls()).toContain(true);
  });

  test('keeps pending WYSIWYG edits protected when an unsupported link fails', async () => {
    mockGetMarkdown.mockReturnValue('# Changed');
    currentApi!.openMarkdownFile = vi.fn().mockResolvedValue({
      ok: true,
      document: createDocument({ content: '# Sample\n\n[Notes](notes.txt)' })
    });
    const { container, getMenuActionHandler } = await renderApp();
    await openDocument(getMenuActionHandler);
    vi.mocked(currentApi!.setUnsavedChanges).mockClear();

    await act(async () => {
      latestMdxOnChange?.('# Changed', false);
    });
    await waitForAsyncWork();

    const anchor = document.createElement('a');
    anchor.href = 'notes.txt';
    anchor.textContent = 'Notes';
    container.querySelector('[data-testid="markdown-body"]')?.append(anchor);

    await act(async () => {
      anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
    });
    await waitForAsyncWork();

    expect(currentApi!.openMarkdownLink).toHaveBeenCalledWith('G:\\docs\\sample.md', 'notes.txt');
    expect(container.querySelector('[data-testid="save-error"]')?.textContent).toContain('Unsupported link.');
    expect(setUnsavedCalls().at(-1)).toBe(true);
  });

  test('keeps explicit https links external when they collide with local Markdown targets', async () => {
    currentApi!.openMarkdownFile = vi.fn().mockResolvedValue({
      ok: true,
      document: createDocument({ content: '# Sample\n\n[Local](foo.md)\n\n[External](https://foo.md)' })
    });
    const { container, getMenuActionHandler } = await renderApp();
    await openDocument(getMenuActionHandler);
    await enterSourceEditMode(getMenuActionHandler);
    await changeTextareaValue(
      container.querySelector('[data-testid="source-editor"]') as HTMLTextAreaElement,
      '# Draft\n\n[Local](foo.md)\n\n[External](https://foo.md)'
    );
    await enterSourceEditMode(getMenuActionHandler);
    vi.mocked(currentApi!.confirmDiscardChanges).mockClear();
    vi.mocked(currentApi!.openMarkdownLink).mockClear();

    const anchor = document.createElement('a');
    anchor.setAttribute('href', 'https://foo.md');
    anchor.textContent = 'External';
    container.querySelector('[data-testid="markdown-body"]')?.append(anchor);

    await act(async () => {
      anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
    });
    await waitForAsyncWork();

    expect(currentApi!.confirmDiscardChanges).not.toHaveBeenCalled();
    expect(currentApi!.openMarkdownLink).not.toHaveBeenCalled();
    expect(container.querySelector('.link-confirm-modal-card')).not.toBeNull();
    expect(container.querySelector('.target-url-text')?.textContent).toContain('https://foo.md');
    expect(container.querySelector('.save-badge')?.textContent).toContain('Draft');
  });

  test('restores normalized local links when explicit https links share the same target', async () => {
    currentApi!.openMarkdownFile = vi.fn().mockResolvedValue({
      ok: true,
      document: createDocument({ content: '# Sample\n\n[Local](foo.md)\n\n[External](https://foo.md)' })
    });
    vi.mocked(currentApi!.openMarkdownLink).mockResolvedValueOnce({
      ok: true,
      action: 'markdown',
      document: createDocument({ path: 'G:\\docs\\foo.md', name: 'foo.md', content: '# Foo' })
    });
    const { container, getMenuActionHandler } = await renderApp();
    await openDocument(getMenuActionHandler);
    await enterSourceEditMode(getMenuActionHandler);
    await changeTextareaValue(
      container.querySelector('[data-testid="source-editor"]') as HTMLTextAreaElement,
      '# Draft\n\n[Local](foo.md)\n\n[External](https://foo.md)'
    );
    await enterSourceEditMode(getMenuActionHandler);
    vi.mocked(currentApi!.confirmDiscardChanges).mockClear();
    vi.mocked(currentApi!.openMarkdownLink).mockClear();
    vi.mocked(currentApi!.openMarkdownLink).mockResolvedValueOnce({
      ok: true,
      action: 'markdown',
      document: createDocument({ path: 'G:\\docs\\foo.md', name: 'foo.md', content: '# Foo' })
    });

    const anchor = document.createElement('a');
    anchor.setAttribute('href', 'https://foo.md');
    anchor.textContent = 'Local';
    container.querySelector('[data-testid="markdown-body"]')?.append(anchor);

    await act(async () => {
      anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
    });
    await waitForAsyncWork();

    expect(currentApi!.confirmDiscardChanges).toHaveBeenCalledTimes(1);
    expect(currentApi!.openMarkdownLink).toHaveBeenCalledWith('G:\\docs\\sample.md', 'foo.md');
    expect(container.querySelector('.link-confirm-modal-card')).toBeNull();
    expect(container.querySelector('[data-testid="status-file-path"]')?.textContent).toBe('G:\\docs\\foo.md');
  });

  test('keeps explicit https links external when local and external links use the same text', async () => {
    currentApi!.openMarkdownFile = vi.fn().mockResolvedValue({
      ok: true,
      document: createDocument({ content: '# Sample\n\n[Docs](foo.md)\n\n[Docs](https://foo.md)' })
    });
    const { container, getMenuActionHandler } = await renderApp();
    await openDocument(getMenuActionHandler);
    await enterSourceEditMode(getMenuActionHandler);
    await changeTextareaValue(
      container.querySelector('[data-testid="source-editor"]') as HTMLTextAreaElement,
      '# Draft\n\n[Docs](foo.md)\n\n[Docs](https://foo.md)'
    );
    await enterSourceEditMode(getMenuActionHandler);
    vi.mocked(currentApi!.confirmDiscardChanges).mockClear();
    vi.mocked(currentApi!.openMarkdownLink).mockClear();

    const markdownBody = container.querySelector('[data-testid="markdown-body"]');
    const localAnchor = document.createElement('a');
    localAnchor.setAttribute('href', 'https://foo.md');
    localAnchor.textContent = 'Docs';
    const externalAnchor = document.createElement('a');
    externalAnchor.setAttribute('href', 'https://foo.md');
    externalAnchor.textContent = 'Docs';
    markdownBody?.append(localAnchor, externalAnchor);

    await act(async () => {
      externalAnchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
    });
    await waitForAsyncWork();

    expect(currentApi!.confirmDiscardChanges).not.toHaveBeenCalled();
    expect(currentApi!.openMarkdownLink).not.toHaveBeenCalled();
    expect(container.querySelector('.link-confirm-modal-card')).not.toBeNull();
    expect(container.querySelector('.target-url-text')?.textContent).toContain('https://foo.md');
    expect(container.querySelector('.save-badge')?.textContent).toContain('Draft');
  });
});
