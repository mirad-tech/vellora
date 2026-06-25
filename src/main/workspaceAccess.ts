import { readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';

import { isMarkdownPath } from './fileAccess';
import type { MarkdownWorkspace, WorkspaceOpenResult, WorkspaceTreeNode } from '../shared/documentTypes';

export type WorkspaceOpenOptions = {
  maxMarkdownFiles?: number;
};

const DEFAULT_MAX_MARKDOWN_FILES = 800;

type WalkState = {
  fileCount: number;
  truncated: boolean;
  limit: number;
};

function relativeDisplayPath(rootPath: string, childPath: string): string {
  return relative(rootPath, childPath).split(sep).join('/');
}

function sortDirectoryEntries(entries: Dirent<string>[]): Dirent<string>[] {
  return entries.sort((left, right) => {
    const leftDirectory = left.isDirectory() ? 0 : 1;
    const rightDirectory = right.isDirectory() ? 0 : 1;
    if (leftDirectory !== rightDirectory) return leftDirectory - rightDirectory;
    return left.name.localeCompare(right.name, 'zh-CN', { numeric: true });
  });
}

const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '.vscode',
  '.idea',
  'dist',
  'build',
  'out',
  'release',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.github'
]);

async function walkMarkdownTree(rootPath: string, currentPath: string, state: WalkState): Promise<WorkspaceTreeNode[]> {
  if (state.fileCount >= state.limit) {
    state.truncated = true;
    return [];
  }

  const entries = sortDirectoryEntries(await readdir(currentPath, { withFileTypes: true }));
  const nodes: WorkspaceTreeNode[] = [];

  for (const entry of entries) {
    if (state.fileCount >= state.limit) {
      state.truncated = true;
      break;
    }

    const entryPath = join(currentPath, entry.name);

    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const children = await walkMarkdownTree(rootPath, entryPath, state);

      if (children.length > 0) {
        nodes.push({
          type: 'directory',
          name: entry.name,
          path: entryPath,
          relativePath: relativeDisplayPath(rootPath, entryPath),
          children
        });
      }
      continue;
    }

    if (entry.isFile() && isMarkdownPath(entryPath)) {
      state.fileCount += 1;
      nodes.push({
        type: 'file',
        name: entry.name,
        path: entryPath,
        relativePath: relativeDisplayPath(rootPath, entryPath)
      });
    }
  }

  return nodes;
}

export async function openMarkdownWorkspace(
  folderPath: unknown,
  options: WorkspaceOpenOptions = {}
): Promise<WorkspaceOpenResult> {
  if (typeof folderPath !== 'string' || folderPath.trim() === '') {
    return {
      ok: false,
      code: 'INVALID_ARGUMENT',
      message: '文件夹路径无效。'
    };
  }

  const resolvedPath = resolve(folderPath);
  const limit = Math.max(1, Math.floor(options.maxMarkdownFiles ?? DEFAULT_MAX_MARKDOWN_FILES));

  try {
    const info = await stat(resolvedPath);
    if (!info.isDirectory()) {
      return {
        ok: false,
        code: 'NOT_A_DIRECTORY',
        message: '选择的路径不是文件夹。'
      };
    }

    const state: WalkState = {
      fileCount: 0,
      truncated: false,
      limit
    };
    const children = await walkMarkdownTree(resolvedPath, resolvedPath, state);

    const workspace: MarkdownWorkspace = {
      path: resolvedPath,
      name: basename(resolvedPath),
      children,
      fileCount: state.fileCount,
      truncated: state.truncated,
      limit
    };

    return {
      ok: true,
      workspace
    };
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;

    if (code === 'ENOENT') {
      return {
        ok: false,
        code: 'NOT_FOUND',
        message: '文件夹不存在或已被移动。'
      };
    }

    return {
      ok: false,
      code: 'READ_FAILED',
      message: '无法读取文件夹，请检查权限或文件状态。'
    };
  }
}
