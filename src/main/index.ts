import { app, BrowserWindow, Menu, screen, session } from 'electron';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { authorizeMarkdownOpenRequest, registerIpcHandlers } from './ipc';
import { findMarkdownPathInArgs } from './launchArguments';
import { createMenuManager } from './nativeMenu';
import { getPreloadPath, getRendererIndexPath } from './paths';
import { createWebPreferences, resolveTrustedRendererUrl } from './security';
import { IPC_CHANNELS } from '../shared/ipcChannels';

const currentFile = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFile);

const DEFAULT_WINDOW_WIDTH = 880;
const DEFAULT_WINDOW_HEIGHT = 980;
const MIN_WINDOW_WIDTH = 480;
const MIN_WINDOW_HEIGHT = 520;
const WINDOW_WORK_AREA_MARGIN = 24;

let mainWindow: BrowserWindow | null = null;
let pendingLaunchMarkdownPath = findMarkdownPathInArgs(process.argv);
const menuManager = createMenuManager<Electron.Menu>({ isDev: !app.isPackaged });

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
  if (!authorizeMarkdownOpenRequest(filePath)) return;

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

function getInitialWindowSize(): { width: number; height: number } {
  const { workAreaSize } = screen.getPrimaryDisplay();
  return {
    width: Math.max(MIN_WINDOW_WIDTH, Math.min(DEFAULT_WINDOW_WIDTH, workAreaSize.width - WINDOW_WORK_AREA_MARGIN)),
    height: Math.max(MIN_WINDOW_HEIGHT, Math.min(DEFAULT_WINDOW_HEIGHT, workAreaSize.height - WINDOW_WORK_AREA_MARGIN))
  };
}

async function createMainWindow(): Promise<void> {
  const initialWindowSize = getInitialWindowSize();

  mainWindow = new BrowserWindow({
    width: initialWindowSize.width,
    height: initialWindowSize.height,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    icon: getWindowIconPath(),
    show: false,
    webPreferences: createWebPreferences(getPreloadPath(currentDir))
  });

  registerIpcHandlers(mainWindow, menuManager);
  menuManager.install(mainWindow, {
    buildFromTemplate: (template) => Menu.buildFromTemplate(template),
    setApplicationMenu: (menu) => Menu.setApplicationMenu(menu)
  });
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
