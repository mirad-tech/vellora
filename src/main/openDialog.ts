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

export type ShowMarkdownDialog = () => Promise<Pick<OpenDialogReturnValue, 'canceled' | 'filePaths'>>;

export async function openMarkdownFromDialog(
  showOpenDialog: ShowMarkdownDialog,
  lang: 'zh' | 'en' = 'en'
): Promise<MarkdownOpenResult> {
  const result = await showOpenDialog();

  if (result.canceled || result.filePaths.length === 0) {
    return {
      ok: false,
      code: 'CANCELED',
      message: lang === 'zh' ? '未选择文件。' : 'No file selected.'
    };
  }

  return readMarkdownFile(result.filePaths[0]);
}

export async function openWorkspaceFromDialog(
  showOpenDialog: ShowMarkdownDialog,
  options: WorkspaceOpenOptions = {},
  lang: 'zh' | 'en' = 'en'
): Promise<WorkspaceOpenResult> {
  const result = await showOpenDialog();

  if (result.canceled || result.filePaths.length === 0) {
    return {
      ok: false,
      code: 'CANCELED',
      message: lang === 'zh' ? '未选择文件夹。' : 'No folder selected.'
    };
  }

  return openMarkdownWorkspace(result.filePaths[0], options);
}
