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
  openMarkdownLink,
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
  openMarkdownLink: vi.fn(),
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
  openMarkdownLink,
  openExternalUrl,
  getInitialDocument,
  setUnsavedChanges,
  confirmClose,
  onOpenFilePath,
  onCloseRequested,
  onDragDropPaths
}));

import App from './App';

async function pressCtrlKey(key: string): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true }));
  });
}

describe('App', () => {
  /** Captured from onCloseRequested so tests can invoke close protection. */
  let closeRequestedHandler: (() => void) | null = null;
  let openFilePathHandler: ((path: string) => void) | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    closeRequestedHandler = null;
    openFilePathHandler = null;
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
    openMarkdownLink.mockResolvedValue({
      ok: true,
      document: {
        path: 'C:\\docs\\other.md',
        name: 'other.md',
        content: '# 目标文档\n',
        modifiedAt: 2,
        size: 16
      }
    });
    openExternalUrl.mockResolvedValue({ ok: true });
    onOpenFilePath.mockImplementation((handler: (path: string) => void) => {
      openFilePathHandler = handler;
      return Promise.resolve(() => {
        if (openFilePathHandler === handler) {
          openFilePathHandler = null;
        }
      });
    });
    onCloseRequested.mockImplementation((handler: () => void) => {
      closeRequestedHandler = handler;
      return Promise.resolve(() => {
        if (closeRequestedHandler === handler) {
          closeRequestedHandler = null;
        }
      });
    });
    onDragDropPaths.mockResolvedValue(() => undefined);
  });

  afterEach(() => {
    closeRequestedHandler = null;
    openFilePathHandler = null;
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

    expect(screen.getByTestId('btn-read').textContent).toBe('预览');
    expect(screen.getByTestId('btn-edit').textContent).toBe('源码');
    expect(screen.getByTestId('status-text').textContent).toBe('Markdown 文档');

    fireEvent.click(screen.getByTestId('btn-edit'));
    const editor = screen.getByTestId('source-editor') as HTMLTextAreaElement;
    expect(editor.value).toContain('# 标题');

    fireEvent.change(editor, { target: { value: '# 新标题' } });
    fireEvent.click(screen.getByTestId('btn-read'));
    await waitFor(() => {
      expect(screen.getByTestId('markdown-body').textContent).toContain('新标题');
    });
  });

  test('tracks dirty state and saves with shortcut', async () => {
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

    await pressCtrlKey('s');
    await waitFor(() => {
      expect(saveMarkdownFile).toHaveBeenCalledWith(sampleDoc.path, '# 标题\n\n已保存\n');
    });
    await waitFor(() => {
      expect(setUnsavedChanges).toHaveBeenCalledWith(false);
    });
  });

  test('save failure shows error status', async () => {
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
    await pressCtrlKey('s');

    await waitFor(() => {
      expect(screen.getByTestId('status-text').textContent).toContain('保存失败');
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

    await pressCtrlKey('f');
    const input = screen.getByTestId('search-input');
    fireEvent.change(input, { target: { value: '搜索词' } });

    await waitFor(() => {
      expect(screen.getByTestId('search-count').textContent).toMatch(/1\s*\/\s*1/);
    });
    expect(screen.getByTestId('markdown-body').querySelector('mark.search-hit')).toBeTruthy();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByTestId('search-bar')).toBeNull();
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
    expect(screen.getByTestId('outline-item').getAttribute('aria-current')).toBe('location');
  });

  test('opening outline selects the heading at the current scroll position', async () => {
    chooseMarkdownFile.mockResolvedValueOnce({
      ok: true,
      document: {
        ...sampleDoc,
        content: '# 第一节\n\n正文\n\n## 第二节\n\n更多正文\n'
      }
    });

    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());

    const content = screen.getByTestId('content');
    const headings = screen.getByTestId('markdown-body').querySelectorAll<HTMLElement>('h1, h2');
    vi.spyOn(content, 'getBoundingClientRect').mockReturnValue({ top: 0 } as DOMRect);
    vi.spyOn(headings[0], 'getBoundingClientRect').mockReturnValue({ top: -180 } as DOMRect);
    vi.spyOn(headings[1], 'getBoundingClientRect').mockReturnValue({ top: 40 } as DOMRect);

    fireEvent.click(screen.getByTestId('btn-outline'));

    await waitFor(() => {
      const items = screen.getAllByTestId('outline-item');
      expect(items[0].getAttribute('aria-current')).toBeNull();
      expect(items[1].getAttribute('aria-current')).toBe('location');
    });
  });

  test('Ctrl+S triggers save', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());

    fireEvent.click(screen.getByTestId('btn-edit'));
    fireEvent.change(screen.getByTestId('source-editor'), { target: { value: 'saved via key' } });

    await pressCtrlKey('s');

    await waitFor(() => {
      expect(saveMarkdownFile).toHaveBeenCalled();
    });
  });

  test('dirty local link cancel does not call openMarkdownLink; save still uses source path', async () => {
    const localDoc: MarkdownDocument = {
      path: 'C:\\docs\\source.md',
      name: 'source.md',
      content: '# 源\n\n[本地](./other.md)\n',
      modifiedAt: 1,
      size: 24
    };
    chooseMarkdownFile.mockResolvedValueOnce({ ok: true, document: localDoc });
    inspectMarkdownLink.mockResolvedValueOnce({
      ok: true,
      action: 'markdown',
      document: {
        path: 'C:\\docs\\other.md',
        name: 'other.md',
        content: '# 目标\n',
        modifiedAt: 2,
        size: 8
      }
    });

    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());

    fireEvent.click(screen.getByTestId('btn-edit'));
    fireEvent.change(screen.getByTestId('source-editor'), {
      target: { value: '# 源\n\n[本地](./other.md)\n\n草稿\n' }
    });
    fireEvent.click(screen.getByTestId('btn-read'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());

    const link = screen.getByTestId('markdown-body').querySelector('a');
    expect(link).toBeTruthy();
    fireEvent.click(link!);

    await waitFor(() => expect(screen.getByTestId('discard-modal')).toBeTruthy());
    fireEvent.click(screen.getByTestId('discard-cancel'));
    expect(openMarkdownLink).not.toHaveBeenCalled();

    await pressCtrlKey('s');
    await waitFor(() => {
      expect(saveMarkdownFile).toHaveBeenCalledWith(
        'C:\\docs\\source.md',
        '# 源\n\n[本地](./other.md)\n\n草稿\n'
      );
    });
  });

  test('openMarkdownLink NOT_FOUND keeps source draft, dirty state, and close protection', async () => {
    const localDoc: MarkdownDocument = {
      path: 'C:\\docs\\source.md',
      name: 'source.md',
      content: '# 源\n\n[本地](./other.md)\n',
      modifiedAt: 1,
      size: 24
    };
    chooseMarkdownFile.mockResolvedValueOnce({ ok: true, document: localDoc });
    inspectMarkdownLink.mockResolvedValueOnce({
      ok: true,
      action: 'markdown',
      document: {
        path: 'C:\\docs\\other.md',
        name: 'other.md',
        content: '# 目标\n',
        modifiedAt: 2,
        size: 8
      }
    });
    openMarkdownLink.mockResolvedValueOnce({
      ok: false,
      code: 'NOT_FOUND',
      message: '文件不存在或已被移动。'
    });

    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());

    const draft = '# 源\n\n[本地](./other.md)\n\n草稿保留\n';
    fireEvent.click(screen.getByTestId('btn-edit'));
    fireEvent.change(screen.getByTestId('source-editor'), { target: { value: draft } });
    fireEvent.click(screen.getByTestId('btn-read'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());

    fireEvent.click(screen.getByTestId('markdown-body').querySelector('a')!);
    await waitFor(() => expect(screen.getByTestId('discard-modal')).toBeTruthy());
    setUnsavedChanges.mockClear();
    fireEvent.click(screen.getByTestId('discard-confirm'));

    await waitFor(() => {
      expect(inspectMarkdownLink).toHaveBeenCalledWith('C:\\docs\\source.md', './other.md');
      expect(openMarkdownLink).toHaveBeenCalledWith('C:\\docs\\source.md', './other.md');
    });
    await waitFor(() => {
      const calls = setUnsavedChanges.mock.calls.map((c) => c[0]);
      expect(calls[calls.length - 1]).toBe(true);
    });
    expect(screen.getByTestId('markdown-body').textContent).toContain('源');
    expect(screen.getByTestId('markdown-body').textContent).toContain('草稿保留');
    expect(screen.queryByText('目标')).toBeNull();
    // Failed open surfaces the error message but must not switch the document session.
    expect(screen.getByTestId('status-text').textContent).toContain('文件不存在或已被移动');

    // Source path + draft still present in editor.
    fireEvent.click(screen.getByTestId('btn-edit'));
    expect((screen.getByTestId('source-editor') as HTMLTextAreaElement).value).toBe(draft);
    fireEvent.click(screen.getByTestId('btn-read'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());

    // Close protection must still treat the session as dirty.
    expect(closeRequestedHandler).toBeTypeOf('function');
    await act(async () => {
      closeRequestedHandler!();
    });
    await waitFor(() => expect(screen.getByTestId('discard-modal')).toBeTruthy());

    fireEvent.click(screen.getByTestId('discard-cancel'));
    expect(screen.queryByTestId('discard-modal')).toBeNull();
    expect(confirmClose).not.toHaveBeenCalled();

    await act(async () => {
      closeRequestedHandler!();
    });
    await waitFor(() => expect(screen.getByTestId('discard-modal')).toBeTruthy());
    fireEvent.click(screen.getByTestId('discard-confirm'));
    await waitFor(() => {
      expect(confirmClose).toHaveBeenCalledTimes(1);
      expect(confirmClose).toHaveBeenCalledWith(true);
    });

    // Failed open must still save back to the source path, never a dead target path.
    await pressCtrlKey('s');
    await waitFor(() => {
      expect(saveMarkdownFile).toHaveBeenCalledWith('C:\\docs\\source.md', draft);
    });
  });

  test('openMarkdownFile failure after discard keeps source draft and dirty', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());

    fireEvent.click(screen.getByTestId('btn-edit'));
    fireEvent.change(screen.getByTestId('source-editor'), {
      target: { value: '# 标题\n\n草稿打开失败\n' }
    });

    // Simulate single-instance / path open after discard
    openMarkdownFile.mockResolvedValueOnce({
      ok: false,
      code: 'NOT_FOUND',
      message: '文件不存在或已被移动。'
    });

    // Trigger openPath via onOpenFilePath handler registered on mount — call choose flow:
    // Use discard then failed choose is separate; here fire path open by re-using open API:
    // Click open, discard, then mock choose to fail... use openMarkdownFile via drop:
    // Easiest: confirm dirty open file with choose that fails
    chooseMarkdownFile.mockResolvedValueOnce({
      ok: false,
      code: 'READ_FAILED',
      message: '无法读取文件，请检查权限或文件状态。'
    });
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('discard-modal')).toBeTruthy());
    setUnsavedChanges.mockClear();
    fireEvent.click(screen.getByTestId('discard-confirm'));

    await waitFor(() => {
      expect(chooseMarkdownFile).toHaveBeenCalled();
    });
    await waitFor(() => {
      const calls = setUnsavedChanges.mock.calls.map((c) => c[0]);
      expect(calls[calls.length - 1]).toBe(true);
    });
    fireEvent.click(screen.getByTestId('btn-edit'));
    expect((screen.getByTestId('source-editor') as HTMLTextAreaElement).value).toContain(
      '草稿打开失败'
    );
  });

  test('pending open disables editing and failed open preserves the current draft', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());

    fireEvent.click(screen.getByTestId('btn-edit'));
    fireEvent.change(screen.getByTestId('source-editor'), {
      target: { value: '# 标题\n\n请求前草稿\n' }
    });

    type FailedOpen = { ok: false; code: 'READ_FAILED'; message: string };
    let resolveOpen!: (value: FailedOpen) => void;
    chooseMarkdownFile.mockReturnValueOnce(
      new Promise<FailedOpen>((resolve) => {
        resolveOpen = resolve;
      })
    );

    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('discard-modal')).toBeTruthy());
    fireEvent.click(screen.getByTestId('discard-confirm'));
    await waitFor(() => expect(chooseMarkdownFile).toHaveBeenCalledTimes(2));

    expect((screen.getByTestId('source-editor') as HTMLTextAreaElement).disabled).toBe(true);

    await act(async () => {
      resolveOpen({
        ok: false,
        code: 'READ_FAILED',
        message: '无法读取文件，请检查权限或文件状态。'
      });
    });

    await waitFor(() => {
      expect((screen.getByTestId('source-editor') as HTMLTextAreaElement).value).toBe(
        '# 标题\n\n请求前草稿\n'
      );
      expect((screen.getByTestId('source-editor') as HTMLTextAreaElement).disabled).toBe(false);
      expect(screen.getByTestId('status-text').textContent).toContain('无法读取文件');
    });
    const dirtyCalls = setUnsavedChanges.mock.calls.map((call) => call[0]);
    expect(dirtyCalls[dirtyCalls.length - 1]).toBe(true);
  });

  test('an older open result cannot replace a newer opened document', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());

    const oldDoc: MarkdownDocument = {
      path: 'C:\\docs\\old.md',
      name: 'old.md',
      content: '# 旧请求结果\n',
      modifiedAt: 2,
      size: 10
    };
    const newDoc: MarkdownDocument = {
      path: 'C:\\docs\\new.md',
      name: 'new.md',
      content: '# 新请求结果\n',
      modifiedAt: 3,
      size: 10
    };

    type SuccessfulOpen = { ok: true; document: MarkdownDocument };
    let resolveOldOpen!: (value: SuccessfulOpen) => void;
    openMarkdownFile
      .mockReset()
      .mockReturnValueOnce(
        new Promise<SuccessfulOpen>((resolve) => {
          resolveOldOpen = resolve;
        })
      )
      .mockResolvedValueOnce({ ok: true, document: newDoc });

    await waitFor(() => expect(openFilePathHandler).toBeTypeOf('function'));
    act(() => {
      openFilePathHandler!('C:\\docs\\old.md');
    });
    await waitFor(() => expect(openMarkdownFile).toHaveBeenCalledTimes(1));
    act(() => {
      openFilePathHandler!('C:\\docs\\new.md');
    });
    await waitFor(() => expect(openMarkdownFile).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(screen.getByTestId('markdown-body').textContent).toContain('新请求结果');
    });

    await act(async () => {
      resolveOldOpen({ ok: true, document: oldDoc });
    });

    expect(screen.getByTestId('markdown-body').textContent).toContain('新请求结果');
    expect(screen.queryByText('旧请求结果')).toBeNull();
  });

  test('chooseMarkdownFile CANCELED after discard keeps dirty document', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());

    fireEvent.click(screen.getByTestId('btn-edit'));
    fireEvent.change(screen.getByTestId('source-editor'), {
      target: { value: '# 标题\n\n取消选择草稿\n' }
    });

    chooseMarkdownFile.mockResolvedValueOnce({
      ok: false,
      code: 'CANCELED',
      message: '已取消。'
    });
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('discard-modal')).toBeTruthy());
    setUnsavedChanges.mockClear();
    fireEvent.click(screen.getByTestId('discard-confirm'));

    await waitFor(() => {
      expect(chooseMarkdownFile).toHaveBeenCalled();
    });
    await waitFor(() => {
      const calls = setUnsavedChanges.mock.calls.map((c) => c[0]);
      expect(calls[calls.length - 1]).toBe(true);
    });
    fireEvent.click(screen.getByTestId('btn-edit'));
    expect((screen.getByTestId('source-editor') as HTMLTextAreaElement).value).toContain(
      '取消选择草稿'
    );
  });

  test('clean local link opens via openMarkdownLink without discard modal', async () => {
    const localDoc: MarkdownDocument = {
      path: 'C:\\docs\\source.md',
      name: 'source.md',
      content: '# 源\n\n[本地](./other.md)\n',
      modifiedAt: 1,
      size: 24
    };
    chooseMarkdownFile.mockResolvedValueOnce({ ok: true, document: localDoc });
    let openResolved = false;
    inspectMarkdownLink.mockResolvedValueOnce({
      ok: true,
      action: 'markdown',
      document: {
        path: 'C:\\docs\\other.md',
        name: 'other.md',
        content: '# 目标文档\n',
        modifiedAt: 2,
        size: 16
      }
    });
    openMarkdownLink.mockImplementationOnce(async () => {
      // Document must not switch from inspect alone before open resolves.
      expect(screen.getByTestId('markdown-body').textContent).toContain('源');
      expect(screen.queryByText('目标文档')).toBeNull();
      openResolved = true;
      return {
        ok: true as const,
        document: {
          path: 'C:\\docs\\other.md',
          name: 'other.md',
          content: '# 目标文档\n',
          modifiedAt: 2,
          size: 16
        }
      };
    });

    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());

    fireEvent.click(screen.getByTestId('markdown-body').querySelector('a')!);
    expect(screen.queryByTestId('discard-modal')).toBeNull();

    await waitFor(() => {
      expect(inspectMarkdownLink).toHaveBeenCalledWith('C:\\docs\\source.md', './other.md');
      expect(openMarkdownLink).toHaveBeenCalledWith('C:\\docs\\source.md', './other.md');
    });
    await waitFor(() => {
      expect(openResolved).toBe(true);
      expect(screen.getByTestId('markdown-body').textContent).toContain('目标文档');
    });
  });

  test('dirty local link discard calls openMarkdownLink and shows target', async () => {
    const localDoc: MarkdownDocument = {
      path: 'C:\\docs\\source.md',
      name: 'source.md',
      content: '# 源\n\n[本地](./other.md)\n',
      modifiedAt: 1,
      size: 24
    };
    chooseMarkdownFile.mockResolvedValueOnce({ ok: true, document: localDoc });
    inspectMarkdownLink.mockResolvedValueOnce({
      ok: true,
      action: 'markdown',
      document: {
        path: 'C:\\docs\\other.md',
        name: 'other.md',
        content: '# 目标文档\n',
        modifiedAt: 2,
        size: 16
      }
    });
    openMarkdownLink.mockResolvedValueOnce({
      ok: true,
      document: {
        path: 'C:\\docs\\other.md',
        name: 'other.md',
        content: '# 目标文档\n',
        modifiedAt: 2,
        size: 16
      }
    });

    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());

    fireEvent.click(screen.getByTestId('btn-edit'));
    fireEvent.change(screen.getByTestId('source-editor'), {
      target: { value: '# 源\n\n[本地](./other.md)\n\n草稿\n' }
    });
    fireEvent.click(screen.getByTestId('btn-read'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());

    fireEvent.click(screen.getByTestId('markdown-body').querySelector('a')!);
    await waitFor(() => expect(screen.getByTestId('discard-modal')).toBeTruthy());
    fireEvent.click(screen.getByTestId('discard-confirm'));

    await waitFor(() => {
      expect(openMarkdownLink).toHaveBeenCalledWith('C:\\docs\\source.md', './other.md');
    });
    await waitFor(() => {
      expect(screen.getByTestId('markdown-body').textContent).toContain('目标文档');
    });
  });

  test('quick edit supports headings, paragraphs, list items, and blockquotes by source range', async () => {
    const document: MarkdownDocument = {
      ...sampleDoc,
      content: '# 标题\r\n\r\n相同内容\r\n\r\n相同内容\r\n\r\n- 列表项\r\n\r\n> 引用内容\r\n'
    };
    chooseMarkdownFile.mockResolvedValueOnce({ ok: true, document });

    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());

    const body = screen.getByTestId('markdown-body');
    for (const kind of ['heading', 'paragraph', 'list-item', 'blockquote']) {
      const block = body.querySelector<HTMLElement>(`[data-edit-block-kind="${kind}"]`);
      expect(block).toBeTruthy();
      fireEvent.click(block!);
      const quickEditor = screen.getByTestId('quick-edit-surface');
      expect(quickEditor).toBe(block);
      expect(quickEditor.getAttribute('contenteditable')).toBe('true');
      fireEvent.keyDown(quickEditor, {
        key: 'Enter',
        ctrlKey: true
      });
      expect(screen.queryByTestId('quick-edit-surface')).toBeNull();
    }

    const duplicateParagraphs = body.querySelectorAll<HTMLElement>(
      '[data-edit-block-kind="paragraph"]'
    );
    const editedPreviewNode = duplicateParagraphs[1];
    fireEvent.click(editedPreviewNode);
    const quickEditor = screen.getByTestId('quick-edit-surface');
    quickEditor.textContent = '只修改第二处';
    fireEvent.input(quickEditor);
    expect(
      body.querySelectorAll<HTMLElement>('[data-edit-block-kind="paragraph"]')[1]
    ).toBe(editedPreviewNode);
    expect(body.textContent).toContain('只修改第二处');
    fireEvent.blur(quickEditor);

    await pressCtrlKey('s');
    await waitFor(() => {
      expect(saveMarkdownFile).toHaveBeenCalledWith(
        sampleDoc.path,
        '# 标题\r\n\r\n相同内容\r\n\r\n只修改第二处\r\n\r\n- 列表项\r\n\r\n> 引用内容\r\n'
      );
    });
  });

  test('quick edit preserves CRLF inside a multiline block', async () => {
    const document: MarkdownDocument = {
      ...sampleDoc,
      content: '# 标题\r\n\r\n第一行\r\n第二行\r\n'
    };
    chooseMarkdownFile.mockResolvedValueOnce({ ok: true, document });
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());

    fireEvent.click(screen.getByTestId('markdown-body').querySelector('p')!);
    const quickEditor = screen.getByTestId('quick-edit-surface');
    expect(quickEditor.textContent).toBe('第一行\n第二行');
    quickEditor.textContent = '第一行已修改\n第二行';
    fireEvent.input(quickEditor);
    fireEvent.blur(quickEditor);
    await pressCtrlKey('s');

    await waitFor(() => {
      expect(saveMarkdownFile).toHaveBeenCalledWith(
        sampleDoc.path,
        '# 标题\r\n\r\n第一行已修改\r\n第二行\r\n'
      );
    });
  });

  test('quick edit stays disabled when rendered content cannot round-trip to the original Markdown', async () => {
    const document: MarkdownDocument = {
      ...sampleDoc,
      content: '# 标题\n\n保留 \\*星号\\*  \n下一行\n'
    };
    chooseMarkdownFile.mockResolvedValueOnce({ ok: true, document });
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());

    fireEvent.click(screen.getByTestId('markdown-body').querySelector('p')!);

    expect(screen.queryByTestId('quick-edit-surface')).toBeNull();
    expect(setUnsavedChanges).not.toHaveBeenCalledWith(true);
  });

  test('IME composition Enter and Escape do not commit or cancel quick edit', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());

    fireEvent.click(screen.getByTestId('markdown-body').querySelector('h1')!);
    const quickEditor = screen.getByTestId('quick-edit-surface');
    quickEditor.textContent = '拼音输入';
    fireEvent.input(quickEditor);

    fireEvent.keyDown(quickEditor, { key: 'Enter', isComposing: true, keyCode: 229 });
    expect(screen.getByTestId('quick-edit-surface')).toBe(quickEditor);
    expect(quickEditor.querySelector('br')).toBeNull();

    fireEvent.keyDown(quickEditor, { key: 'Escape', isComposing: true, keyCode: 229 });
    expect(screen.getByTestId('quick-edit-surface')).toBe(quickEditor);

    fireEvent.keyDown(quickEditor, { key: 'Escape' });
    expect(screen.queryByTestId('quick-edit-surface')).toBeNull();
  });

  test('Escape cancels quick edit and restores the previous dirty state', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());

    fireEvent.click(screen.getByTestId('markdown-body').querySelector('h1')!);
    const quickEditor = screen.getByTestId('quick-edit-surface');
    quickEditor.textContent = '临时标题';
    fireEvent.input(quickEditor);
    await waitFor(() => expect(setUnsavedChanges).toHaveBeenCalledWith(true));

    fireEvent.keyDown(quickEditor, { key: 'Escape' });
    expect(screen.queryByTestId('quick-edit-surface')).toBeNull();
    await waitFor(() => {
      expect(screen.getByTestId('markdown-body').textContent).toContain('标题');
      const calls = setUnsavedChanges.mock.calls.map((call) => call[0]);
      expect(calls[calls.length - 1]).toBe(false);
    });
  });

  test('quick edits use existing close protection and save flow', async () => {
    saveMarkdownFile.mockImplementationOnce(async (path: string, content: string) => ({
      ok: true,
      document: { ...sampleDoc, path, content }
    }));
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());

    fireEvent.click(screen.getByTestId('markdown-body').querySelector('p')!);
    const quickEditor = screen.getByTestId('quick-edit-surface');
    quickEditor.textContent = '阅读模式修改';
    fireEvent.input(quickEditor);
    await act(async () => closeRequestedHandler?.());
    expect(screen.getByTestId('discard-modal')).toBeTruthy();
    fireEvent.click(screen.getByTestId('discard-cancel'));

    await pressCtrlKey('s');
    await waitFor(() => {
      expect(saveMarkdownFile).toHaveBeenCalledWith(
        sampleDoc.path,
        '# 标题\n\n阅读模式修改\n\n[外链](https://example.com)\n'
      );
      const calls = setUnsavedChanges.mock.calls.map((call) => call[0]);
      expect(calls[calls.length - 1]).toBe(false);
    });
  });

  test('links navigate normally until their containing block enters quick edit', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());

    const body = screen.getByTestId('markdown-body');
    const link = body.querySelector('a')!;
    fireEvent.click(link);
    await waitFor(() => expect(screen.getByTestId('external-link-modal')).toBeTruthy());
    expect(screen.queryByTestId('quick-edit-surface')).toBeNull();
    fireEvent.click(screen.getByTestId('external-cancel'));

    fireEvent.click(screen.getByTestId('markdown-body').querySelectorAll('p')[1]);
    const quickEditor = screen.getByTestId('quick-edit-surface');
    fireEvent.click(quickEditor.querySelector('a')!);
    expect(inspectMarkdownLink).toHaveBeenCalledTimes(1);
  });

  test('complex Markdown structures remain read-only', async () => {
    const document: MarkdownDocument = {
      ...sampleDoc,
      content: '- 父项\n  - 子项\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```text\ncode\n```\n'
    };
    chooseMarkdownFile.mockResolvedValueOnce({ ok: true, document });
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());

    const body = screen.getByTestId('markdown-body');
    for (const selector of ['li', 'td', 'pre']) {
      fireEvent.click(body.querySelector(selector)!);
      expect(screen.queryByTestId('quick-edit-surface')).toBeNull();
    }
  });

  test('pending document open blocks quick edit', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());

    type FailedOpen = { ok: false; code: 'READ_FAILED'; message: string };
    let resolveOpen!: (value: FailedOpen) => void;
    chooseMarkdownFile.mockReturnValueOnce(
      new Promise<FailedOpen>((resolve) => {
        resolveOpen = resolve;
      })
    );
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('btn-open')).toHaveProperty('disabled', true));

    fireEvent.click(screen.getByTestId('markdown-body').querySelector('h1')!);
    expect(screen.queryByTestId('quick-edit-surface')).toBeNull();
    await act(async () => {
      resolveOpen({ ok: false, code: 'READ_FAILED', message: '读取失败' });
    });
  });

  test('opening another document clears the active quick editor', async () => {
    const nextDocument: MarkdownDocument = {
      ...sampleDoc,
      path: 'C:\\docs\\next.md',
      name: 'next.md',
      content: '# 下一个文档\n'
    };
    openMarkdownFile.mockResolvedValueOnce({ ok: true, document: nextDocument });
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());
    fireEvent.click(screen.getByTestId('markdown-body').querySelector('h1')!);
    expect(screen.getByTestId('quick-edit-surface')).toBeTruthy();

    await waitFor(() => expect(openFilePathHandler).toBeTypeOf('function'));
    act(() => openFilePathHandler?.('C:\\docs\\next.md'));
    await waitFor(() => {
      expect(screen.queryByTestId('quick-edit-surface')).toBeNull();
      expect(screen.getByTestId('markdown-body').textContent).toContain('下一个文档');
    });
  });
});
