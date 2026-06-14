import type { OpenDialogOptions, OpenDialogReturnValue } from 'electron';

import { readMarkdownFile } from './fileAccess';
import { openMarkdownWorkspace, type WorkspaceOpenOptions } from './workspaceAccess';
import type { MarkdownOpenResult, WorkspaceOpenResult } from '../shared/documentTypes';

export function getMarkdownDialogOptions(lang: 'zh' | 'en' = 'en'): OpenDialogOptions {
  return {
    title: lang === 'zh' ? '打开 Markdown 文件' : 'Open Markdown File',
    properties: ['openFile'],
    filters: [
      {
        name: 'Markdown',
        extensions: ['md', 'markdown']
      }
    ]
  };
}

export function getWorkspaceDialogOptions(lang: 'zh' | 'en' = 'en'): OpenDialogOptions {
  return {
    title: lang === 'zh' ? '打开文件夹' : 'Open Folder',
    properties: ['openDirectory']
  };
}

export const MARKDOWN_DIALOG_OPTIONS = getMarkdownDialogOptions();
export const WORKSPACE_DIALOG_OPTIONS = getWorkspaceDialogOptions();

export type ShowMarkdownDialog = () => Promise<Pick<OpenDialogReturnValue, 'canceled' | 'filePaths'>>;

export async function openMarkdownFromDialog(
  showOpenDialog: ShowMarkdownDialog
): Promise<MarkdownOpenResult> {
  const result = await showOpenDialog();

  if (result.canceled || result.filePaths.length === 0) {
    return {
      ok: false,
      code: 'CANCELED',
      message: '未选择文件。'
    };
  }

  return readMarkdownFile(result.filePaths[0]);
}

export async function openWorkspaceFromDialog(
  showOpenDialog: ShowMarkdownDialog,
  options: WorkspaceOpenOptions = {}
): Promise<WorkspaceOpenResult> {
  const result = await showOpenDialog();

  if (result.canceled || result.filePaths.length === 0) {
    return {
      ok: false,
      code: 'CANCELED',
      message: '未选择文件夹。'
    };
  }

  return openMarkdownWorkspace(result.filePaths[0], options);
}
