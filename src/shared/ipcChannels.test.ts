import { describe, expect, test } from 'vitest';

import { IPC_CHANNELS } from './ipcChannels';

describe('IPC channel whitelist', () => {
  test('exposes only the approved document and diagnostics channels', () => {
    expect(IPC_CHANNELS).toEqual({
      OPEN_MARKDOWN_DIALOG: 'dialog:openMarkdownFile',
      OPEN_MARKDOWN_BY_PATH: 'document:openMarkdownByPath',
      MARKDOWN_OPEN_REQUESTED: 'document:openRequested',
      RESOLVE_MARKDOWN_IMAGE: 'document:resolveMarkdownImage',
      OPEN_MARKDOWN_LINK: 'document:openMarkdownLink',
      OPEN_WORKSPACE_DIALOG: 'dialog:openWorkspaceFolder',
      OPEN_WORKSPACE_BY_PATH: 'workspace:openByPath',
      GET_RECENT_ITEMS: 'recent:list',
      SAVE_MARKDOWN_FILE: 'document:saveMarkdownFile',
      OPEN_DEFAULT_EDITOR: 'document:openDefaultEditor',
      SET_UNSAVED_CHANGES: 'editor:setUnsavedChanges',
      CONFIRM_DISCARD_CHANGES: 'editor:confirmDiscardChanges',
      MENU_ACTION: 'menu-action',
      EXPORT_TO_PDF: 'export-to-pdf',
      GET_SECURITY_DIAGNOSTICS: 'app:getSecurityDiagnostics',
      SET_LANGUAGE: 'app:setLanguage'
    });
  });
});
