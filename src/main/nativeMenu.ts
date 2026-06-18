import type { BrowserWindow, MenuItemConstructorOptions } from 'electron';

import { IPC_CHANNELS } from '../shared/ipcChannels';

export type NativeMenuAction =
  | 'open-file'
  | 'open-folder'
  | 'save-document'
  | 'export-pdf'
  | 'open-default-editor'
  | 'close-document'
  | 'focus-search'
  | 'open-command-palette'
  | 'toggle-sidebar'
  | 'toggle-source-edit'
  | 'toggle-theme'
  | 'show-file-info'
  | 'open-settings'
  | 'show-recent';

export type NativeMenuApi<TMenu = unknown> = {
  buildFromTemplate: (template: MenuItemConstructorOptions[]) => TMenu;
  setApplicationMenu: (menu: TMenu) => void;
};

type MenuLabels = {
  file: string;
  openFile: string;
  openFolder: string;
  save: string;
  exportPdf: string;
  openDefaultEditor: string;
  closeDocument: string;
  edit: string;
  find: string;
  commandPalette: string;
  view: string;
  toggleSidebar: string;
  sourceEdit: string;
  toggleTheme: string;
  fileInfo: string;
  recentFiles: string;
  settings: string;
  window: string;
};

const labels: Record<'zh' | 'en', MenuLabels> = {
  zh: {
    file: '文件(&F)',
    openFile: '打开文件',
    openFolder: '打开文件夹',
    save: '保存',
    exportPdf: '导出为 PDF',
    openDefaultEditor: '用默认编辑器打开',
    closeDocument: '关闭文档',
    edit: '编辑(&E)',
    find: '查找',
    commandPalette: '命令面板',
    view: '查看(&V)',
    toggleSidebar: '切换侧边栏',
    sourceEdit: '源码编辑',
    toggleTheme: '切换主题',
    fileInfo: '文件信息',
    recentFiles: '最近文件',
    settings: '设置',
    window: '窗口(&W)'
  },
  en: {
    file: '&File',
    openFile: 'Open File',
    openFolder: 'Open Folder',
    save: 'Save',
    exportPdf: 'Export as PDF',
    openDefaultEditor: 'Open in Default Editor',
    closeDocument: 'Close Document',
    edit: '&Edit',
    find: 'Find',
    commandPalette: 'Command Palette',
    view: '&View',
    toggleSidebar: 'Toggle Sidebar',
    sourceEdit: 'Source Edit',
    toggleTheme: 'Toggle Theme',
    fileInfo: 'File Info',
    recentFiles: 'Recent Files',
    settings: 'Settings',
    window: '&Window'
  }
};

function send(sendAction: (action: NativeMenuAction) => void, action: NativeMenuAction) {
  return () => sendAction(action);
}

export type NativeMenuOptions = {
  isDev?: boolean;
};

export function createNativeMenuTemplate(
  sendAction: (action: NativeMenuAction) => void,
  lang: 'zh' | 'en' = 'en',
  options: NativeMenuOptions = {}
): MenuItemConstructorOptions[] {
  const lb = labels[lang];
  const { isDev = false } = options;

  return [
    {
      label: lb.file,
      submenu: [
        {
          label: lb.openFile,
          accelerator: 'CommandOrControl+O',
          click: send(sendAction, 'open-file')
        },
        {
          label: lb.openFolder,
          accelerator: 'CommandOrControl+Shift+O',
          click: send(sendAction, 'open-folder')
        },
        { type: 'separator' },
        {
          label: lb.save,
          accelerator: 'CommandOrControl+S',
          click: send(sendAction, 'save-document')
        },
        {
          label: lb.exportPdf,
          accelerator: 'CommandOrControl+Shift+P',
          click: send(sendAction, 'export-pdf')
        },
        {
          label: lb.openDefaultEditor,
          accelerator: 'CommandOrControl+Shift+E',
          click: send(sendAction, 'open-default-editor')
        },
        { type: 'separator' },
        {
          label: lb.closeDocument,
          accelerator: 'CommandOrControl+W',
          click: send(sendAction, 'close-document')
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: lb.edit,
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        {
          label: lb.find,
          accelerator: 'CommandOrControl+F',
          click: send(sendAction, 'focus-search')
        },
        {
          label: lb.commandPalette,
          accelerator: 'CommandOrControl+K',
          click: send(sendAction, 'open-command-palette')
        }
      ]
    },
    {
      label: lb.view,
      submenu: [
        {
          label: lb.toggleSidebar,
          accelerator: 'CommandOrControl+B',
          click: send(sendAction, 'toggle-sidebar')
        },
        {
          label: lb.sourceEdit,
          accelerator: 'CommandOrControl+E',
          click: send(sendAction, 'toggle-source-edit')
        },
        {
          label: lb.toggleTheme,
          accelerator: 'CommandOrControl+D',
          click: send(sendAction, 'toggle-theme')
        },
        { type: 'separator' },
        {
          label: lb.fileInfo,
          accelerator: 'CommandOrControl+I',
          click: send(sendAction, 'show-file-info')
        },
        {
          label: lb.recentFiles,
          click: send(sendAction, 'show-recent')
        },
        {
          label: lb.settings,
          accelerator: 'CommandOrControl+,',
          click: send(sendAction, 'open-settings')
        },
        { type: 'separator' },
        ...(isDev ? [
          { role: 'reload' as const },
          { role: 'forceReload' as const },
          { role: 'toggleDevTools' as const },
          { type: 'separator' as const },
        ] : []),
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: lb.window,
      submenu: [{ role: 'minimize' }, { role: 'close' }]
    }
  ];
}

export type MenuManager<TMenu = unknown> = {
  install: (window: BrowserWindow, menuApi: NativeMenuApi<TMenu>) => void;
  setLanguage: (lang: 'zh' | 'en') => void;
};

export function createMenuManager<TMenu>(options: NativeMenuOptions = {}): MenuManager<TMenu> {
  let currentWindow: BrowserWindow | null = null;
  let currentMenuApi: NativeMenuApi<TMenu> | null = null;
  let currentLang: 'zh' | 'en' = 'en';

  function rebuild(): void {
    if (!currentWindow || !currentMenuApi) return;
    const win = currentWindow;

    const template = createNativeMenuTemplate((action) => {
      if (!win.webContents.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.MENU_ACTION, action);
      }
    }, currentLang, options);

    const menu = currentMenuApi.buildFromTemplate(template);
    currentMenuApi.setApplicationMenu(menu);
  }

  return {
    install(window, menuApi) {
      currentWindow = window;
      currentMenuApi = menuApi;
      rebuild();
    },
    setLanguage(lang) {
      if (currentLang === lang) return;
      currentLang = lang;
      rebuild();
    }
  };
}
