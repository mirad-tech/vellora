import { contextBridge, ipcRenderer, webUtils } from 'electron';

import { IPC_CHANNELS } from '../shared/ipcChannels';
import type { MdViewerApi } from './types';

const pendingMarkdownOpenRequests: string[] = [];
const markdownOpenListeners = new Set<(filePath: string) => void>();

ipcRenderer.on(IPC_CHANNELS.MARKDOWN_OPEN_REQUESTED, (_event, filePath: unknown) => {
  if (typeof filePath !== 'string' || filePath.trim() === '') return;

  if (markdownOpenListeners.size === 0) {
    pendingMarkdownOpenRequests.push(filePath);
    return;
  }

  for (const listener of markdownOpenListeners) {
    listener(filePath);
  }
});

const api: MdViewerApi = {
  openMarkdownFile: () => ipcRenderer.invoke(IPC_CHANNELS.OPEN_MARKDOWN_DIALOG),
  openMarkdownByPath: (filePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.OPEN_MARKDOWN_BY_PATH, filePath),
  onMarkdownOpenRequested: (callback: (filePath: string) => void) => {
    markdownOpenListeners.add(callback);

    while (pendingMarkdownOpenRequests.length > 0) {
      const filePath = pendingMarkdownOpenRequests.shift();
      if (filePath) callback(filePath);
    }

    return () => {
      markdownOpenListeners.delete(callback);
    };
  },
  openDroppedMarkdownFile: (file: File) => {
    const filePath = webUtils.getPathForFile(file);
    return ipcRenderer.invoke(IPC_CHANNELS.OPEN_MARKDOWN_BY_PATH, filePath, true);
  },
  openWorkspaceFolder: () => ipcRenderer.invoke(IPC_CHANNELS.OPEN_WORKSPACE_DIALOG),
  openWorkspaceByPath: (folderPath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.OPEN_WORKSPACE_BY_PATH, folderPath),
  getRecentItems: () => ipcRenderer.invoke(IPC_CHANNELS.GET_RECENT_ITEMS),
  saveMarkdownFile: (filePath: string, content: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SAVE_MARKDOWN_FILE, filePath, content),
  openDefaultEditor: (filePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.OPEN_DEFAULT_EDITOR, filePath),
  setUnsavedChanges: (hasUnsavedChanges: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.SET_UNSAVED_CHANGES, hasUnsavedChanges),
  confirmDiscardChanges: () => ipcRenderer.invoke(IPC_CHANNELS.CONFIRM_DISCARD_CHANGES),
  resolveMarkdownImage: (documentPath: string, imageSource: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.RESOLVE_MARKDOWN_IMAGE, documentPath, imageSource),
  openMarkdownLink: (documentPath: string, href: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.OPEN_MARKDOWN_LINK, documentPath, href),
  getSecurityDiagnostics: () => ipcRenderer.invoke(IPC_CHANNELS.GET_SECURITY_DIAGNOSTICS)
};

contextBridge.exposeInMainWorld('mdViewer', api);
