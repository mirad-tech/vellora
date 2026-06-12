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

function send(sendAction: (action: NativeMenuAction) => void, action: NativeMenuAction) {
  return () => sendAction(action);
}

export function createNativeMenuTemplate(
  sendAction: (action: NativeMenuAction) => void
): MenuItemConstructorOptions[] {
  return [
    {
      label: '&File',
      submenu: [
        {
          label: 'Open File',
          accelerator: 'CommandOrControl+O',
          click: send(sendAction, 'open-file')
        },
        {
          label: 'Open Folder',
          accelerator: 'CommandOrControl+Shift+O',
          click: send(sendAction, 'open-folder')
        },
        { type: 'separator' },
        {
          label: 'Save',
          accelerator: 'CommandOrControl+S',
          click: send(sendAction, 'save-document')
        },
        {
          label: 'Export as PDF',
          accelerator: 'CommandOrControl+Shift+P',
          click: send(sendAction, 'export-pdf')
        },
        {
          label: 'Open in Default Editor',
          accelerator: 'CommandOrControl+Shift+E',
          click: send(sendAction, 'open-default-editor')
        },
        { type: 'separator' },
        {
          label: 'Close Document',
          accelerator: 'CommandOrControl+W',
          click: send(sendAction, 'close-document')
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: '&Edit',
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
          label: 'Find',
          accelerator: 'CommandOrControl+F',
          click: send(sendAction, 'focus-search')
        },
        {
          label: 'Command Palette',
          accelerator: 'CommandOrControl+K',
          click: send(sendAction, 'open-command-palette')
        }
      ]
    },
    {
      label: '&View',
      submenu: [
        {
          label: 'Toggle Sidebar',
          accelerator: 'CommandOrControl+B',
          click: send(sendAction, 'toggle-sidebar')
        },
        {
          label: 'Source Edit',
          accelerator: 'CommandOrControl+E',
          click: send(sendAction, 'toggle-source-edit')
        },
        {
          label: 'Toggle Theme',
          accelerator: 'CommandOrControl+D',
          click: send(sendAction, 'toggle-theme')
        },
        { type: 'separator' },
        {
          label: 'File Info',
          accelerator: 'CommandOrControl+I',
          click: send(sendAction, 'show-file-info')
        },
        {
          label: 'Recent Files',
          click: send(sendAction, 'show-recent')
        },
        {
          label: 'Settings',
          accelerator: 'CommandOrControl+,',
          click: send(sendAction, 'open-settings')
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: '&Window',
      submenu: [{ role: 'minimize' }, { role: 'close' }]
    }
  ];
}

export function installNativeApplicationMenu<TMenu>(
  window: BrowserWindow,
  menuApi: NativeMenuApi<TMenu>
): void {
  const template = createNativeMenuTemplate((action) => {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.MENU_ACTION, action);
    }
  });

  const menu = menuApi.buildFromTemplate(template);
  menuApi.setApplicationMenu(menu);
}
