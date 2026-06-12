import { join } from 'node:path';

export function getPreloadPath(mainOutputDir: string): string {
  return join(mainOutputDir, '../preload/index.cjs');
}

export function getRendererIndexPath(mainOutputDir: string): string {
  return join(mainOutputDir, '../renderer/index.html');
}
