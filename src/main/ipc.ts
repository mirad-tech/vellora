import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { existsSync, statSync, lstatSync, realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDefaultEditor, saveMarkdownFile } from './documentWrite';
import { isMarkdownPath, readMarkdownFile } from './fileAccess';
import { resolveMarkdownImage } from './imageAccess';
import { exportWindowToPdf } from './pdfExport';
import { openMarkdownLink } from './linkAccess';
import {
  getMarkdownDialogOptions,
  getWorkspaceDialogOptions,
  openMarkdownFromDialog,
  openWorkspaceFromDialog
} from './openDialog';
import { createRecentStore } from './recentStore';
import { createSecurityDiagnostics } from './security';
import { openMarkdownWorkspace, type WorkspaceOpenOptions } from './workspaceAccess';
import { isPathInsideDirectory, normalizePath, getSafeUserDirectories, isDangerousSystemDirectory } from './pathPolicy';
import { IPC_CHANNELS } from '../shared/ipcChannels';
import { translateResultMessage } from '../shared/mainI18n';
import type { MenuManager } from './nativeMenu';
import type { MarkdownLinkOpenResult, MarkdownOpenResult, WorkspaceOpenResult } from '../shared/documentTypes';

const authorizedFiles = new Set<string>();
const authorizedDirs = new Set<string>();
let currentLang: 'zh' | 'en' = 'en';

const REGISTERED_HANDLER_CHANNELS = [
  IPC_CHANNELS.OPEN_MARKDOWN_DIALOG,
  IPC_CHANNELS.OPEN_MARKDOWN_BY_PATH,
  IPC_CHANNELS.RESOLVE_MARKDOWN_IMAGE,
  IPC_CHANNELS.OPEN_MARKDOWN_LINK,
  IPC_CHANNELS.OPEN_WORKSPACE_DIALOG,
  IPC_CHANNELS.OPEN_WORKSPACE_BY_PATH,
  IPC_CHANNELS.GET_RECENT_ITEMS,
  IPC_CHANNELS.SAVE_MARKDOWN_FILE,
  IPC_CHANNELS.OPEN_DEFAULT_EDITOR,
  IPC_CHANNELS.EXPORT_TO_PDF,
  IPC_CHANNELS.SET_UNSAVED_CHANGES,
  IPC_CHANNELS.CONFIRM_DISCARD_CHANGES,
  IPC_CHANNELS.GET_SECURITY_DIAGNOSTICS,
  IPC_CHANNELS.SET_LANGUAGE,
  IPC_CHANNELS.REMOVE_RECENT_ITEM
] as const;

const unsavedDialogs = {
  zh: {
    buttons: ['继续编辑', '放弃更改'] as [string, string],
    message: '当前文档有未保存更改。'
  },
  en: {
    buttons: ['Continue Editing', 'Discard Changes'] as [string, string],
    message: 'The current document has unsaved changes.'
  }
};

let recentStoreRef: ReturnType<typeof createRecentStore> | null = null;

async function verifyAndAuthorizeFromRecent(filePath: string, type: 'file' | 'folder'): Promise<boolean> {
  if (!recentStoreRef) return false;
  try {
    const res = await recentStoreRef.read();
    if (res.ok) {
      const norm = normalizePath(filePath);
      for (const item of res.items) {
        if (item.exists && normalizePath(item.path) === norm) {
          if (type === 'file' && item.type === 'file') {
            authorizedFiles.add(norm);
            return true;
          }
          if (type === 'folder' && item.type === 'folder') {
            authorizedDirs.add(norm);
            return true;
          }
        }
      }
    }
  } catch {
    // ignore
  }
  return false;
}

function isTestMode(): boolean {
  return (
    process.env.NODE_ENV === 'test' ||
    !!process.env.VITEST ||
    !!process.env.PLAYWRIGHT_TEST
  );
}

function isInsideTestTempDirectory(normPath: string): boolean {
  return isTestMode() && isPathInsideDirectory(normPath, tmpdir());
}

function resolveRealPathAndCheckDanger(filePath: string): string | null {
  let targetPath = filePath;
  try {
    const lstats = lstatSync(filePath);
    if (lstats.isSymbolicLink()) {
      targetPath = realpathSync(filePath);
    }
  } catch {
    // ignore
  }
  const norm = normalizePath(targetPath);
  if (isDangerousSystemDirectory(norm) && !isInsideTestTempDirectory(norm)) {
    return null;
  }
  return norm;
}

async function handleUnresolvedFileAuthorization(
  filePath: string,
  window: BrowserWindow
): Promise<boolean> {
  const normPath = resolveRealPathAndCheckDanger(filePath);
  if (!normPath) return false;

  const safeDirs = getSafeUserDirectories();
  if (isTestMode()) {
    safeDirs.push(normalizePath(tmpdir()));
  }

  const isInsideSafeDir = safeDirs.some(dir => isPathInsideDirectory(normPath, dir));
  const isInsideAuthWorkspace = Array.from(authorizedDirs).some(dir => isPathInsideDirectory(normPath, dir));

  if (isInsideSafeDir || isInsideAuthWorkspace) {
    authorizedFiles.add(normPath);
    return true;
  }

  const trConfirm = {
    zh: {
      message: `您正在尝试打开外部文件：\n${filePath}\n\n该路径不属于常用用户目录，是否授权并打开？`,
      buttons: ['取消', '授权并打开']
    },
    en: {
      message: `You are attempting to open an external file:\n${filePath}\n\nThe path is outside common user directories. Do you want to authorize and open it?`,
      buttons: ['Cancel', 'Authorize and Open']
    }
  };

  const lang = currentLang === 'zh' ? 'zh' : 'en';
  const choice = await dialog.showMessageBox(window, {
    type: 'question',
    buttons: trConfirm[lang].buttons,
    defaultId: 0,
    cancelId: 0,
    message: trConfirm[lang].message
  });

  if (choice.response === 1) {
    authorizedFiles.add(normPath);
    return true;
  }

  return false;
}

async function isFileAuthorized(filePath: string): Promise<boolean> {
  const normPath = resolveRealPathAndCheckDanger(filePath);
  if (!normPath) return false;

  if (authorizedFiles.has(normPath)) {
    return true;
  }
  for (const dir of authorizedDirs) {
    if (isPathInsideDirectory(normPath, dir)) {
      return true;
    }
  }

  if (isInsideTestTempDirectory(normPath)) {
    return true;
  }

  const isRecent = await verifyAndAuthorizeFromRecent(normPath, 'file');
  if (isRecent) {
    return true;
  }

  return false;
}

async function isDirAuthorized(dirPath: string): Promise<boolean> {
  const normPath = resolveRealPathAndCheckDanger(dirPath);
  if (!normPath) return false;

  if (authorizedDirs.has(normPath)) {
    return true;
  }
  for (const dir of authorizedDirs) {
    if (isPathInsideDirectory(normPath, dir)) {
      return true;
    }
  }

  if (isInsideTestTempDirectory(normPath)) {
    return true;
  }

  const isRecent = await verifyAndAuthorizeFromRecent(normPath, 'folder');
  if (isRecent) {
    return true;
  }

  return false;
}

function workspaceOptionsFromEnvironment(): WorkspaceOpenOptions {
  const rawLimit = process.env.MD_VIEWER_WORKSPACE_FILE_LIMIT;
  if (!rawLimit) return {};
  const parsedLimit = Number.parseInt(rawLimit, 10);
  if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) return {};
  return { maxMarkdownFiles: parsedLimit };
}

function createDefaultRecentStore() {
  return createRecentStore(join(app.getPath('userData'), 'viewer-state', 'recent.json'));
}

function tr<T extends { ok: boolean; message?: string }>(result: T): T {
  return translateResultMessage(result, currentLang);
}

export function authorizeMarkdownOpenRequest(filePath: unknown): boolean {
  if (typeof filePath !== 'string' || filePath.trim() === '') return false;
  if (!isMarkdownPath(filePath)) return false;

  try {
    if (!statSync(filePath).isFile()) return false;
    authorizedFiles.add(normalizePath(filePath));
    return true;
  } catch {
    return false;
  }
}

function resetIpcHandlers(): void {
  for (const channel of REGISTERED_HANDLER_CHANNELS) {
    ipcMain.removeHandler(channel);
  }
}

async function recordRecentSafely(
  recentStore: ReturnType<typeof createRecentStore>,
  type: 'file' | 'folder',
  path: string
): Promise<void> {
  try {
    await recentStore.record({ type, path });
    if (type === 'file') {
      authorizedFiles.add(normalizePath(path));
    } else {
      authorizedDirs.add(normalizePath(path));
    }
  } catch {
    // Recent history must not make the primary file/folder open flow fail.
  }
}

export function registerIpcHandlers(window: BrowserWindow, menuManager?: MenuManager<any>): void {
  resetIpcHandlers();
  const recentStore = createDefaultRecentStore();
  recentStoreRef = recentStore;
  const workspaceOptions = workspaceOptionsFromEnvironment();
  let hasUnsavedChanges = false;
  let closeAllowed = false;

  // Initialize authorization sets with paths from recent store
  recentStore.read().then((res) => {
    if (res.ok) {
      for (const item of res.items) {
        if (item.exists) {
          if (item.type === 'file') {
            authorizedFiles.add(normalizePath(item.path));
          } else if (item.type === 'folder') {
            authorizedDirs.add(normalizePath(item.path));
          }
        }
      }
    }
  }).catch(() => {});

  window.on('close', async (event) => {
    if (!hasUnsavedChanges || closeAllowed) return;

    event.preventDefault();
    const dlg = unsavedDialogs[currentLang];
    const result = await dialog.showMessageBox(window, {
      type: 'warning',
      buttons: dlg.buttons,
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      message: dlg.message
    });

    if (result.response === 1) {
      hasUnsavedChanges = false;
      closeAllowed = true;
      window.close();
    }
  });

  ipcMain.handle(IPC_CHANNELS.OPEN_MARKDOWN_DIALOG, async () => {
    const result: MarkdownOpenResult = await openMarkdownFromDialog(() =>
      dialog.showOpenDialog(window, getMarkdownDialogOptions(currentLang)),
      currentLang
    );
    if (result.ok) {
      authorizedFiles.add(normalizePath(result.document.path));
      await recordRecentSafely(recentStore, 'file', result.document.path);
    }
    return tr(result);
  });

  ipcMain.handle(IPC_CHANNELS.OPEN_MARKDOWN_BY_PATH, async (_event, filePath: unknown) => {
    if (typeof filePath !== 'string' || filePath.trim() === '') {
      return tr({
        ok: false,
        code: 'INVALID_ARGUMENT',
        message: '文件路径无效。'
      });
    }
    if (!isMarkdownPath(filePath)) {
      return tr({
        ok: false,
        code: 'UNSUPPORTED_FILE_TYPE',
        message: '只能打开 .md 或 .markdown 文件。'
      });
    }

    if (!(await isFileAuthorized(filePath))) {
      const isAuthorized = await handleUnresolvedFileAuthorization(filePath, window);
      if (!isAuthorized) {
        return tr({
          ok: false,
          code: 'READ_FAILED',
          message: '无法读取文件，请检查权限或文件状态。'
        });
      }
    }
    const result = await readMarkdownFile(filePath);
    if (result.ok) {
      await recordRecentSafely(recentStore, 'file', result.document.path);
    }
    return tr(result);
  });

  ipcMain.handle(
    IPC_CHANNELS.RESOLVE_MARKDOWN_IMAGE,
    async (_event, documentPath: unknown, imageSource: unknown) => {
      if (typeof documentPath !== 'string' || !(await isFileAuthorized(documentPath))) {
        return tr({
          ok: false,
          code: 'INVALID_ARGUMENT',
          message: '文件路径无效。'
        });
      }
      const result = await resolveMarkdownImage(documentPath, imageSource, {
        allowedDirectories: Array.from(authorizedDirs)
      });
      return tr(result);
    }
  );

  ipcMain.handle(IPC_CHANNELS.OPEN_MARKDOWN_LINK, async (_event, documentPath: unknown, href: unknown) => {
    if (typeof documentPath !== 'string' || !(await isFileAuthorized(documentPath))) {
      return tr({
        ok: false,
        code: 'INVALID_ARGUMENT',
        message: '文件路径无效。'
      });
    }
    const result: MarkdownLinkOpenResult = await openMarkdownLink(
      documentPath,
      href,
      (url) => shell.openExternal(url),
      {
        allowedDirectories: Array.from(authorizedDirs)
      }
    );
    if (result.ok && result.action === 'markdown') {
      authorizedFiles.add(normalizePath(result.document.path));
      await recordRecentSafely(recentStore, 'file', result.document.path);
    }
    return tr(result);
  });

  ipcMain.handle(IPC_CHANNELS.OPEN_WORKSPACE_DIALOG, async () => {
    const result: WorkspaceOpenResult = await openWorkspaceFromDialog(
      () => dialog.showOpenDialog(window, getWorkspaceDialogOptions(currentLang)),
      workspaceOptions,
      currentLang
    );
    if (result.ok) {
      authorizedDirs.add(normalizePath(result.workspace.path));
      await recordRecentSafely(recentStore, 'folder', result.workspace.path);
    }
    return tr(result);
  });

  ipcMain.handle(IPC_CHANNELS.OPEN_WORKSPACE_BY_PATH, async (_event, folderPath: unknown) => {
    if (typeof folderPath !== 'string' || folderPath.trim() === '') {
      return tr({
        ok: false,
        code: 'INVALID_ARGUMENT',
        message: '文件夹路径无效。'
      });
    }
    if (!(await isDirAuthorized(folderPath))) {
      return tr({
        ok: false,
        code: 'READ_FAILED',
        message: '无法读取文件夹，请检查权限或文件状态。'
      });
    }
    const result = await openMarkdownWorkspace(folderPath, workspaceOptions);
    if (result.ok) {
      await recordRecentSafely(recentStore, 'folder', result.workspace.path);
    }
    return tr(result);
  });

  ipcMain.handle(IPC_CHANNELS.GET_RECENT_ITEMS, async () => {
    return tr(await recentStore.read());
  });

  ipcMain.handle(IPC_CHANNELS.SAVE_MARKDOWN_FILE, async (_event, filePath: unknown, content: unknown) => {
    if (typeof filePath !== 'string' || filePath.trim() === '') {
      return tr({
        ok: false,
        code: 'INVALID_ARGUMENT',
        message: '文件路径无效。'
      });
    }
    if (typeof content !== 'string') {
      return tr({
        ok: false,
        code: 'INVALID_ARGUMENT',
        message: '保存内容无效。'
      });
    }
    if (!isMarkdownPath(filePath)) {
      return tr({
        ok: false,
        code: 'UNSUPPORTED_FILE_TYPE',
        message: '只能保存 .md 或 .markdown 文件。'
      });
    }

    const normPath = normalizePath(filePath);
    const isOpened = authorizedFiles.has(normPath);
    const isAuth = await isFileAuthorized(filePath);
    const exists = existsSync(filePath);

    if (!isAuth || !(isOpened || exists)) {
      return tr({
        ok: false,
        code: 'SAVE_FAILED',
        message: '保存失败，请检查权限或文件状态。'
      });
    }

    const result = await saveMarkdownFile(filePath, content);
    if (result.ok) {
      hasUnsavedChanges = false;
      await recordRecentSafely(recentStore, 'file', result.document.path);
    }
    return tr(result);
  });

  ipcMain.handle(IPC_CHANNELS.OPEN_DEFAULT_EDITOR, async (_event, filePath: unknown) => {
    if (typeof filePath !== 'string' || filePath.trim() === '') {
      return tr({
        ok: false,
        code: 'INVALID_ARGUMENT',
        message: '文件路径无效。'
      });
    }
    if (!isMarkdownPath(filePath)) {
      return tr({
        ok: false,
        code: 'UNSUPPORTED_FILE_TYPE',
        message: '只能打开 .md 或 .markdown 文件。'
      });
    }
    if (!(await isFileAuthorized(filePath))) {
      return tr({
        ok: false,
        code: 'OPEN_FAILED',
        message: '无法用默认编辑器打开文件。'
      });
    }
    return tr(await openDefaultEditor(filePath, (pathToOpen) => shell.openPath(pathToOpen)));
  });

  ipcMain.handle(IPC_CHANNELS.EXPORT_TO_PDF, async () => {
    const targetWindow = BrowserWindow.getFocusedWindow() ?? window;
    const result = await exportWindowToPdf(targetWindow, {
      showSaveDialog: (dialogWindow, options) =>
        dialog.showSaveDialog(dialogWindow as BrowserWindow, options),
      writeFile
    });
    return tr(result);
  });

  ipcMain.handle(IPC_CHANNELS.SET_UNSAVED_CHANGES, (_event, value: unknown) => {
    hasUnsavedChanges = value === true;
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.CONFIRM_DISCARD_CHANGES, async () => {
    const dlg = unsavedDialogs[currentLang];
    const result = await dialog.showMessageBox(window, {
      type: 'warning',
      buttons: dlg.buttons,
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      message: dlg.message
    });

    if (result.response === 1) {
      hasUnsavedChanges = false;
      return { action: 'discard' };
    }

    return { action: 'cancel' };
  });

  ipcMain.handle(IPC_CHANNELS.GET_SECURITY_DIAGNOSTICS, () => {
    return createSecurityDiagnostics();
  });

  ipcMain.handle(IPC_CHANNELS.SET_LANGUAGE, (_event, lang: unknown) => {
    if (typeof lang === 'string' && (lang === 'zh' || lang === 'en')) {
      currentLang = lang;
      menuManager?.setLanguage(lang);
    }
  });

  ipcMain.handle(IPC_CHANNELS.REMOVE_RECENT_ITEM, async (_event, filePath: unknown, type: unknown) => {
    if (typeof filePath !== 'string' || (type !== 'file' && type !== 'folder')) {
      return { ok: false, code: 'INVALID_ARGUMENT', message: '参数无效。' };
    }
    try {
      await recentStore.remove({ type, path: filePath });
      const norm = normalizePath(filePath);
      if (type === 'file') {
        authorizedFiles.delete(norm);
      } else if (type === 'folder') {
        authorizedDirs.delete(norm);
      }
      return { ok: true };
    } catch {
      return { ok: false, code: 'REMOVE_FAILED', message: '无法移除最近打开记录。' };
    }
  });
}
