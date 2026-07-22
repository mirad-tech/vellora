import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const [packageJsonText, packageLockText, cargoToml, cargoLock, tauriConfigText] =
  await Promise.all([
    readFile(join(root, 'package.json'), 'utf8'),
    readFile(join(root, 'package-lock.json'), 'utf8'),
    readFile(join(root, 'src-tauri', 'Cargo.toml'), 'utf8'),
    readFile(join(root, 'src-tauri', 'Cargo.lock'), 'utf8'),
    readFile(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8')
  ]);

const packageJson = JSON.parse(packageJsonText);
const packageLock = JSON.parse(packageLockText);
const tauriConfig = JSON.parse(tauriConfigText);

const cargoTomlVersion = cargoToml.match(/^version = "([^"]+)"/m)?.[1];
const cargoLockVersion = cargoLock.match(
  /\[\[package\]\]\r?\nname = "vellora"\r?\nversion = "([^"]+)"/
)?.[1];

const versions = new Map([
  ['package.json', packageJson.version],
  ['package-lock.json', packageLock.version],
  ['package-lock.json packages[""]', packageLock.packages?.['']?.version],
  ['src-tauri/Cargo.toml', cargoTomlVersion],
  ['src-tauri/Cargo.lock', cargoLockVersion],
  ['src-tauri/tauri.conf.json', tauriConfig.version]
]);

const expected = packageJson.version;
const mismatches = [...versions].filter(([, version]) => version !== expected);

if (mismatches.length > 0) {
  for (const [file, version] of mismatches) {
    console.error(`${file}: expected ${expected}, got ${version ?? 'missing'}`);
  }
  process.exit(1);
}

console.log(`Version ${expected} is consistent across ${versions.size} manifests.`);
