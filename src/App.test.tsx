// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { MarkdownDocument } from './types';
import type { Editor } from '@tiptap/core';

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

async function pressMetaKey(key: string): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey: true, bubbles: true }));
  });
}


function documentEditor(): Editor {
  return (screen.getByTestId('markdown-body') as HTMLElement & { editor: Editor }).editor;
}

async function openSelectedLink(): Promise<void> {
  const editor = documentEditor();
  let position = 1;
  editor.state.doc.descendants((node, pos) => { if (node.marks.some(mark => mark.type.name === 'link')) position = pos; });
  act(() => editor.commands.setTextSelection(position));
  fireEvent.focus(screen.getByTestId('markdown-body'));
  fireEvent.keyDown(screen.getByTestId('markdown-body'), { key: 'Enter', altKey: true });
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

  test('keeps the draft on conflict and scopes overwrite to the confirmed disk revision', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await screen.findByTestId('markdown-body');
    act(() => documentEditor().commands.insertContent('本地修改'));
    saveMarkdownFile.mockResolvedValueOnce({ ok: false, code: 'FILE_CHANGED', message: '磁盘内容已修改', conflictToken: 'revision-one' });
    await pressCtrlKey('s');
    await screen.findByRole('dialog', { name: '文件已被外部修改' });
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
    expect(documentEditor().state.doc.textContent).toContain('本地修改');
    expect(documentEditor().can().undo()).toBe(true);
    saveMarkdownFile.mockResolvedValueOnce({ ok: false, code: 'FILE_CHANGED', message: '磁盘内容已修改', conflictToken: 'revision-two' });
    await pressCtrlKey('s');
    fireEvent.click(await screen.findByRole('button', { name: '覆盖外部版本' }));
    expect(saveMarkdownFile).toHaveBeenCalledTimes(2);
    saveMarkdownFile.mockImplementationOnce(async (_path, content) => ({ ok: true, document: { ...sampleDoc, content } }));
    fireEvent.click(screen.getByRole('button', { name: '确认覆盖' }));
    await waitFor(() => expect(saveMarkdownFile).toHaveBeenLastCalledWith(sampleDoc.path, expect.stringContaining('本地修改'), 'revision-two'));
    expect(documentEditor().can().undo()).toBe(true);
  });

  test('shows an overwrite failure in the conflict dialog and retries the confirmed revision', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await screen.findByTestId('markdown-body');
    act(() => documentEditor().commands.insertContent('本地修改'));
    saveMarkdownFile.mockResolvedValueOnce({ ok: false, code: 'FILE_CHANGED', message: '磁盘内容已修改', conflictToken: 'revision-one' });
    await pressCtrlKey('s');

    const dialog = within(await screen.findByRole('dialog', { name: '文件已被外部修改' }));
    fireEvent.click(dialog.getByRole('button', { name: '覆盖外部版本' }));
    const confirm = dialog.getByRole('button', { name: '确认覆盖' });
    const message = '保存失败，无法自动恢复原文件。草稿已保留。备份路径：C:\\docs\\.vellora-save-backup-example.md。';
    let failOverwrite!: () => void;
    saveMarkdownFile.mockImplementationOnce(() => new Promise(resolve => {
      failOverwrite = () => resolve({ ok: false, code: 'SAVE_FAILED', message });
    }));
    fireEvent.click(confirm);
    await waitFor(() => expect(confirm).toHaveProperty('disabled', true));
    fireEvent.click(confirm);
    expect(saveMarkdownFile).toHaveBeenCalledTimes(2);
    await act(async () => failOverwrite());

    expect((await dialog.findByRole('alert')).textContent).toBe(message);
    expect(documentEditor().state.doc.textContent).toContain('本地修改');
    expect(confirm).toHaveProperty('disabled', false);
    expect(dialog.getByRole('button', { name: '继续编辑' })).toHaveProperty('disabled', false);

    saveMarkdownFile.mockResolvedValueOnce({ ok: false, code: 'FILE_CHANGED', message: '磁盘再次修改', conflictToken: 'revision-two' });
    fireEvent.click(confirm);
    const chooseAgain = await dialog.findByRole('button', { name: '覆盖外部版本' });
    expect(saveMarkdownFile).toHaveBeenNthCalledWith(2, sampleDoc.path, expect.stringContaining('本地修改'), 'revision-one');
    expect(saveMarkdownFile).toHaveBeenNthCalledWith(3, sampleDoc.path, expect.stringContaining('本地修改'), 'revision-one');
    expect(dialog.queryByRole('alert')).toBeNull();
    expect(dialog.queryByRole('button', { name: '确认覆盖' })).toBeNull();

    fireEvent.click(chooseAgain);
    saveMarkdownFile.mockImplementationOnce(async (_path, content) => ({ ok: true, document: { ...sampleDoc, content } }));
    fireEvent.click(dialog.getByRole('button', { name: '确认覆盖' }));
    await waitFor(() => expect(screen.queryByTestId('conflict-modal')).toBeNull());
    expect(saveMarkdownFile).toHaveBeenNthCalledWith(4, sampleDoc.path, expect.stringContaining('本地修改'), 'revision-two');
  });

  test('failed conflict reload preserves the latest draft and history', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await screen.findByTestId('markdown-body');
    act(() => documentEditor().commands.insertContent('保留草稿'));
    saveMarkdownFile.mockResolvedValueOnce({ ok: false, code: 'FILE_CHANGED', message: '磁盘内容已修改', conflictToken: 'disk-one' });
    await pressCtrlKey('s');
    fireEvent.click(await screen.findByRole('button', { name: '重新加载' }));
    expect(openMarkdownFile).not.toHaveBeenCalled();
    openMarkdownFile.mockResolvedValueOnce({ ok: false, code: 'READ_FAILED', message: '读取失败' });
    fireEvent.click(screen.getByRole('button', { name: '放弃草稿并重新加载' }));
    await waitFor(() => expect(openMarkdownFile).toHaveBeenCalledWith(sampleDoc.path));
    expect(documentEditor().state.doc.textContent).toContain('保留草稿');
    expect(documentEditor().can().undo()).toBe(true);
    expect(setUnsavedChanges).toHaveBeenLastCalledWith(true);
  });

  test('registers native event listeners before requesting the initial document', async () => {
    let finishOpenListener!: () => void;
    onOpenFilePath.mockImplementationOnce((handler: (path: string) => void) => {
      openFilePathHandler = handler;
      return new Promise<() => void>((resolve) => {
        finishOpenListener = () => resolve(() => undefined);
      });
    });

    render(<App />);
    await act(async () => Promise.resolve());
    expect(getInitialDocument).not.toHaveBeenCalled();

    await act(async () => finishOpenListener());
    await waitFor(() => expect(getInitialDocument).toHaveBeenCalledTimes(1));
  });

  test('loads the initial document and cleans successful listeners when one registration fails', async () => {
    const unsubscribeOpen = vi.fn();
    const unsubscribeClose = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    onOpenFilePath.mockResolvedValueOnce(unsubscribeOpen);
    onCloseRequested.mockResolvedValueOnce(unsubscribeClose);
    onDragDropPaths.mockRejectedValueOnce(new Error('drag listener failed'));

    const view = render(<App />);
    await waitFor(() => expect(getInitialDocument).toHaveBeenCalledTimes(1));
    expect(consoleError).toHaveBeenCalledTimes(1);

    view.unmount();
    expect(unsubscribeOpen).toHaveBeenCalledTimes(1);
    expect(unsubscribeClose).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  test('a newer native open request wins over a late initial document result', async () => {
    const newerDocument: MarkdownDocument = {
      ...sampleDoc,
      path: 'C:\\docs\\newer.md',
      name: 'newer.md',
      content: '# 较新的系统打开请求\n'
    };
    let finishInitial!: () => void;
    getInitialDocument.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishInitial = () => resolve({ ok: true, document: sampleDoc });
        })
    );
    openMarkdownFile.mockResolvedValueOnce({ ok: true, document: newerDocument });

    render(<App />);
    await waitFor(() => expect(getInitialDocument).toHaveBeenCalledTimes(1));
    await act(async () => openFilePathHandler!('C:\\docs\\newer.md'));
    await waitFor(() =>
      expect(screen.getByTestId('markdown-body').textContent).toContain('较新的系统打开请求')
    );

    await act(async () => finishInitial());
    expect(screen.getByTestId('markdown-body').textContent).toContain('较新的系统打开请求');
    expect(screen.getByTestId('markdown-body').textContent).not.toContain('正文搜索词');
  });

  test.each(['NOT_FOUND', 'READ_FAILED'])('shows initial %s failures and can open another document', async code => {
    getInitialDocument.mockResolvedValueOnce({ ok: false, code, message: '无法读取初始文档' });
    render(<App />);
    expect((await screen.findByTestId('error-state')).textContent).toContain('无法读取初始文档');
    fireEvent.click(screen.getByRole('button', { name: '重新选择' }));
    expect(await screen.findByTestId('markdown-body')).toBeTruthy();
  });

  test('reports a rejected initial open without an unhandled rejection', async () => {
    getInitialDocument.mockRejectedValueOnce(new Error('初始读取失败'));
    render(<App />);
    expect((await screen.findByTestId('error-state')).textContent).toContain('初始读取失败');
  });

  test('a late initial failure cannot replace a newer opened document', async () => {
    let rejectInitial!: (error: Error) => void;
    getInitialDocument.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectInitial = reject; }));
    render(<App />);
    await waitFor(() => expect(getInitialDocument).toHaveBeenCalledTimes(1));
    await act(async () => openFilePathHandler!(sampleDoc.path));
    await screen.findByTestId('markdown-body');
    await act(async () => rejectInitial(new Error('过期的初始错误')));
    expect(screen.queryByTestId('error-state')).toBeNull();
    expect(screen.getByTestId('markdown-body').textContent).toContain('标题');
  });

  test('shows empty state and opens a file', async () => {
    render(<App />);
    expect(screen.getByTestId('empty-state')).toBeTruthy();
    expect(screen.getByTestId('empty-state').textContent).toContain('未打开文件');
    const emptyAppIcon = screen.getByTestId('empty-app-icon');
    expect(emptyAppIcon.tagName).toBe('IMG');
    expect(emptyAppIcon.getAttribute('src')).toBeTruthy();
    expect(emptyAppIcon.getAttribute('alt')).toBe('');
    expect(emptyAppIcon.getAttribute('aria-hidden')).toBe('true');

    fireEvent.click(screen.getByTestId('btn-open'));

    await waitFor(() => {
      expect(screen.getByTestId('markdown-body')).toBeTruthy();
    });
    expect(screen.getByText('标题')).toBeTruthy();
    expect(chooseMarkdownFile).toHaveBeenCalled();
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

  test('toolbar save and search reuse the active document and prevent duplicate saves', async () => {
    let finishSave!: (value: unknown) => void;
    const content = '# 标题\n\n工具栏保存\n';
    saveMarkdownFile.mockImplementationOnce(() => new Promise(resolve => { finishSave = resolve; }));
    render(<App />);
    const save = screen.getByTestId('btn-save') as HTMLButtonElement;
    const search = screen.getByTestId('btn-search') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(search.disabled).toBe(true);
    expect((screen.getByTestId('btn-outline') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId('btn-open'));
    await screen.findByTestId('markdown-body');
    expect(save.disabled).toBe(true);
    expect(search.disabled).toBe(false);
    fireEvent.click(screen.getByTestId('btn-edit'));
    fireEvent.change(screen.getByTestId('source-editor'), { target: { value: content } });
    expect(save.disabled).toBe(false);
    expect(screen.getByTestId('btn-edit').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('btn-read').getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(search);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('search-input')));
    fireEvent.change(screen.getByTestId('search-input'), { target: { value: '工具栏' } });
    await waitFor(() => expect(screen.getByTestId('search-count').textContent).toBe('1 / 1'));
    fireEvent.click(screen.getByTestId('search-close'));
    expect(screen.queryByTestId('search-bar')).toBeNull();

    fireEvent.click(save);
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(saveMarkdownFile).toHaveBeenCalledTimes(1);
    expect(saveMarkdownFile).toHaveBeenCalledWith(sampleDoc.path, content);
    await act(async () => finishSave({ ok: true, document: { ...sampleDoc, content } }));
    await waitFor(() => expect(setUnsavedChanges).toHaveBeenLastCalledWith(false));
    expect(screen.getByTestId('status-text').textContent).not.toContain('正在保存');
    expect(save.disabled).toBe(true);
    expect((screen.getByTestId('source-editor') as HTMLTextAreaElement).value).toBe(content);
  });

  test('toolbar actions stay disabled until a pending open finishes', async () => {
    let finishOpen!: (value: unknown) => void;
    chooseMarkdownFile.mockImplementationOnce(() => new Promise(resolve => { finishOpen = resolve; }));
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    for (const id of ['btn-open', 'btn-save', 'btn-search', 'btn-outline']) {
      expect((screen.getByTestId(id) as HTMLButtonElement).disabled).toBe(true);
    }
    await act(async () => finishOpen({ ok: true, document: sampleDoc }));
    await screen.findByTestId('markdown-body');
    expect((screen.getByTestId('btn-search') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('btn-outline') as HTMLButtonElement).disabled).toBe(false);
  });

  test.each([true, false])('outline dismissal respects floating layout (%s) and restores Escape focus', async floating => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: floating })));
    try {
      render(<App />);
      fireEvent.click(screen.getByTestId('btn-open'));
      await screen.findByTestId('markdown-body');
      const toggle = screen.getByTestId('btn-outline');
      fireEvent.click(toggle);
      fireEvent.pointerDown(screen.getByTestId('outline-panel'));
      expect(screen.getByTestId('outline-panel')).toBeTruthy();
      fireEvent.pointerDown(toggle);
      expect(screen.getByTestId('outline-panel')).toBeTruthy();
      fireEvent.pointerDown(screen.getByTestId('content'));
      expect(Boolean(screen.queryByTestId('outline-panel'))).toBe(!floating);

      if (floating) fireEvent.click(toggle);
      screen.getByTestId('outline-item').focus();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByTestId('outline-panel')).toBeNull();
      expect(document.activeElement).toBe(toggle);
      expect(toggle.getAttribute('aria-expanded')).toBe('false');

      fireEvent.click(toggle);
      fireEvent.click(screen.getByTestId('outline-item'));
      expect(Boolean(screen.queryByTestId('outline-panel'))).toBe(!floating);
      expect(screen.getByTestId('markdown-body').textContent).toContain('正文搜索词');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test.each(['\n', '\r\n'])('source edits preserve the saved line ending (%j) and become clean when reverted', async lineEnding => {
    const content = '\ufeff# 标题🧭' + lineEnding + lineEnding + '正文内容' + lineEnding;
    const doc = { ...sampleDoc, content };
    chooseMarkdownFile.mockResolvedValueOnce({ ok: true, document: doc });
    saveMarkdownFile.mockImplementationOnce(async (_path: string, value: string) => ({ ok: true, document: { ...doc, content: value } }));
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await screen.findByTestId('markdown-body');
    fireEvent.click(screen.getByTestId('btn-edit'));
    const source = screen.getByTestId('source-editor') as HTMLTextAreaElement;
    const normalized = content.replace(/\r\n/g, '\n');
    expect(source.value).toBe(normalized);
    fireEvent.change(source, { target: { value: normalized + '修改' } });
    expect((screen.getByTestId('btn-save') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(source, { target: { value: normalized } });
    expect((screen.getByTestId('btn-save') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('status-text').textContent).toBe('Markdown 文档');
    fireEvent.click(screen.getByTestId('btn-read'));
    expect((screen.getByTestId('btn-save') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('btn-edit'));
    fireEvent.change(screen.getByTestId('source-editor'), { target: { value: normalized + '修改' } });
    fireEvent.click(screen.getByTestId('btn-save'));
    await waitFor(() => expect(saveMarkdownFile).toHaveBeenCalledWith(doc.path, content + '修改'));
  });

  test('CRLF source search and mode restoration use the textarea selection coordinates', async () => {
    const content = '\ufeff# 标题🧭\r\n\r\n第一处目标词\r\n\r\n第二处目标词\r\n';
    chooseMarkdownFile.mockResolvedValueOnce({ ok: true, document: { ...sampleDoc, content } });
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await screen.findByTestId('markdown-body');
    fireEvent.click(screen.getByTestId('btn-edit'));
    fireEvent.click(screen.getByTestId('btn-search'));
    fireEvent.change(screen.getByTestId('search-input'), { target: { value: '目标词' } });
    await waitFor(() => expect(screen.getByTestId('search-count').textContent).toBe('1 / 2'));
    fireEvent.click(screen.getByTestId('search-next'));
    fireEvent.click(screen.getByTestId('search-close'));
    const source = screen.getByTestId('source-editor') as HTMLTextAreaElement;
    const start = source.value.lastIndexOf('目标词');
    expect(source.selectionStart).toBe(start);
    expect(source.value.slice(source.selectionStart, source.selectionEnd)).toBe('目标词');
    fireEvent.click(screen.getByTestId('btn-read'));
    fireEvent.click(screen.getByTestId('btn-edit'));
    const restored = screen.getByTestId('source-editor') as HTMLTextAreaElement;
    expect(restored.selectionStart).toBe(start);
    expect(restored.selectionEnd).toBe(start + '目标词'.length);
    expect((screen.getByTestId('btn-save') as HTMLButtonElement).disabled).toBe(true);
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

  test('a failed open replaces the previous saved status without losing the document', async () => {
    saveMarkdownFile.mockImplementationOnce(async (_path: string, content: string) => ({ ok: true, document: { ...sampleDoc, content } }));
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    const body = await screen.findByTestId('markdown-body');
    act(() => documentEditor().commands.insertContent('保存后打开'));
    await pressCtrlKey('s');
    await waitFor(() => expect(screen.getByTestId('status-text').textContent).toBe('已保存'));
    chooseMarkdownFile.mockResolvedValueOnce({ ok: false, code: 'OPEN_FAILED', message: '无法读取目标文件' });
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect((screen.getByTestId('btn-open') as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByTestId('status-text').textContent).toBe('无法读取目标文件');
    expect(body.textContent).toContain('保存后打开');
  });

  test('native drop ignores unsupported paths and opens the first Markdown file', async () => {
    let dropPaths: ((paths: string[]) => void) | undefined;
    onDragDropPaths.mockImplementationOnce(handler => {
      dropPaths = handler;
      return Promise.resolve(() => undefined);
    });
    render(<App />);
    await waitFor(() => expect(dropPaths).toBeDefined());
    await act(async () => dropPaths!(['C:/docs/notes.txt', 'C:/docs/invalid.md\n',
      'C:/docs/README.MARKDOWN', 'C:/docs/other.md']));
    expect(openMarkdownFile).toHaveBeenCalledExactlyOnceWith('C:/docs/README.MARKDOWN');
    expect(await screen.findByTestId('markdown-body')).toBeTruthy();
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

  test('source editor search finds matches and moves selection in source mode', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());

    fireEvent.click(screen.getByTestId('btn-edit'));
    const editor = screen.getByTestId('source-editor') as HTMLTextAreaElement;
    fireEvent.change(editor, {
      target: { value: '# 标题\n\n搜索词\n正文\n搜索词\n' }
    });

    await pressCtrlKey('f');
    const input = screen.getByTestId('search-input');
    await waitFor(() => expect(document.activeElement).toBe(input));
    for (const partialQuery of ['搜', '搜索', '搜索词']) {
      fireEvent.change(input, { target: { value: partialQuery } });
      await waitFor(() => expect(document.activeElement).toBe(input));
    }

    const query = '搜索词';
    const firstStart = editor.value.indexOf(query);
    const secondStart = editor.value.indexOf(query, firstStart + 1);
    const queryLength = query.length;

    await waitFor(() => {
      expect(screen.getByTestId('search-count').textContent).toMatch(/1\s*\/\s*2/);
      expect(editor.selectionStart).toBe(firstStart);
      expect(editor.selectionEnd).toBe(firstStart + queryLength);
      const layer = screen.getByTestId('source-search-highlight-layer');
      const hits = layer.querySelectorAll<HTMLElement>('.source-search-hit');
      expect(layer.textContent).toBe(editor.value);
      expect(hits).toHaveLength(2);
      expect(hits[0].dataset.activeSearch).toBe('true');
      expect(hits[1].dataset.activeSearch).toBeUndefined();
      expect(editor.classList.contains('source-editor--searching')).toBe(true);
    });

    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByTestId('search-count').textContent).toMatch(/2\s*\/\s*2/);
      expect(editor.selectionStart).toBe(secondStart);
      expect(editor.selectionEnd).toBe(secondStart + queryLength);
      expect(document.activeElement).toBe(input);
      const hits = screen
        .getByTestId('source-search-highlight-layer')
        .querySelectorAll<HTMLElement>('.source-search-hit');
      expect(hits[0].dataset.activeSearch).toBeUndefined();
      expect(hits[1].dataset.activeSearch).toBe('true');
    });

    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });

    await waitFor(() => {
      expect(screen.getByTestId('search-count').textContent).toMatch(/1\s*\/\s*2/);
      expect(editor.selectionStart).toBe(firstStart);
      expect(editor.selectionEnd).toBe(firstStart + queryLength);
    });

    fireEvent.click(screen.getByTestId('search-next'));

    await waitFor(() => {
      expect(screen.getByTestId('search-count').textContent).toMatch(/2\s*\/\s*2/);
      expect(editor.selectionStart).toBe(secondStart);
      expect(editor.selectionEnd).toBe(secondStart + queryLength);
    });

    fireEvent.click(screen.getByTestId('search-prev'));

    await waitFor(() => {
      expect(screen.getByTestId('search-count').textContent).toMatch(/1\s*\/\s*2/);
      expect(editor.selectionStart).toBe(firstStart);
      expect(editor.selectionEnd).toBe(firstStart + queryLength);
    });

    fireEvent.change(input, { target: { value: '不存在的匹配' } });
    await waitFor(() => {
      expect(screen.getByTestId('search-count').textContent).toMatch(/0\s*\/\s*0/);
      expect(screen.queryByTestId('source-search-highlight-layer')).toBeNull();
      expect(editor.classList.contains('source-editor--searching')).toBe(false);
    });

    fireEvent.change(input, { target: { value: query } });
    await waitFor(() => expect(screen.getByTestId('source-search-highlight-layer')).toBeTruthy());
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByTestId('search-bar')).toBeNull();
    expect(screen.queryByTestId('source-search-highlight-layer')).toBeNull();
    expect(editor.classList.contains('source-editor--searching')).toBe(false);
  });

  test('single-match source navigation keeps the next edit cursor position', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());

    fireEvent.click(screen.getByTestId('btn-edit'));
    const editor = screen.getByTestId('source-editor') as HTMLTextAreaElement;
    fireEvent.change(editor, {
      target: { value: '# 标题\n\n搜索词\n正文\n' }
    });

    await pressCtrlKey('f');
    const input = screen.getByTestId('search-input');
    fireEvent.change(input, { target: { value: '搜索词' } });

    const query = '搜索词';
    const firstStart = editor.value.indexOf(query);
    const queryLength = '搜索词'.length;
    await waitFor(() => {
      expect(screen.getByTestId('search-count').textContent).toMatch(/1\s*\/\s*1/);
      expect(editor.selectionStart).toBe(firstStart);
      expect(editor.selectionEnd).toBe(firstStart + queryLength);
    });

    fireEvent.click(screen.getByTestId('search-next'));
    await waitFor(() => {
      expect(editor.selectionStart).toBe(firstStart);
      expect(editor.selectionEnd).toBe(firstStart + queryLength);
    });

    editor.focus();
    editor.setSelectionRange(0, 0);
    const editedValue = `X${editor.value}`;
    fireEvent.change(editor, {
      target: {
        value: editedValue,
        selectionStart: 1,
        selectionEnd: 1
      }
    });

    await waitFor(() => {
      expect(editor.selectionStart).toBe(1);
      expect(editor.selectionEnd).toBe(1);
      const layer = screen.getByTestId('source-search-highlight-layer');
      expect(layer.textContent).toBe(editedValue);
      expect(layer.querySelectorAll('.source-search-hit')).toHaveLength(1);
    });
  });

  test('source search keeps original offsets for Unicode case-insensitive matches', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());

    fireEvent.click(screen.getByTestId('btn-edit'));
    const editor = screen.getByTestId('source-editor') as HTMLTextAreaElement;
    fireEvent.change(editor, {
      target: { value: 'İa A' }
    });

    await pressCtrlKey('f');
    const input = screen.getByTestId('search-input');
    fireEvent.change(input, { target: { value: 'a' } });

    await waitFor(() => {
      expect(screen.getByTestId('search-count').textContent).toMatch(/1\s*\/\s*2/);
      expect(editor.selectionStart).toBe(1);
      expect(editor.selectionEnd).toBe(2);
      expect(
        screen
          .getByTestId('source-search-highlight-layer')
          .querySelectorAll('.source-search-hit')
      ).toHaveLength(2);
    });

    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByTestId('search-count').textContent).toMatch(/2\s*\/\s*2/);
      expect(editor.selectionStart).toBe(3);
      expect(editor.selectionEnd).toBe(4);
    });
  });

  test('external link confirmation flow', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());

    const link = screen.getByTestId('markdown-body').querySelector('a');
    expect(link).toBeTruthy();
    await openSelectedLink();

    await waitFor(() => expect(screen.getByTestId('external-link-modal')).toBeTruthy());
    fireEvent.click(screen.getByTestId('external-confirm'));

    await waitFor(() => {
      expect(openExternalUrl).toHaveBeenCalledWith('https://example.com/');
    });
  });

  test.each(['http://example.com', 'https://example.com'])('raw HTML links require inspection and confirmation: %s', async href => {
    chooseMarkdownFile.mockResolvedValueOnce({ ok: true, document: {
      ...sampleDoc, content: '<a href="' + href + '"><strong>外链</strong></a>',
    } });
    inspectMarkdownLink.mockResolvedValueOnce({ ok: true, action: 'external', url: href + '/' });
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    const body = await screen.findByTestId('markdown-body');
    act(() => documentEditor().view.setProps({ handleScrollToSelection: () => true }));
    fireEvent.click(body.querySelector('.raw-source-preview a strong')!, { ctrlKey: true });
    await screen.findByTestId('external-link-modal');
    expect(inspectMarkdownLink).toHaveBeenCalledExactlyOnceWith(sampleDoc.path, href);
    expect(openExternalUrl).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('external-confirm'));
    await waitFor(() => expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith(href + '/'));
  });

  test.each([
    ['raw HTML with Enter', '<a href="https://example.com">外链</a>', false],
    ['reference-style Markdown with Alt+Enter', '[外链][target]\n\n[target]: https://example.com', true],
  ])('opens a %s preview link only after confirmation', async (_scenario, source, altKey) => {
    chooseMarkdownFile.mockResolvedValueOnce({ ok: true, document: {
      ...sampleDoc, content: '# 标题\n\n' + source,
    } });
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    const body = await screen.findByTestId('markdown-body');
    const link = body.querySelector<HTMLAnchorElement>('.raw-source-preview a')!;
    act(() => documentEditor().view.setProps({ handleScrollToSelection: () => true }));
    act(() => link.focus());
    expect(document.activeElement).toBe(link);

    fireEvent.keyDown(link, { key: 'Enter', altKey, isComposing: true });
    expect(inspectMarkdownLink).not.toHaveBeenCalled();

    expect(fireEvent.keyDown(link, { key: 'Enter', altKey })).toBe(false);
    await screen.findByTestId('external-link-modal');
    expect(inspectMarkdownLink).toHaveBeenCalledExactlyOnceWith(sampleDoc.path, 'https://example.com');
    expect(openExternalUrl).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('external-confirm'));
    await waitFor(() => expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith('https://example.com/'));
  });

  test('raw HTML relative links retain the checked local path flow', async () => {
    chooseMarkdownFile.mockResolvedValueOnce({ ok: true, document: {
      ...sampleDoc, content: '<a href="../outside.md">下一页</a>',
    } });
    inspectMarkdownLink.mockResolvedValueOnce({ ok: false, code: 'PATH_OUTSIDE_DOCUMENT', message: '链接超出当前文档目录。' });
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    const body = await screen.findByTestId('markdown-body');
    act(() => documentEditor().view.setProps({ handleScrollToSelection: () => true }));
    fireEvent.click(body.querySelector('.raw-source-preview a')!, { ctrlKey: true });
    await waitFor(() => expect(inspectMarkdownLink).toHaveBeenCalledExactlyOnceWith(sampleDoc.path, '../outside.md'));
    await screen.findByText('链接超出当前文档目录。');
    expect(openMarkdownLink).not.toHaveBeenCalled();
    expect(openExternalUrl).not.toHaveBeenCalled();
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

  test('Command shortcuts trigger save and search', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());

    fireEvent.click(screen.getByTestId('btn-edit'));
    fireEvent.change(screen.getByTestId('source-editor'), { target: { value: 'saved via command' } });
    await pressMetaKey('s');
    await waitFor(() => expect(saveMarkdownFile).toHaveBeenCalled());

    await pressMetaKey('f');
    await waitFor(() => expect(screen.getByTestId('search-input')).toBeTruthy());
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
    await openSelectedLink();

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

    await openSelectedLink();
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

    fireEvent.click(screen.getByTestId('discard-modal'));
    expect(screen.queryByTestId('discard-modal')).toBeNull();
    await waitFor(() => expect(confirmClose).toHaveBeenCalledWith(false));
    confirmClose.mockClear();

    await act(async () => {
      closeRequestedHandler!();
    });
    await waitFor(() => expect(screen.getByTestId('discard-modal')).toBeTruthy());
    fireEvent.click(screen.getByTestId('discard-modal'));
    await waitFor(() => expect(confirmClose).toHaveBeenCalledWith(false));

    // Failed open must still save back to the source path, never a dead target path.
    await pressCtrlKey('s');
    await waitFor(() => {
      expect(saveMarkdownFile).toHaveBeenCalledWith('C:\\docs\\source.md', draft);
    });
  });

  test('Escape cancels a close confirmation and resets the native close request', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());

    fireEvent.click(screen.getByTestId('btn-edit'));
    fireEvent.change(screen.getByTestId('source-editor'), {
      target: { value: '# 尚未保存\n' }
    });
    await act(async () => closeRequestedHandler!());
    await waitFor(() => expect(screen.getByTestId('discard-modal')).toBeTruthy());

    saveMarkdownFile.mockClear();
    await pressMetaKey('s');
    expect(saveMarkdownFile).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('discard-modal')).toBeNull());
    expect(confirmClose).toHaveBeenCalledWith(false);
    expect((screen.getByTestId('source-editor') as HTMLTextAreaElement).value).toBe(
      '# 尚未保存\n'
    );
  });

  test('clicking outside a close confirmation continues editing', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());

    fireEvent.click(screen.getByTestId('btn-edit'));
    fireEvent.change(screen.getByTestId('source-editor'), {
      target: { value: '# 点击遮罩后继续编辑\n' }
    });
    await act(async () => closeRequestedHandler!());
    await waitFor(() => expect(screen.getByTestId('discard-modal')).toBeTruthy());

    fireEvent.click(screen.getByTestId('discard-modal'));
    await waitFor(() => expect(screen.queryByTestId('discard-modal')).toBeNull());
    expect(confirmClose).toHaveBeenCalledWith(false);
    expect((screen.getByTestId('source-editor') as HTMLTextAreaElement).value).toBe(
      '# 点击遮罩后继续编辑\n'
    );
  });

  test('saves successfully before exiting', async () => {
    const savedDraft = '# 保存后退出\n';
    saveMarkdownFile.mockResolvedValueOnce({
      ok: true,
      document: { ...sampleDoc, content: savedDraft }
    });
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());

    fireEvent.click(screen.getByTestId('btn-edit'));
    fireEvent.change(screen.getByTestId('source-editor'), { target: { value: savedDraft } });
    await act(async () => closeRequestedHandler!());
    await waitFor(() => expect(screen.getByTestId('close-save')).toBeTruthy());
    expect(screen.getByTestId('close-save').textContent).toBe('保存并退出');
    expect(screen.getByTestId('close-discard').textContent).toBe('不保存并退出');
    expect(screen.queryByTestId('discard-cancel')).toBeNull();

    fireEvent.click(screen.getByTestId('close-save'));
    await waitFor(() =>
      expect(saveMarkdownFile).toHaveBeenCalledWith(sampleDoc.path, savedDraft)
    );
    await waitFor(() => expect(confirmClose).toHaveBeenCalledWith(true));
    expect(saveMarkdownFile.mock.invocationCallOrder[0]).toBeLessThan(
      confirmClose.mock.invocationCallOrder[0]
    );
    expect(screen.queryByTestId('discard-modal')).toBeNull();
  });

  test('keeps the close confirmation open when saving fails', async () => {
    saveMarkdownFile.mockResolvedValueOnce({
      ok: false,
      code: 'SAVE_FAILED',
      message: '无法保存测试文档。'
    });
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());

    fireEvent.click(screen.getByTestId('btn-edit'));
    fireEvent.change(screen.getByTestId('source-editor'), {
      target: { value: '# 保存失败时保留弹窗\n' }
    });
    await act(async () => closeRequestedHandler!());
    await waitFor(() => expect(screen.getByTestId('close-save')).toBeTruthy());

    fireEvent.click(screen.getByTestId('close-save'));
    await waitFor(() => expect(saveMarkdownFile).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByTestId('close-save-feedback').textContent).toContain('无法保存测试文档。')
    );
    expect(screen.getByTestId('close-save-feedback').getAttribute('role')).toBe('alert');
    expect(screen.getByTestId('discard-modal')).toBeTruthy();
    expect(confirmClose).not.toHaveBeenCalledWith(true);
  });

  test('disables save-and-exit while a document open request is pending', async () => {
    type CanceledOpen = { ok: false; code: 'CANCELED'; message: string };
    let resolveOpen!: (value: CanceledOpen) => void;

    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());

    fireEvent.click(screen.getByTestId('btn-edit'));
    fireEvent.change(screen.getByTestId('source-editor'), {
      target: { value: '# 打开请求期间关闭\n' }
    });
    chooseMarkdownFile.mockReturnValueOnce(
      new Promise<CanceledOpen>((resolve) => {
        resolveOpen = resolve;
      })
    );

    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('discard-confirm')).toBeTruthy());
    fireEvent.click(screen.getByTestId('discard-confirm'));
    await waitFor(() => expect(chooseMarkdownFile).toHaveBeenCalledTimes(2));

    await act(async () => closeRequestedHandler!());
    const closeSave = await screen.findByTestId('close-save') as HTMLButtonElement;
    expect(closeSave.disabled).toBe(true);
    expect(screen.getByTestId('close-save-feedback').textContent).toBe('正在打开文档，请稍候。');
    expect(screen.getByTestId('close-save-feedback').getAttribute('role')).toBe('status');
    expect(saveMarkdownFile).not.toHaveBeenCalled();

    await act(async () => {
      resolveOpen({ ok: false, code: 'CANCELED', message: '已取消。' });
    });
    await waitFor(() => expect(closeSave.disabled).toBe(false));
    expect(screen.queryByTestId('close-save-feedback')).toBeNull();
  });

  test('does not exit when the close confirmation is canceled during saving', async () => {
    let finishSave: ((result: Awaited<ReturnType<typeof saveMarkdownFile>>) => void) | null = null;
    saveMarkdownFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSave = resolve;
        })
    );
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());

    fireEvent.click(screen.getByTestId('btn-edit'));
    fireEvent.change(screen.getByTestId('source-editor'), {
      target: { value: '# 保存过程中取消退出\n' }
    });
    await act(async () => closeRequestedHandler!());
    await waitFor(() => expect(screen.getByTestId('close-save')).toBeTruthy());

    fireEvent.click(screen.getByTestId('close-save'));
    await waitFor(() => expect(saveMarkdownFile).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId('discard-modal'));
    await waitFor(() => expect(confirmClose).toHaveBeenCalledWith(false));

    await act(async () => {
      finishSave?.({
        ok: true,
        document: { ...sampleDoc, content: '# 保存过程中取消退出\n' }
      });
    });
    await waitFor(() => expect(screen.queryByTestId('discard-modal')).toBeNull());
    expect(confirmClose).not.toHaveBeenCalledWith(true);
  });

  test('confirming close discards the in-memory draft for a later Dock reopen', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());

    fireEvent.click(screen.getByTestId('btn-edit'));
    fireEvent.change(screen.getByTestId('source-editor'), {
      target: { value: '# 放弃此草稿\n' }
    });
    await act(async () => closeRequestedHandler!());
    await waitFor(() => expect(screen.getByTestId('discard-modal')).toBeTruthy());

    fireEvent.click(screen.getByTestId('close-discard'));
    await waitFor(() => expect(confirmClose).toHaveBeenCalledWith(true));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());
    fireEvent.click(screen.getByTestId('btn-edit'));
    expect((screen.getByTestId('source-editor') as HTMLTextAreaElement).value).toBe(
      sampleDoc.content
    );
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
    expect(screen.getByTestId('status-text').textContent).toBe('正在打开文件');

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

    await openSelectedLink();
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

    await openSelectedLink();
    await waitFor(() => expect(screen.getByTestId('discard-modal')).toBeTruthy());
    fireEvent.click(screen.getByTestId('discard-confirm'));

    await waitFor(() => {
      expect(openMarkdownLink).toHaveBeenCalledWith('C:\\docs\\source.md', './other.md');
    });
    await waitFor(() => {
      expect(screen.getByTestId('markdown-body').textContent).toContain('目标文档');
    });
  });

  test.each(['python', '', 'unknown metadata'])('edits code directly with language %j and no format controls', async language => {
    saveMarkdownFile.mockImplementationOnce(async (path: string, content: string) => ({ ok: true, document: { ...sampleDoc, path, content } }));
    chooseMarkdownFile.mockResolvedValueOnce({ ok: true, document: { ...sampleDoc, content: '```' + language + '\ncode\n```' } });
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    const body = await screen.findByTestId('markdown-body');
    act(() => {
      // jsdom has no text geometry.
      documentEditor().view.setProps({ handleScrollToSelection: () => true });
      documentEditor().view.focus();
      documentEditor().commands.setTextSelection({ from: 1, to: 5 });
      documentEditor().commands.insertContent('edited code');
    });
    expect(screen.queryByRole('toolbar')).toBeNull();
    expect(screen.queryByRole('button', { name: '格式' })).toBeNull();
    expect(screen.queryByLabelText('代码语言')).toBeNull();
    expect(setUnsavedChanges.mock.calls.at(-1)?.[0]).toBe(true);
    expect(document.activeElement).toBe(body);
    fireEvent.keyDown(body, { key: 'Escape' });
    await pressCtrlKey('s');
    expect(saveMarkdownFile.mock.calls.at(-1)?.[1]).toBe('```' + language + '\nedited code\n```');
    fireEvent.click(screen.getByTestId('btn-edit'));
    expect(screen.getByTestId('source-editor')).toHaveProperty('value', '```' + language + '\nedited code\n```');
    fireEvent.click(screen.getByTestId('btn-read'));
    act(() => documentEditor().commands.undo());
    expect(documentEditor().state.doc.firstChild!.attrs.language).toBe(language || null);
    expect(body.textContent).toBe('code');
  });

  test('direct code edits defer IME save and immediately protect native close', async () => {
    saveMarkdownFile.mockImplementationOnce(async (path: string, content: string) => ({ ok: true, document: { ...sampleDoc, path, content } }));
    chooseMarkdownFile.mockResolvedValueOnce({ ok: true, document: { ...sampleDoc, content: '```js\ncode\n```' } });
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    const body = await screen.findByTestId('markdown-body');
    act(() => documentEditor().view.focus());
    fireEvent.compositionStart(body);
    act(() => documentEditor().view.dispatch(documentEditor().state.tr.insertText('中', 1, 5)));
    await pressCtrlKey('s');
    expect(saveMarkdownFile).not.toHaveBeenCalled();
    act(() => documentEditor().view.dispatch(documentEditor().state.tr.insertText('文', 2)));
    fireEvent.compositionEnd(body);
    await waitFor(() => expect(saveMarkdownFile).toHaveBeenCalled());
    expect(saveMarkdownFile.mock.calls.at(-1)?.[1]).toContain('```js\n中文\n');
    act(() => documentEditor().view.dispatch(documentEditor().state.tr.insertText('新', 1)));
    await act(async () => closeRequestedHandler?.());
    expect(screen.getByTestId('discard-modal')).toBeTruthy();
    expect(documentEditor().state.doc.textContent).toBe('新中文');
  });

  test('all common blocks edit continuously and use the existing save flow', async () => {
    chooseMarkdownFile.mockResolvedValueOnce({ ok: true, document: { ...sampleDoc,
      content: '# 标题\r\n\r\n- 父项\r\n  - 子项\r\n\r\n| A | B |\r\n| --- | --- |\r\n| 一 | 二 |\r\n\r\n```js\r\nconst x = 1;\r\n```' } });
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());
    const editor = documentEditor();
    expect(editor.isEditable).toBe(true);
    let codePos = 0;
    editor.state.doc.descendants((node, pos) => { if (node.type.name === 'codeBlock') codePos = pos + 1; });
    act(() => editor.view.dispatch(editor.state.tr.insertText('// 修改\n', codePos)));
    await pressCtrlKey('s');
    const saved = saveMarkdownFile.mock.calls.at(-1)?.[1] as string;
    expect(saved).toContain('// 修改\r\nconst x = 1;');
    expect(saved).toContain('子项');
    expect(saved).toContain('一');
    expect(saved.replace(/\r\n/g, '')).not.toContain('\n');
  });

  test('mode switches preserve original bytes and undo history until source changes', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());
    await act(async () => Promise.resolve());
    const editor = documentEditor();
    fireEvent.click(screen.getByTestId('btn-edit'));
    expect(screen.getByTestId('source-editor')).toHaveProperty('value', sampleDoc.content);
    fireEvent.click(screen.getByTestId('btn-read'));
    expect(documentEditor()).toBe(editor);
    expect(setUnsavedChanges).not.toHaveBeenCalledWith(true);
    act(() => editor.view.dispatch(editor.state.tr.insertText('新', 1)));
    fireEvent.click(screen.getByTestId('btn-edit'));
    fireEvent.click(screen.getByTestId('btn-read'));
    act(() => editor.commands.undo());
    await waitFor(() => expect(setUnsavedChanges.mock.calls.at(-1)?.[0]).toBe(false));
    fireEvent.click(screen.getByTestId('btn-edit'));
    fireEvent.change(screen.getByTestId('source-editor'), { target: { value: '# 源码改动' } });
    fireEvent.click(screen.getByTestId('btn-read'));
    expect(documentEditor().state.doc.textContent).toBe('源码改动');
    expect(documentEditor().can().undo()).toBe(false);
  });

  test('Escape keeps edits and document undo restores the clean baseline', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());
    await act(async () => Promise.resolve());
    const editor = documentEditor();
    act(() => editor.view.dispatch(editor.state.tr.insertText('新', 1)));
    fireEvent.keyDown(screen.getByTestId('markdown-body'), { key: 'Escape' });
    expect(editor.state.doc.textContent).toContain('新标题');
    expect(setUnsavedChanges.mock.calls.at(-1)?.[0]).toBe(true);
    act(() => editor.commands.undo());
    expect(editor.state.doc.textContent).not.toContain('新标题');
    await waitFor(() => expect(setUnsavedChanges.mock.calls.at(-1)?.[0]).toBe(false));
  });

  test('save waits for IME completion and writes the final composition text', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());
    const body = screen.getByTestId('markdown-body');
    fireEvent.compositionStart(body);
    await pressCtrlKey('s');
    expect(saveMarkdownFile).not.toHaveBeenCalled();
    act(() => documentEditor().view.dispatch(documentEditor().state.tr.insertText('中文', 1)));
    fireEvent.compositionEnd(body);
    await waitFor(() => expect(saveMarkdownFile).toHaveBeenCalled());
    expect(saveMarkdownFile.mock.calls.at(-1)?.[1]).toContain('中文标题');
  });

  test('continuous edits retain close protection and save failure recovery', async () => {
    saveMarkdownFile.mockResolvedValueOnce({ ok: false, code: 'SAVE_FAILED', message: '保存失败' });
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());
    act(() => documentEditor().view.dispatch(documentEditor().state.tr.insertText('未保存', 1)));
    await act(async () => closeRequestedHandler?.());
    expect(screen.getByTestId('discard-modal')).toBeTruthy();
    fireEvent.click(screen.getByTestId('discard-modal'));
    await pressCtrlKey('s');
    expect(screen.getByTestId('status-text').textContent).toBe('保存失败');
    expect(documentEditor().state.doc.textContent).toContain('未保存标题');
    expect(setUnsavedChanges.mock.calls.at(-1)?.[0]).toBe(true);
  });

  test('typing during a save cannot be overwritten by the older save response', async () => {
    let finish!: (value: unknown) => void;
    saveMarkdownFile.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());
    act(() => documentEditor().view.dispatch(documentEditor().state.tr.insertText('甲', 1)));
    await pressCtrlKey('s');
    const submitted = saveMarkdownFile.mock.calls.at(-1)?.[1];
    act(() => documentEditor().view.dispatch(documentEditor().state.tr.insertText('乙', 1)));
    await act(async () => finish({ ok: true, document: { ...sampleDoc, content: submitted } }));
    expect(documentEditor().state.doc.textContent).toContain('乙甲标题');
    expect(setUnsavedChanges.mock.calls.at(-1)?.[0]).toBe(true);
  });

  test.each(['read', 'edit'])('saving from %s preserves later edits across a mode switch', async mode => {
    let finish!: (value: unknown) => void;
    saveMarkdownFile.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await screen.findByTestId('markdown-body');
    if (mode === 'read') act(() => documentEditor().commands.insertContent('已提交'));
    else {
      fireEvent.click(screen.getByTestId('btn-edit'));
      fireEvent.change(screen.getByTestId('source-editor'), { target: { value: '# 已提交' } });
    }
    await pressCtrlKey('s');
    const submitted = saveMarkdownFile.mock.calls.at(-1)![1];
    fireEvent.click(screen.getByTestId(mode === 'read' ? 'btn-edit' : 'btn-read'));
    if (mode === 'read') fireEvent.change(screen.getByTestId('source-editor'), { target: { value: '# 更新草稿' } });
    else act(() => documentEditor().commands.insertContent('更新草稿'));
    await act(async () => finish({ ok: true, document: { ...sampleDoc, content: submitted } }));
    expect(setUnsavedChanges).toHaveBeenLastCalledWith(true);
    if (mode === 'read') fireEvent.click(screen.getByTestId('btn-read'));
    expect(documentEditor().state.doc.textContent).toContain('更新草稿');
    await pressCtrlKey('s');
    expect(saveMarkdownFile.mock.calls.at(-1)![1]).toContain('更新草稿');
  });

  test('a source save completed after returning to the document establishes a clean baseline', async () => {
    let finish!: (value: unknown) => void;
    saveMarkdownFile.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await screen.findByTestId('markdown-body');
    fireEvent.click(screen.getByTestId('btn-edit'));
    fireEvent.change(screen.getByTestId('source-editor'), { target: { value: '# 已提交' } });
    await pressCtrlKey('s');
    fireEvent.click(screen.getByTestId('btn-read'));
    await act(async () => finish({ ok: true, document: { ...sampleDoc, content: '# 已提交' } }));
    expect(setUnsavedChanges).toHaveBeenLastCalledWith(false);
    expect(documentEditor().state.doc.textContent).toBe('已提交');
  });

  test('equivalent source syntax retains native close protection until the exact draft is saved', async () => {
    const original = '## H\n\nbody\n';
    const draft = 'H\n---\n\nbody\n';
    chooseMarkdownFile.mockResolvedValueOnce({ ok: true, document: { ...sampleDoc, content: original } });
    saveMarkdownFile.mockImplementationOnce(async (_path, content) => ({ ok: true, document: { ...sampleDoc, content } }));
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await screen.findByTestId('markdown-body');
    fireEvent.click(screen.getByTestId('btn-edit'));
    fireEvent.change(screen.getByTestId('source-editor'), { target: { value: draft } });
    fireEvent.click(screen.getByTestId('btn-read'));
    await waitFor(() => expect(setUnsavedChanges).toHaveBeenLastCalledWith(true));
    expect(document.title).toContain('•');
    await act(async () => closeRequestedHandler?.());
    expect(screen.getByTestId('close-cancel')).toBeTruthy();
    fireEvent.click(screen.getByTestId('close-cancel'));
    expect(confirmClose).toHaveBeenCalledWith(false);
    await pressCtrlKey('s');
    expect(saveMarkdownFile).toHaveBeenLastCalledWith(sampleDoc.path, draft);
    await waitFor(() => expect(setUnsavedChanges).toHaveBeenLastCalledWith(false));
  });

  test('an old save response cannot replace a new document session', async () => {
    let finish!: (value: unknown) => void;
    saveMarkdownFile.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await screen.findByTestId('markdown-body');
    await pressCtrlKey('s');
    openMarkdownFile.mockResolvedValueOnce({ ok: true, document: { ...sampleDoc, path: 'C:/docs/next.md', content: '# 新会话' } });
    await act(async () => openFilePathHandler?.('C:/docs/next.md'));
    expect(documentEditor().state.doc.textContent).toBe('新会话');
    await act(async () => finish({ ok: true, document: sampleDoc }));
    expect(documentEditor().state.doc.textContent).toBe('新会话');
    expect(documentEditor().can().undo()).toBe(false);
    expect(setUnsavedChanges).toHaveBeenLastCalledWith(false);
  });

  test('search left open across mode changes preserves each scroll position and source selection', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await screen.findByTestId('markdown-body');
    const main = screen.getByRole('main');
    fireEvent.click(screen.getByTestId('btn-edit'));
    await pressCtrlKey('f');
    fireEvent.change(screen.getByTestId('search-input'), { target: { value: '正文' } });
    const source = screen.getByTestId('source-editor') as HTMLTextAreaElement;
    source.setSelectionRange(1, 3);
    main.scrollTop = 123;
    fireEvent.click(screen.getByTestId('btn-read'));
    main.scrollTop = 234;
    fireEvent.click(screen.getByTestId('btn-edit'));
    expect(main.scrollTop).toBe(123);
    expect((screen.getByTestId('source-editor') as HTMLTextAreaElement).selectionStart).toBe(1);
    expect((screen.getByTestId('source-editor') as HTMLTextAreaElement).selectionEnd).toBe(3);
    fireEvent.click(screen.getByTestId('btn-read'));
    expect(main.scrollTop).toBe(234);
  });

  test('source search navigation reuses highlight nodes and measures the selected result once', async () => {
    chooseMarkdownFile.mockResolvedValueOnce({ ok: true, document: { ...sampleDoc, content: '匹配 一\n\n匹配 二\n\n匹配 三' } });
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await screen.findByTestId('markdown-body');
    fireEvent.click(screen.getByTestId('btn-edit'));
    Object.defineProperty(screen.getByRole('main'), 'clientHeight', { value: 600 });
    await pressCtrlKey('f');
    fireEvent.change(screen.getByTestId('search-input'), { target: { value: '匹配' } });
    const layer = screen.getByTestId('source-search-highlight-layer');
    const marks = [...layer.querySelectorAll('mark')];
    const measure = vi.spyOn(window, 'getComputedStyle');
    try {
      fireEvent.click(screen.getByTestId('search-next'));
      [...layer.querySelectorAll('mark')].forEach((mark, index) => expect(mark).toBe(marks[index]));
      expect(layer.querySelectorAll('[data-active-search="true"]')).toHaveLength(1);
      expect(marks[1].getAttribute('data-active-search')).toBe('true');
      expect(measure.mock.calls.filter(([element]) => element === screen.getByTestId('source-editor'))).toHaveLength(1);
    } finally { measure.mockRestore(); }
  });

  test('first source visit maps the visible block and later visits restore the source cursor', async () => {
    const content = '# 标题\n\n第一段\n\n目标段落';
    chooseMarkdownFile.mockResolvedValueOnce({ ok: true, document: { ...sampleDoc, content } });
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await screen.findByTestId('markdown-body');
    const editor = documentEditor();
    const main = screen.getByRole('main');
    Object.defineProperty(main, 'clientHeight', { value: 600 });
    Object.defineProperty(main, 'scrollHeight', { value: 4000 });
    let position = 0;
    editor.state.doc.descendants((node, pos) => { if (node.textContent === '目标段落' && node.isTextblock) position = pos + 1; });
    const caret = vi.spyOn(editor.view, 'coordsAtPos').mockReturnValue({ top: -100, bottom: -80, left: 0, right: 1 });
    const visible = vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ pos: position, inside: position - 1 });
    try {
      fireEvent.click(screen.getByTestId('btn-edit'));
      const source = screen.getByTestId('source-editor') as HTMLTextAreaElement;
      expect(source.selectionStart).toBe(content.indexOf('目标段落'));
      expect(source.value).toBe(content);
      expect(setUnsavedChanges.mock.lastCall?.[0]).toBe(false);
      source.setSelectionRange(2, 4);
      fireEvent.click(screen.getByTestId('btn-read'));
      fireEvent.click(screen.getByTestId('btn-edit'));
      expect((screen.getByTestId('source-editor') as HTMLTextAreaElement).selectionStart).toBe(2);
      expect((screen.getByTestId('source-editor') as HTMLTextAreaElement).selectionEnd).toBe(4);
    } finally { caret.mockRestore(); visible.mockRestore(); }
  });

  test('clicking link text edits it; opening uses the explicit link action', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());
    fireEvent.click(screen.getByTestId('markdown-body').querySelector('a')!);
    expect(inspectMarkdownLink).not.toHaveBeenCalled();
    await openSelectedLink();
    await waitFor(() => expect(screen.getByTestId('external-link-modal')).toBeTruthy());
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  test('pending document open disables continuous editing and recovers after failure', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());
    let resolveOpen!: (value: unknown) => void;
    chooseMarkdownFile.mockReturnValueOnce(new Promise(resolve => { resolveOpen = resolve; }));
    fireEvent.click(screen.getByTestId('btn-open'));
    expect(documentEditor().isEditable).toBe(false);
    await act(async () => resolveOpen({ ok: false, code: 'READ_FAILED', message: '读取失败' }));
    expect(documentEditor().isEditable).toBe(true);
  });

  test.each(['picker', 'path', 'link'])('rejected %s open keeps the draft/history and recovers editing', async origin => {
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await screen.findByTestId('markdown-body');
    const editor = documentEditor();
    act(() => editor.commands.insertContent('异常后保留'));
    const failure = new Error('读取异常，草稿已保留');
    if (origin === 'picker') {
      chooseMarkdownFile.mockRejectedValueOnce(failure);
      fireEvent.click(screen.getByTestId('btn-open'));
    } else if (origin === 'path') {
      openMarkdownFile.mockRejectedValueOnce(failure);
      await act(async () => openFilePathHandler?.('C:/docs/next.md'));
    } else {
      inspectMarkdownLink.mockResolvedValueOnce({ ok: true, action: 'markdown' });
      openMarkdownLink.mockRejectedValueOnce(failure);
      await openSelectedLink();
    }
    fireEvent.click(await screen.findByTestId('discard-confirm'));
    await waitFor(() => expect(screen.getByTestId('status-text').textContent).toBe(failure.message));
    expect(documentEditor()).toBe(editor);
    expect(editor.state.doc.textContent).toContain('异常后保留');
    expect(editor.can().undo()).toBe(true);
    await waitFor(() => expect(editor.isEditable).toBe(true));
    expect(setUnsavedChanges).toHaveBeenLastCalledWith(true);
  });

  test('conversion failure protects the current document and recovers latest content into source mode', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());
    const editor = documentEditor();
    vi.spyOn(editor.markdown!, 'serialize').mockImplementation(() => { throw new Error('serialization failed'); });
    act(() => editor.view.dispatch(editor.state.tr.insertText('恢复内容', 1)));
    expect((await screen.findByRole('alert')).textContent).toContain('内容转换失败');
    expect(setUnsavedChanges.mock.calls.at(-1)?.[0]).toBe(true);
    await pressCtrlKey('s');
    expect(saveMarkdownFile).not.toHaveBeenCalled();
    await act(async () => closeRequestedHandler?.());
    expect(screen.getByTestId('discard-modal')).toBeTruthy();
    fireEvent.click(screen.getByTestId('discard-modal'));
    fireEvent.click(screen.getByRole('button', { name: '源码恢复' }));
    expect(screen.getByTestId('source-editor')).toHaveProperty('value', expect.stringContaining('恢复内容标题'));
    await pressCtrlKey('s');
    expect(saveMarkdownFile.mock.calls.at(-1)?.[1]).toContain('恢复内容标题');
  });

  test('a close requested during composition waits for the final text before prompting', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());
    const body = screen.getByTestId('markdown-body');
    fireEvent.compositionStart(body);
    await act(async () => closeRequestedHandler?.());
    expect(confirmClose).not.toHaveBeenCalled();
    expect(screen.queryByTestId('discard-modal')).toBeNull();
    act(() => documentEditor().view.dispatch(documentEditor().state.tr.insertText('输入法', 1)));
    fireEvent.compositionEnd(body);
    await waitFor(() => expect(screen.getByTestId('discard-modal')).toBeTruthy());
    expect(documentEditor().state.doc.textContent).toContain('输入法标题');
  });

  test('opening another document replaces the editor and its history', async () => {
    openMarkdownFile.mockResolvedValueOnce({ ok: true, document: { ...sampleDoc, path: 'C:\\docs\\next.md', content: '# 下一个文档' } });
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());
    const originalEditor = documentEditor();
    screen.getByTestId('content').scrollTop = 2400;
    await pressCtrlKey('f');
    expect(screen.getByTestId('search-bar')).toBeTruthy();
    await act(async () => openFilePathHandler?.('C:\\docs\\next.md'));
    await waitFor(() => expect(documentEditor().state.doc.textContent).toBe('下一个文档'));
    expect(documentEditor()).not.toBe(originalEditor);
    expect(documentEditor().can().undo()).toBe(false);
    expect(screen.getByTestId('content').scrollTop).toBe(0);
    expect(screen.queryByTestId('search-bar')).toBeNull();
  });

  test.each(['click', 'Enter', ' '])('activates a leading raw source fragment on first %s without dirtying the document', async action => {
    chooseMarkdownFile.mockResolvedValueOnce({ ok: true, document: { ...sampleDoc, content: '<!-- comment -->\n\n正文' } });
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    const preview = await screen.findByRole('button', { name: '编辑源码片段' });
    // jsdom has no Range geometry.
    act(() => documentEditor().view.setProps({ handleScrollToSelection: () => true }));
    expect(documentEditor().state.selection.from).toBe(1);
    if (action === 'click') fireEvent.click(preview);
    else fireEvent.keyDown(preview, { key: action });
    expect(preview.parentElement?.dataset.active).toBe('true');
    expect(setUnsavedChanges.mock.calls.at(-1)?.[0]).toBe(false);
    act(() => documentEditor().view.dispatch(documentEditor().state.tr.insertText('新增', 5)));
    await pressCtrlKey('s');
    expect(saveMarkdownFile.mock.calls.at(-1)?.[1]).toContain('<!--新增 comment -->');
  });


  test('the first toolbar save flushes a focused document and retains its draft after failure', async () => {
    saveMarkdownFile.mockResolvedValueOnce({ ok: false, code: 'SAVE_FAILED', message: '请重试保存' });
    saveMarkdownFile.mockImplementationOnce(async (_path, content) => ({ ok: true, document: { ...sampleDoc, content } }));
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    const body = await screen.findByTestId('markdown-body');
    act(() => {
      documentEditor().view.focus();
      documentEditor().view.dispatch(documentEditor().state.tr.insertText('首次点击', 1));
    });
    expect(document.activeElement).toBe(body);
    const save = screen.getByTestId('btn-save') as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await screen.findByText('请重试保存');
    expect(saveMarkdownFile).toHaveBeenCalledWith(sampleDoc.path, expect.stringContaining('# 首次点击标题'));
    expect(body.textContent).toContain('首次点击标题');
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(save.disabled).toBe(true));
    expect(saveMarkdownFile).toHaveBeenCalledTimes(2);
    expect(saveMarkdownFile.mock.calls[1][1]).toBe(saveMarkdownFile.mock.calls[0][1]);
    expect(setUnsavedChanges).toHaveBeenLastCalledWith(false);
  });

  test('find ignores IME shortcut events and repeated invocation preserves the query', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await screen.findByTestId('markdown-body');
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true, isComposing: true });
    expect(screen.queryByTestId('search-bar')).toBeNull();
    fireEvent.click(screen.getByTestId('btn-search'));
    const input = screen.getByTestId('search-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '搜索词' } });
    act(() => documentEditor().view.focus());
    await pressCtrlKey('f');
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(input.value).toBe('搜索词');
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: 'Escape', isComposing: true });
    expect(screen.getByTestId('search-bar')).toBeTruthy();
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByTestId('search-bar')).toBeNull();
  });

  test('a native close confirmation owns delayed search focus and has a neutral initial focus', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await screen.findByTestId('markdown-body');
    fireEvent.click(screen.getByTestId('btn-edit'));
    fireEvent.change(screen.getByTestId('source-editor'), { target: { value: '# 保留草稿\n' } });
    fireEvent.click(screen.getByTestId('btn-search'));
    act(() => closeRequestedHandler!());
    const dialog = screen.getByRole('dialog');
    await act(async () => new Promise(resolve => window.setTimeout(resolve, 10)));
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByTestId('close-save'));
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByTestId('close-cancel'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect((screen.getByTestId('source-editor') as HTMLTextAreaElement).value).toBe('# 保留草稿\n');
    expect(confirmClose).toHaveBeenLastCalledWith(false);
  });

  test('the outline close button restores its toggle and an outside click still activates its target', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    try {
      render(<App />);
      fireEvent.click(screen.getByTestId('btn-open'));
      await screen.findByTestId('markdown-body');
      const toggle = screen.getByTestId('btn-outline');
      fireEvent.click(toggle);
      fireEvent.click(screen.getByRole('button', { name: '关闭目录' }));
      expect(screen.queryByTestId('outline-panel')).toBeNull();
      expect(document.activeElement).toBe(toggle);
      fireEvent.click(toggle);
      fireEvent.pointerDown(screen.getByTestId('btn-edit'));
      fireEvent.click(screen.getByTestId('btn-edit'));
      expect(screen.queryByTestId('outline-panel')).toBeNull();
      expect(screen.getByTestId('source-editor')).toBeTruthy();
    } finally { vi.unstubAllGlobals(); }
  });

  test('source mode accepts empty quotes and list items without losing editability', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());
    fireEvent.click(screen.getByTestId('btn-edit'));
    fireEvent.change(screen.getByTestId('source-editor'), { target: { value: '>\n\n-\n\n1.\n\n正文' } });
    fireEvent.click(screen.getByTestId('btn-read'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(documentEditor().isEditable).toBe(true);
    expect(() => documentEditor().state.doc.check()).not.toThrow();
  });
});
