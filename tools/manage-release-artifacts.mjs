import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(
  await readFile(join(root, 'package.json'), 'utf8')
);
const version = packageJson.version;
const installerName = `Vellora_${version}_x64-setup.exe`;
const sourceDirectory = join(
  root,
  'src-tauri',
  'target',
  'release',
  'bundle',
  'nsis'
);
const sourceInstaller = join(sourceDirectory, installerName);
const releasesDirectory = join(root, 'artifacts', 'releases');
const currentDirectory = join(releasesDirectory, 'current');
const archiveDirectory = join(releasesDirectory, 'archive');
const currentInstaller = join(currentDirectory, installerName);
const manifestPath = join(releasesDirectory, 'manifest.json');
const checkOnly = process.argv.includes('--check');
const pruneOnly = process.argv.includes('--prune-old');

async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function listFiles(directory) {
  if (!(await fileExists(directory))) {
    return [];
  }

  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

async function describeFile(path) {
  const details = await stat(path);
  return {
    path: relative(releasesDirectory, path).replaceAll('\\', '/'),
    bytes: details.size,
    sha256: await hashFile(path)
  };
}

async function readManifest() {
  if (!(await fileExists(manifestPath))) {
    throw new Error(
      'Release manifest is missing. Run npm run release:organize first.'
    );
  }
  return JSON.parse(await readFile(manifestPath, 'utf8'));
}

async function writeManifest() {
  const current = await describeFile(currentInstaller);
  const manifest = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    projectVersion: version,
    current
  };
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
  );
  return current;
}

async function pruneOldReleases() {
  if (!(await fileExists(currentInstaller))) {
    throw new Error(`Current installer is missing: ${currentInstaller}`);
  }

  await mkdir(currentDirectory, { recursive: true });
  for (const path of await listFiles(currentDirectory)) {
    if (path !== currentInstaller) {
      await rm(path);
    }
  }
  await rm(archiveDirectory, { recursive: true, force: true });
  const current = await writeManifest();

  console.log(
    `Pruned old local releases; kept ${current.path} (${current.sha256}).`
  );
}

async function checkRelease() {
  if (!(await fileExists(currentInstaller))) {
    throw new Error(`Current installer is missing: ${currentInstaller}`);
  }

  const currentFiles = await listFiles(currentDirectory);
  if (currentFiles.length !== 1 || currentFiles[0] !== currentInstaller) {
    throw new Error(
      `current/ must contain only ${installerName}; found ${currentFiles.length} file(s).`
    );
  }

  const manifest = await readManifest();
  const current = await describeFile(currentInstaller);
  if (
    manifest.projectVersion !== version ||
    manifest.current?.path !== current.path ||
    manifest.current?.bytes !== current.bytes ||
    manifest.current?.sha256 !== current.sha256
  ) {
    throw new Error(
      'Current installer does not match package.json or manifest.json.'
    );
  }

  const archiveFiles = await listFiles(archiveDirectory);
  if (archiveFiles.length > 0 || 'archive' in manifest) {
    throw new Error(
      'Old local releases remain. Run npm run release:prune-old.'
    );
  }

  if (await fileExists(sourceInstaller)) {
    const sourceHash = await hashFile(sourceInstaller);
    if (sourceHash !== current.sha256) {
      throw new Error(
        'Current installer differs from the latest Tauri build output.'
      );
    }
  }

  console.log(
    `Release ${version} is organized and verified (${current.sha256}).`
  );
}

async function organizeRelease() {
  if (!(await fileExists(sourceInstaller))) {
    throw new Error(
      `Expected installer was not built: ${sourceInstaller}. Run npm run build first.`
    );
  }

  await mkdir(currentDirectory, { recursive: true });

  for (const path of await listFiles(currentDirectory)) {
    if (path !== currentInstaller) {
      await rm(path);
    }
  }

  await copyFile(sourceInstaller, currentInstaller);

  for (const path of await listFiles(sourceDirectory)) {
    const name = path.split(/[\\/]/).at(-1);
    if (
      path !== sourceInstaller &&
      /^Vellora_.+_x64-setup\.exe$/i.test(name)
    ) {
      await rm(path);
    }
  }

  await rm(archiveDirectory, { recursive: true, force: true });
  const current = await writeManifest();

  console.log(
    `Organized Vellora ${version}: kept only ${current.path}.`
  );
}

if (checkOnly) {
  await checkRelease();
} else if (pruneOnly) {
  await pruneOldReleases();
} else {
  await organizeRelease();
}
