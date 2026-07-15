/**
 * Sync existing build/icon assets into src-tauri/icons for Tauri bundling.
 * SVG→PNG regeneration previously used Playwright; icons are checked in under build/.
 */
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const root = join(sourceDirectory, '..');
const iconsDir = join(root, 'src-tauri', 'icons');

await mkdir(iconsDir, { recursive: true });

const png = join(sourceDirectory, 'icon.png');
const ico = join(sourceDirectory, 'icon.ico');

await copyFile(png, join(iconsDir, 'icon.png'));
await copyFile(png, join(iconsDir, '32x32.png'));
await copyFile(png, join(iconsDir, '128x128.png'));
await copyFile(png, join(iconsDir, 'henry.w@example.net'));
await copyFile(ico, join(iconsDir, 'icon.ico'));

console.log('Synced icons to src-tauri/icons');
