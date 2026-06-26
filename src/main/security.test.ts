import { afterEach, describe, expect, test, vi } from 'vitest';

import { SECURE_WEB_PREFERENCES, createSecurityDiagnostics, resolveTrustedRendererUrl } from './security';

describe('Electron security defaults', () => {
  test('renderer runs isolated, sandboxed, and without Node integration', () => {
    expect(SECURE_WEB_PREFERENCES.contextIsolation).toBe(true);
    expect(SECURE_WEB_PREFERENCES.nodeIntegration).toBe(false);
    expect(SECURE_WEB_PREFERENCES.sandbox).toBe(true);
    expect(SECURE_WEB_PREFERENCES.webSecurity).toBe(true);
    expect(SECURE_WEB_PREFERENCES.webviewTag).toBe(false);
  });

  test('diagnostics report the same security boundary exposed to renderer', () => {
    expect(createSecurityDiagnostics()).toEqual({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      allowedIpcChannels: [
        'dialog:openMarkdownFile',
        'document:openMarkdownByPath',
        'document:openRequested',
        'document:resolveMarkdownImage',
        'document:openMarkdownLink',
        'dialog:openWorkspaceFolder',
        'workspace:openByPath',
        'recent:list',
        'document:saveMarkdownFile',
        'document:openDefaultEditor',
        'editor:setUnsavedChanges',
        'editor:confirmDiscardChanges',
        'menu-action',
        'export-to-pdf',
        'app:getSecurityDiagnostics',
        'app:setLanguage',
        'recent:removeItem'
      ]
    });
  });

  test('ignores renderer URL overrides in packaged builds', () => {
    expect(resolveTrustedRendererUrl('http://localhost:5173', true)).toBeNull();
  });

  test('allows only loopback renderer URLs in development builds', () => {
    expect(resolveTrustedRendererUrl('http://localhost:5173', false)).toBe('http://localhost:5173/');
    expect(resolveTrustedRendererUrl('http://127.0.0.1:5173', false)).toBe('http://127.0.0.1:5173/');
    expect(resolveTrustedRendererUrl('http://[::1]:5173', false)).toBe('http://[::1]:5173/');
    expect(resolveTrustedRendererUrl('https://example.com/app', false)).toBeNull();
    expect(resolveTrustedRendererUrl('file:///C:/tmp/renderer.html', false)).toBeNull();
  });
});

import { isDangerousSystemDirectory, getSafeUserDirectories, normalizePath } from './pathPolicy';

describe('Path and Directory Security policy', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('correctly detects dangerous system folders', () => {
    expect(isDangerousSystemDirectory('C:/Windows/system32/cmd.exe')).toBe(true);
    expect(isDangerousSystemDirectory('/etc/passwd')).toBe(true);
    expect(isDangerousSystemDirectory('C:/Users/User/AppData/Local/Temp')).toBe(true);
    expect(isDangerousSystemDirectory('/var/log/syslog')).toBe(true);
    expect(isDangerousSystemDirectory('D:/Projects/App/notes.md')).toBe(false);
  });

  test('detects Windows system folders from configured environment roots', () => {
    vi.stubEnv('SystemRoot', 'D:\\Windows');
    vi.stubEnv('ProgramFiles', 'D:\\Program Files');
    vi.stubEnv('ProgramFiles(x86)', 'D:\\Program Files (x86)');
    vi.stubEnv('ProgramW6432', 'D:\\Program Files');

    expect(isDangerousSystemDirectory('D:/Windows/System32/cmd.exe')).toBe(true);
    expect(isDangerousSystemDirectory('D:/Program Files/App/app.exe')).toBe(true);
    expect(isDangerousSystemDirectory('D:/Program Files (x86)/App/app.exe')).toBe(true);
    expect(isDangerousSystemDirectory('E:/Projects/App/notes.md')).toBe(false);
  });

  test('retrieves user directories and normalizes path based on OS', () => {
    const safeDirs = getSafeUserDirectories();
    expect(safeDirs.length).toBeGreaterThan(0);

    const testPath = 'C:/Temp/Docs/MyDoc.MD';
    const normalized = normalizePath(testPath);
    if (process.platform === 'win32') {
      expect(normalized).toBe('c:/temp/docs/mydoc.md');
    } else {
      expect(normalized).toBe('C:/Temp/Docs/MyDoc.MD');
    }
  });
});
