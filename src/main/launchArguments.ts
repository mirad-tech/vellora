import { isMarkdownPath } from './fileAccess';

export function findMarkdownPathInArgs(args: string[]): string | null {
  for (const arg of args) {
    if (!arg || arg.startsWith('-')) continue;
    if (isMarkdownPath(arg)) return arg;
  }

  return null;
}
