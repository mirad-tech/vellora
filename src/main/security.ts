import type { BrowserWindowConstructorOptions } from 'electron';

import { ALLOWED_IPC_CHANNELS } from '../shared/ipcChannels';
import type { SecurityDiagnostics } from '../shared/documentTypes';

export const SECURE_WEB_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  webviewTag: false,
  allowRunningInsecureContent: false
} satisfies NonNullable<BrowserWindowConstructorOptions['webPreferences']>;

export function createSecurityDiagnostics(): SecurityDiagnostics {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
    allowedIpcChannels: [...ALLOWED_IPC_CHANNELS]
  };
}

export function createWebPreferences(
  preloadPath: string
): NonNullable<BrowserWindowConstructorOptions['webPreferences']> {
  return {
    ...SECURE_WEB_PREFERENCES,
    preload: preloadPath
  };
}
