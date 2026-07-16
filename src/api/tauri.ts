import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';

import type {
  EmptyResult,
  ImageResolutionResult,
  MarkdownLinkInspectResult,
  MarkdownOpenResult,
  MarkdownSaveResult
} from '../types';

export async function chooseMarkdownFile(): Promise<MarkdownOpenResult> {
  return invoke<MarkdownOpenResult>('choose_markdown_file');
}

export async function openMarkdownFile(path: string): Promise<MarkdownOpenResult> {
  return invoke<MarkdownOpenResult>('open_markdown_file', { path });
}

export async function saveMarkdownFile(
  path: string,
  content: string
): Promise<MarkdownSaveResult> {
  return invoke<MarkdownSaveResult>('save_markdown_file', { path, content });
}

export async function resolveLocalImage(
  documentPath: string,
  src: string
): Promise<ImageResolutionResult> {
  return invoke<ImageResolutionResult>('resolve_local_image', {
    documentPath,
    src
  });
}

export async function inspectMarkdownLink(
  documentPath: string,
  href: string
): Promise<MarkdownLinkInspectResult> {
  return invoke<MarkdownLinkInspectResult>('inspect_markdown_link', {
    documentPath,
    href
  });
}

/** Open a local Markdown link after the user has confirmed discard of unsaved edits. */
export async function openMarkdownLink(
  documentPath: string,
  href: string
): Promise<MarkdownOpenResult> {
  return invoke<MarkdownOpenResult>('open_markdown_link', {
    documentPath,
    href
  });
}

export async function openExternalUrl(url: string): Promise<EmptyResult> {
  return invoke<EmptyResult>('open_external_url', { url });
}

export async function getInitialDocument(): Promise<MarkdownOpenResult> {
  return invoke<MarkdownOpenResult>('get_initial_document');
}

export async function setUnsavedChanges(value: boolean): Promise<EmptyResult> {
  return invoke<EmptyResult>('set_unsaved_changes', { value });
}

export async function confirmClose(allow: boolean): Promise<EmptyResult> {
  return invoke<EmptyResult>('confirm_close', { allow });
}

export async function onOpenFilePath(
  handler: (path: string) => void
): Promise<UnlistenFn> {
  return listen<string>('open-file-path', (event) => {
    handler(event.payload);
  });
}

export async function onCloseRequested(handler: () => void): Promise<UnlistenFn> {
  return listen('close-requested', () => {
    handler();
  });
}

export async function onDragDropPaths(
  handler: (paths: string[]) => void
): Promise<UnlistenFn> {
  const webview = getCurrentWebview();
  return webview.onDragDropEvent((event) => {
    if (event.payload.type === 'drop') {
      handler(event.payload.paths);
    }
  });
}
