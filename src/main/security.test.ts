import { describe, expect, test } from 'vitest';

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
        'app:setLanguage'
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
