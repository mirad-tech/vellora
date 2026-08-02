import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const version = packageJson.version;
const sourceDirectory = path.join(
  root,
  'src-tauri',
  'target',
  'universal-apple-darwin',
  'release',
  'bundle',
  'dmg'
);
const outputDirectory = path.join(root, 'artifacts', 'releases', 'macos', version);
const outputName = `Vellora_${version}_universal.dmg`;
const outputPath = path.join(outputDirectory, outputName);
const checksumPath = path.join(outputDirectory, 'SHA256SUMS.txt');

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

if (process.platform !== 'darwin') {
  throw new Error('[mac:organize] DMG artifacts can only be organized on macOS.');
}

let entries;
try {
  entries = await readdir(sourceDirectory, { withFileTypes: true });
} catch (error) {
  if (error?.code === 'ENOENT') {
    throw new Error(`[mac:organize] build output is missing: ${sourceDirectory}`);
  }
  throw error;
}
const dmgs = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.dmg'));
if (dmgs.length !== 1) {
  throw new Error(`[mac:organize] expected exactly one DMG, found ${dmgs.length}.`);
}

await mkdir(outputDirectory, { recursive: true });
for (const entry of await readdir(outputDirectory, { withFileTypes: true })) {
  if (entry.isFile() && (entry.name.endsWith('.dmg') || entry.name === 'SHA256SUMS.txt')) {
    await unlink(path.join(outputDirectory, entry.name));
  }
}

await copyFile(path.join(sourceDirectory, dmgs[0].name), outputPath);
const digest = await sha256(outputPath);
await writeFile(checksumPath, `${digest}  ${outputName}\n`, 'utf8');
const details = await stat(outputPath);

console.log(
  `[mac:organize] ${path.relative(root, outputPath)} (${details.size} bytes, sha256 ${digest}).`
);
