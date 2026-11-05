// @vitest-environment jsdom
// 保存 / 重开 / 预览的边界回归：
// 1) 预览锚点链接不触发 IPC 检查（有效编码）；无效编码显示"链接格式无效"
// 2) FILE_CHANGED 冲突选择"重新加载"的成功路径替换为磁盘版本并关闭对话框
// 3) 保存成功后以后端返回内容为新基线，干净状态下重开同一文件无需丢弃确认

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { MarkdownDocument } from '../types';
import type { Editor } from '@tiptap/core';

const sampleDoc: MarkdownDocument = {
  path: 'C:\\docs\\sample.md',
  name: 'sample.md',
  content: '# 标题\n\n正文\n',
  modifiedAt: 1,
  size: 16
};

const diskDoc: MarkdownDocument = {
  path: 'C:\\docs\\sample.md',
  name: 'sample.md',
  content: '# 磁盘上的新版本\n',
  modifiedAt: 2,
  size: 24
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

vi.mock('../api/tauri', () => ({
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

import App from '../App';

async function pressCtrlKey(key: string): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true }));
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

describe('save / reopen / preview boundaries', () => {
  let openFilePathHandler: ((path: string) => void) | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    openFilePathHandler = null;
    getInitialDocument.mockResolvedValue({ ok: false, code: 'NO_INITIAL', message: '没有初始文档。' });
    setUnsavedChanges.mockResolvedValue({ ok: true });
    confirmClose.mockResolvedValue({ ok: true });
    chooseMarkdownFile.mockResolvedValue({ ok: true, document: sampleDoc });
    openMarkdownFile.mockResolvedValue({ ok: true, document: sampleDoc });
    saveMarkdownFile.mockImplementation(async (_path: string, content: string) => ({
      ok: true,
      document: { ...sampleDoc, content }
    }));
    resolveLocalImage.mockResolvedValue({ ok: false, code: 'IMAGE_NOT_FOUND', message: '图片不存在或已被移动。' });
    inspectMarkdownLink.mockResolvedValue({ ok: true, action: 'external', url: 'https://example.com/' });
    openMarkdownLink.mockResolvedValue({ ok: true, document: sampleDoc });
    openExternalUrl.mockResolvedValue({ ok: true });
    onOpenFilePath.mockImplementation((handler: (path: string) => void) => {
      openFilePathHandler = handler;
      return Promise.resolve(() => {
        if (openFilePathHandler === handler) openFilePathHandler = null;
      });
    });
    onCloseRequested.mockImplementation((handler: () => void) => Promise.resolve(() => undefined));
    onDragDropPaths.mockResolvedValue(() => undefined);
  });

  afterEach(() => {
    openFilePathHandler = null;
    cleanup();
  });

  test('a well-formed anchor link jumps to the heading locally without IPC link inspection', async () => {
    // heading id 由渲染层生成（heading-<文本>），锚点 href 会被编码后解码回原文
    chooseMarkdownFile.mockResolvedValueOnce({
      ok: true,
      document: { ...sampleDoc, content: '# 中文标题\n\n[好](#heading-中文标题)\n' }
    });
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await screen.findByTestId('markdown-body');

    await openSelectedLink();

    expect(inspectMarkdownLink).not.toHaveBeenCalled();
    expect(openMarkdownLink).not.toHaveBeenCalled();
    expect(openExternalUrl).not.toHaveBeenCalled();
    expect(screen.getByTestId('status-text').textContent).not.toContain('链接格式无效');
    // 命中真实标题：scrollToHeading 会把焦点移到内容区
    expect(document.activeElement).toBe(screen.getByTestId('content'));
  });

  test('a malformed raw-HTML anchor link shows the invalid-link status without IPC inspection', async () => {
    // 普通 Markdown 链接的 % 会在导入时被编码（#% → #%25），只有 raw HTML 的 href 保留原始非法序列
    chooseMarkdownFile.mockResolvedValueOnce({
      ok: true,
      document: { ...sampleDoc, content: '<a href="#%zz">坏链接</a>\n' }
    });
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    const body = await screen.findByTestId('markdown-body');
    act(() => documentEditor().view.setProps({ handleScrollToSelection: () => true }));

    fireEvent.click(body.querySelector('.raw-source-preview a')!, { ctrlKey: true });

    expect(inspectMarkdownLink).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByTestId('status-text').textContent).toContain('链接格式无效');
    });
  });

  test('a confirmed conflict reload adopts the disk revision and closes the dialog', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await screen.findByTestId('markdown-body');
    act(() => documentEditor().commands.insertContent('本地未保存修改'));

    saveMarkdownFile.mockResolvedValueOnce({
      ok: false, code: 'FILE_CHANGED', message: '磁盘内容已修改', conflictToken: 'disk-rev'
    });
    await pressCtrlKey('s');
    await screen.findByRole('dialog', { name: '文件已被外部修改' });

    fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
    openMarkdownFile.mockResolvedValueOnce({ ok: true, document: diskDoc });
    fireEvent.click(screen.getByRole('button', { name: '放弃草稿并重新加载' }));

    await waitFor(() => expect(openMarkdownFile).toHaveBeenCalledWith(sampleDoc.path));
    await waitFor(() => {
      expect(screen.queryByTestId('conflict-modal')).toBeNull();
    });
    expect(documentEditor().state.doc.textContent).toContain('磁盘上的新版本');
    expect(documentEditor().state.doc.textContent).not.toContain('本地未保存修改');
  });

  test('a successful save adopts the returned revision and a clean reopen needs no discard confirmation', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('btn-open'));
    await screen.findByTestId('markdown-body');

    fireEvent.click(screen.getByTestId('btn-edit'));
    const normalized = '# 规范化后的内容\n';
    fireEvent.change(screen.getByTestId('source-editor'), { target: { value: '# 改动\n' } });
    saveMarkdownFile.mockResolvedValueOnce({ ok: true, document: { ...sampleDoc, content: normalized } });
    await pressCtrlKey('s');

    await waitFor(() => {
      expect(saveMarkdownFile).toHaveBeenCalledWith(sampleDoc.path, '# 改动\n');
    });
    await waitFor(() => {
      expect((screen.getByTestId('source-editor') as HTMLTextAreaElement).value).toBe(normalized);
    });
    await waitFor(() => {
      expect(setUnsavedChanges).toHaveBeenLastCalledWith(false);
    });

    openMarkdownFile.mockResolvedValueOnce({ ok: true, document: { ...sampleDoc, content: normalized } });
    await act(async () => {
      openFilePathHandler?.(sampleDoc.path);
    });
    await waitFor(() => expect(openMarkdownFile).toHaveBeenCalledWith(sampleDoc.path));
    expect(screen.queryByRole('dialog')).toBeNull();
    await screen.findByTestId('markdown-body');
    await waitFor(() => {
      expect(documentEditor().state.doc.textContent).toContain('规范化后的内容');
    });
  });
});
