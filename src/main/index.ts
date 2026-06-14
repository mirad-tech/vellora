import { app, BrowserWindow, Menu, session } from 'electron';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerIpcHandlers } from './ipc';
import { findMarkdownPathInArgs } from './launchArguments';
import { installNativeApplicationMenu } from './nativeMenu';
import { getPreloadPath, getRendererIndexPath } from './paths';
import { createWebPreferences, resolveTrustedRendererUrl } from './security';
import { IPC_CHANNELS } from '../shared/ipcChannels';

const currentFile = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFile);

let mainWindow: BrowserWindow | null = null;
let pendingLaunchMarkdownPath = findMarkdownPathInArgs(process.argv);

const userDataOverride = process.env.MD_VIEWER_USER_DATA_DIR;
if (userDataOverride) {
  mkdirSync(userDataOverride, { recursive: true });
  app.setPath('userData', userDataOverride);
}

function getWindowIconPath(): string | undefined {
  if (app.isPackaged || process.platform !== 'win32') return undefined;
  return join(currentDir, '../../build/icon.ico');
}

function configureAppSecurity(window: BrowserWindow): void {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) {
      event.preventDefault();
    }
  });
}

function sendMarkdownOpenRequest(filePath: string): void {
  if (!mainWindow || mainWindow.webContents.isDestroyed()) {
    pendingLaunchMarkdownPath = filePath;
    return;
  }

  mainWindow.webContents.send(IPC_CHANNELS.MARKDOWN_OPEN_REQUESTED, filePath);
}

function flushPendingMarkdownOpenRequest(): void {
  if (!pendingLaunchMarkdownPath) return;
  const filePath = pendingLaunchMarkdownPath;
  pendingLaunchMarkdownPath = null;
  sendMarkdownOpenRequest(filePath);
}

async function createMainWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 480,
    minHeight: 520,
    icon: getWindowIconPath(),
    show: false,
    webPreferences: createWebPreferences(getPreloadPath(currentDir))
  });

  registerIpcHandlers(mainWindow);
  installNativeApplicationMenu(mainWindow, Menu);
  configureAppSecurity(mainWindow);

  mainWindow.webContents.once('did-finish-load', () => {
    flushPendingMarkdownOpenRequest();
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  const trustedRendererUrl = resolveTrustedRendererUrl(process.env.ELECTRON_RENDERER_URL, app.isPackaged);
  if (trustedRendererUrl) {
    await mainWindow.loadURL(trustedRendererUrl);
  } else {
    await mainWindow.loadFile(getRendererIndexPath(currentDir));
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const filePath = findMarkdownPathInArgs(argv);

    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }

    if (filePath) {
      sendMarkdownOpenRequest(filePath);
    }
  });

  app.whenReady().then(async () => {
    await createMainWindow();

    app.on('activate', async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        await createMainWindow();
      }
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
