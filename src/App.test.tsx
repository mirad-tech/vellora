// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { MarkdownDocument } from './types';

const sampleDoc: MarkdownDocument = {
  path: 'C:\\docs\\sample.md',
  name: 'sample.md',
  content: '# 标题\n\n正文搜索词\n\n[外链](https://example.com)\n',
  modifiedAt: 1,
  size: 32
};

const {
  chooseMarkdownFile,
  openMarkdownFile,
  saveMarkdownFile,
  resolveLocalImage,
  inspectMarkdownLink,
  openExternalUrl,
  getInitialDocument,
  setUnsavedChanges,
  confirmClose,
  onOpenFilePath,
  onCloseRequested,
  onDragDropPaths
} = vi.hoisted(() => ({
  chooseMarkdownFile: vi.fn(),
  openMarkdownFile: vi.fn(),
  saveMarkdownFile: vi.fn(),
  resolveLocalImage: vi.fn(),
  inspectMarkdownLink: vi.fn(),
  openExternalUrl: vi.fn(),
  getInitialDocument: vi.fn(),
  setUnsavedChanges: vi.fn(),
  confirmClose: vi.fn(),
  onOpenFilePath: vi.fn(),
  onCloseRequested: vi.fn(),
  onDragDropPaths: vi.fn()
}));

vi.mock('./api/tauri', () => ({
  chooseMarkdownFile,
  openMarkdownFile,
  saveMarkdownFile,
  resolveLocalImage,
  inspectMarkdownLink,
  openExternalUrl,
  getInitialDocument,
  setUnsavedChanges,
  confirmClose,
  onOpenFilePath,
  onCloseRequested,
  onDragDropPaths
}));

import App from './App';

describe('App', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getInitialDocument.mockResolvedValue({ ok: false, code: 'NO_INITIAL', message: '没有初始文档。' });
    setUnsavedChanges.mockResolvedValue({ ok: true });
    confirmClose.mockResolvedValue({ ok: true });
    chooseMarkdownFile.mockResolvedValue({ ok: true, document: sampleDoc });
    openMarkdownFile.mockResolvedValue({ ok: true, document: sampleDoc });
    saveMarkdownFile.mockResolvedValue({
      ok: true,
      document: { ...sampleDoc, content: '# 标题\n\n已保存\n' }
    });
    resolveLocalImage.mockResolvedValue({
      ok: false,
      code: 'IMAGE_NOT_FOUND',
      message: '图片不存在或已被移动。'
    });
    inspectMarkdownLink.mockResolvedValue({
      ok: true,
      action: 'external',
      url: 'https://example.com/'
    });
    openExternalUrl.mockResolvedValue({ ok: true });
    onOpenFilePath.mockResolvedValue(() => undefined);
    onCloseRequested.mockResolvedValue(() => undefined);
    onDragDropPaths.mockResolvedValue(() => undefined);
  });

  afterEach(() => {
    cleanup();
  });

  test('shows empty state and opens a file', async () => {
    render(<App />);
    expect(screen.getByTestId('empty-state')).toBeTruthy();
    expect(screen.getByTestId('empty-state').textContent).toContain('未打开文件');

    fireEvent.click(screen.getByTestId('btn-open'));

    await waitFor(() => {
      expect(screen.getByTestId('markdown-body')).toBeTruthy();
    });
    expect(screen.getByText('标题')).toBeTruthy();
    expect(chooseMarkdownFile).toHaveBeenCalled();
  });

  test('switches between read and edit modes', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());

    fireEvent.click(screen.getByTestId('btn-edit'));
    const editor = screen.getByTestId('source-editor') as HTMLTextAreaElement;
    expect(editor.value).toContain('# 标题');

    fireEvent.change(editor, { target: { value: '# 新标题' } });
    fireEvent.click(screen.getByTestId('btn-read'));
    await waitFor(() => {
      expect(screen.getByTestId('markdown-body').textContent).toContain('新标题');
    });
  });

  test('tracks dirty state and saves with button', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());

    fireEvent.click(screen.getByTestId('btn-edit'));
    fireEvent.change(screen.getByTestId('source-editor'), {
      target: { value: '# 标题\n\n已保存\n' }
    });

    await waitFor(() => {
      expect(setUnsavedChanges).toHaveBeenCalledWith(true);
    });

    fireEvent.click(screen.getByTestId('btn-save'));
    await waitFor(() => {
      expect(saveMarkdownFile).toHaveBeenCalledWith(sampleDoc.path, '# 标题\n\n已保存\n');
    });
    await waitFor(() => {
      expect(setUnsavedChanges).toHaveBeenCalledWith(false);
    });
  });

  test('save failure shows error label', async () => {
    saveMarkdownFile.mockResolvedValueOnce({
      ok: false,
      code: 'SAVE_FAILED',
      message: '保存失败，请检查权限或文件状态。'
    });

    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());

    fireEvent.click(screen.getByTestId('btn-edit'));
    fireEvent.change(screen.getByTestId('source-editor'), { target: { value: 'x' } });
    fireEvent.click(screen.getByTestId('btn-save'));

    await waitFor(() => {
      expect(screen.getByTestId('btn-save').textContent).toBe('保存失败');
    });
  });

  test('prompts discard when opening another file while dirty', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());

    fireEvent.click(screen.getByTestId('btn-edit'));
    fireEvent.change(screen.getByTestId('source-editor'), { target: { value: 'dirty' } });

    chooseMarkdownFile.mockClear();
    fireEvent.click(screen.getByTestId('btn-open'));

    expect(screen.getByTestId('discard-modal')).toBeTruthy();
    expect(chooseMarkdownFile).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('discard-cancel'));
    expect(screen.queryByTestId('discard-modal')).toBeNull();
  });

  test('document search finds matches', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());

    fireEvent.click(screen.getByTestId('btn-search'));
    const input = screen.getByTestId('search-input');
    fireEvent.change(input, { target: { value: '搜索词' } });

    await waitFor(() => {
      expect(screen.getByTestId('search-count').textContent).toMatch(/1\/1/);
    });
    expect(screen.getByTestId('markdown-body').querySelector('mark.search-hit')).toBeTruthy();
  });

  test('external link confirmation flow', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());

    const link = screen.getByTestId('markdown-body').querySelector('a');
    expect(link).toBeTruthy();
    fireEvent.click(link!);

    await waitFor(() => expect(screen.getByTestId('external-link-modal')).toBeTruthy());
    fireEvent.click(screen.getByTestId('external-confirm'));

    await waitFor(() => {
      expect(openExternalUrl).toHaveBeenCalledWith('https://example.com/');
    });
  });

  test('outline panel lists headings', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());

    fireEvent.click(screen.getByTestId('btn-outline'));
    expect(screen.getByTestId('outline-panel')).toBeTruthy();
    expect(screen.getByTestId('outline-item').textContent).toBe('标题');
  });

  test('Ctrl+S triggers save', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());

    fireEvent.click(screen.getByTestId('btn-edit'));
    fireEvent.change(screen.getByTestId('source-editor'), { target: { value: 'saved via key' } });

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true })
      );
    });

    await waitFor(() => {
      expect(saveMarkdownFile).toHaveBeenCalled();
    });
  });
});
