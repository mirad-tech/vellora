import { dirname, isAbsolute, relative, resolve } from 'node:path';

const isWindows = process.platform === 'win32';

export type LocalResourceAccessOptions = {
  allowedDirectories?: readonly string[];
};

export function normalizePath(filePath: string): string {
  const resolved = resolve(filePath).replace(/\\/g, '/');
  return isWindows ? resolved.toLowerCase() : resolved;
}

export function getSafeUserDirectories(): string[] {
  const paths: string[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron');
    if (app) {
      paths.push(app.getPath('home'));
      paths.push(app.getPath('documents'));
      paths.push(app.getPath('desktop'));
    }
  } catch {
    // ignore and fallback
  }

  if (paths.length === 0) {
    const home = process.env.USERPROFILE || process.env.HOME;
    if (home) {
      paths.push(home);
      paths.push(resolve(home, 'Documents'));
      paths.push(resolve(home, 'Desktop'));
    }
  }

  return Array.from(new Set(paths.map(p => normalizePath(p))));
}

function getWindowsDangerousDirectories(): string[] {
  const dirs = [
    process.env.SystemRoot,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.ProgramW6432,
    'C:/Windows',
    'C:/Program Files',
    'C:/Program Files (x86)'
  ].filter((dir): dir is string => Boolean(dir));

  return Array.from(new Set(dirs.map(dir => normalizePath(dir))));
}

export function isDangerousSystemDirectory(filePath: string): boolean {
  const normPath = normalizePath(filePath);

  const winDangerousDirs = getWindowsDangerousDirectories();

  const unixDangerousDirs = [
    '/etc',
    '/var',
    '/bin',
    '/sbin',
    '/usr/bin',
    '/usr/sbin',
    '/proc',
    '/sys',
    '/dev',
    '/root'
  ];

  for (const dir of winDangerousDirs) {
    if (normPath === dir || isPathInsideDirectory(normPath, dir)) {
      return true;
    }
  }

  for (const dir of unixDangerousDirs) {
    if (normPath === dir || isPathInsideDirectory(normPath, dir)) {
      return true;
    }
  }

  if (normPath.includes('/appdata/local') || normPath.includes('/appdata/roaming')) {
    return true;
  }

  return false;
}

export function isPathInsideDirectory(childPath: string, parentDir: string): boolean {
  const normalizedChild = normalizePath(childPath);
  const normalizedParent = normalizePath(parentDir);

  if (normalizedChild === normalizedParent) {
    return true;
  }

  const relativePath = relative(normalizedParent, normalizedChild);
  return !relativePath.startsWith('..') && !isAbsolute(relativePath);
}

export function isPathAllowedForDocumentResource(
  documentPath: string,
  targetPath: string,
  allowedDirectories: readonly string[] = []
): boolean {
  const documentDirectory = dirname(resolve(documentPath));
  if (isPathInsideDirectory(targetPath, documentDirectory)) {
    return true;
  }

  return allowedDirectories.some(
    (directory) => isPathInsideDirectory(documentPath, directory) && isPathInsideDirectory(targetPath, directory)
  );
}

export function resolveDocumentRelativePath(
  documentPath: string,
  relativePath: string,
  allowedDirectories: readonly string[] = []
): string | null {
  const targetPath = resolve(dirname(resolve(documentPath)), relativePath);
  if (!isPathAllowedForDocumentResource(documentPath, targetPath, allowedDirectories)) {
    return null;
  }
  return targetPath;
}
