/** Generate the complete Tauri icon set from the checked-in transparent source. */
import { spawn } from 'node:child_process';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const root = join(sourceDirectory, '..');
const iconsDir = join(root, 'src-tauri', 'icons');
const source = join(sourceDirectory, 'icon-source.png');
const tauriCli = join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const generatedDir = join(sourceDirectory, '.generated-icons');

await mkdir(iconsDir, { recursive: true });
await rm(generatedDir, { recursive: true, force: true });

await new Promise((resolve, reject) => {
  const child = spawn(
    process.execPath,
    [tauriCli, 'icon', source, '--output', generatedDir],
    { cwd: root, stdio: 'inherit' }
  );
  child.on('error', reject);
  child.on('exit', (code) => {
    if (code === 0) resolve();
    else reject(new Error(`Tauri icon generation failed with exit code ${code ?? 'unknown'}`));
  });
});

await copyFile(join(generatedDir, '32x32.png'), join(iconsDir, '32x32.png'));
await copyFile(join(generatedDir, '128x128.png'), join(iconsDir, '128x128.png'));
await copyFile(join(generatedDir, '128x128@2x.png'), join(iconsDir, 'henry.w@example.net'));
await copyFile(join(generatedDir, 'icon.png'), join(iconsDir, 'icon.png'));
await copyFile(join(generatedDir, 'icon.ico'), join(iconsDir, 'icon.ico'));
await copyFile(join(generatedDir, 'icon.png'), join(sourceDirectory, 'icon.png'));
await copyFile(join(generatedDir, 'icon.ico'), join(sourceDirectory, 'icon.ico'));
await rm(generatedDir, { recursive: true, force: true });

console.log('Generated icons from build/icon-source.png');
