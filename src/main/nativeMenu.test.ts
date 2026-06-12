import { describe, expect, test, vi } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';

import { createNativeMenuTemplate, installNativeApplicationMenu } from './nativeMenu';

function normalizeLabel(label: string | undefined): string {
  return (label ?? '').replaceAll('&', '');
}

function findTopLevelMenu(
  template: MenuItemConstructorOptions[],
  label: string
): MenuItemConstructorOptions {
  const item = template.find((entry) => normalizeLabel(entry.label) === label);
  if (!item) throw new Error(`Missing top-level menu: ${label}`);
  return item;
}

function findSubmenuItem(
  template: MenuItemConstructorOptions[],
  topLevelLabel: string,
  itemLabel: string
): MenuItemConstructorOptions {
  const topLevel = findTopLevelMenu(template, topLevelLabel);
  const submenu = Array.isArray(topLevel.submenu) ? topLevel.submenu : [];
  const item = submenu.find((entry) => normalizeLabel(entry.label) === itemLabel);
  if (!item || typeof item === 'string') {
    throw new Error(`Missing submenu item: ${topLevelLabel} -> ${itemLabel}`);
  }
  return item;
}

describe('native application menu template', () => {
  test('matches the Typora-like top-level menu organization', () => {
    const template = createNativeMenuTemplate(vi.fn());

    expect(template.map((item) => normalizeLabel(item.label))).toEqual([
      'File',
      'Edit',
      'View',
      'Window'
    ]);
  });

  test('sends renderer menu actions for Markdown document commands', () => {
    const sentActions: string[] = [];
    const template = createNativeMenuTemplate((action) => sentActions.push(action));

    findSubmenuItem(template, 'File', 'Open File').click?.({} as never, {} as never, {} as never);
    findSubmenuItem(template, 'File', 'Save').click?.({} as never, {} as never, {} as never);
    findSubmenuItem(template, 'File', 'Export as PDF').click?.({} as never, {} as never, {} as never);
    findSubmenuItem(template, 'View', 'Toggle Sidebar').click?.({} as never, {} as never, {} as never);
    findSubmenuItem(template, 'View', 'Source Edit').click?.({} as never, {} as never, {} as never);

    expect(sentActions).toEqual([
      'open-file',
      'save-document',
      'export-pdf',
      'toggle-sidebar',
      'toggle-source-edit'
    ]);
  });

  test('uses native accelerators for high-frequency menu commands', () => {
    const template = createNativeMenuTemplate(vi.fn());

    expect(findSubmenuItem(template, 'File', 'Open File').accelerator).toBe('CommandOrControl+O');
    expect(findSubmenuItem(template, 'File', 'Open Folder').accelerator).toBe(
      'CommandOrControl+Shift+O'
    );
    expect(findSubmenuItem(template, 'File', 'Save').accelerator).toBe('CommandOrControl+S');
    expect(findSubmenuItem(template, 'File', 'Export as PDF').accelerator).toBe(
      'CommandOrControl+Shift+P'
    );
  });

  test('installs the built template through the supplied Electron Menu API', () => {
    const menu = { id: 'menu' };
    const menuApi = {
      buildFromTemplate: vi.fn(() => menu),
      setApplicationMenu: vi.fn()
    };

    installNativeApplicationMenu({} as never, menuApi);

    expect(menuApi.buildFromTemplate).toHaveBeenCalledWith(expect.any(Array));
    expect(menuApi.setApplicationMenu).toHaveBeenCalledWith(menu);
  });
});
