import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { dirname, extname, join, relative } from 'node:path';
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
const archiveTauriDirectory = join(
  releasesDirectory,
  'archive',
  'tauri'
);
const currentInstaller = join(currentDirectory, installerName);
const manifestPath = join(releasesDirectory, 'manifest.json');
const checkOnly = process.argv.includes('--check');

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

async function uniqueArchivePath(path, archiveDirectory) {
  const name = path.split(/[\\/]/).at(-1);
  const destination = join(archiveDirectory, name);
  if (!(await fileExists(destination))) {
    return destination;
  }

  const [sourceHash, destinationHash] = await Promise.all([
    hashFile(path),
    hashFile(destination)
  ]);
  if (sourceHash === destinationHash) {
    return null;
  }

  const extension = extname(destination);
  const stem = destination.slice(0, -extension.length);
  let candidate = `${stem}.${sourceHash.slice(0, 12)}${extension}`;
  let counter = 2;
  while (await fileExists(candidate)) {
    if ((await hashFile(candidate)) === sourceHash) {
      return null;
    }
    candidate = `${stem}.${sourceHash.slice(0, 12)}-${counter}${extension}`;
    counter += 1;
  }
  return candidate;
}

async function archiveFile(path, archiveDirectory) {
  await mkdir(archiveDirectory, { recursive: true });
  const destination = await uniqueArchivePath(path, archiveDirectory);
  if (destination === null) {
    await rm(path);
    return;
  }
  await rename(path, destination);
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

  const archiveFiles = (
    await listFiles(join(releasesDirectory, 'archive'))
  ).sort();
  const archive = [];
  for (const path of archiveFiles) {
    archive.push(await describeFile(path));
  }
  if (JSON.stringify(manifest.archive ?? []) !== JSON.stringify(archive)) {
    throw new Error('Archive files do not match manifest.json.');
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

  await Promise.all([
    mkdir(currentDirectory, { recursive: true }),
    mkdir(archiveTauriDirectory, { recursive: true })
  ]);

  for (const path of await listFiles(currentDirectory)) {
    if (path !== currentInstaller) {
      await archiveFile(path, archiveTauriDirectory);
    }
  }

  if (await fileExists(currentInstaller)) {
    const [sourceHash, currentHash] = await Promise.all([
      hashFile(sourceInstaller),
      hashFile(currentInstaller)
    ]);
    if (sourceHash !== currentHash) {
      await archiveFile(currentInstaller, archiveTauriDirectory);
    }
  }
  await copyFile(sourceInstaller, currentInstaller);

  for (const path of await listFiles(sourceDirectory)) {
    const name = path.split(/[\\/]/).at(-1);
    if (
      path !== sourceInstaller &&
      /^Vellora_.+_x64-setup\.exe$/i.test(name)
    ) {
      await archiveFile(path, archiveTauriDirectory);
    }
  }

  const archiveFiles = await listFiles(
    join(releasesDirectory, 'archive')
  );
  const current = await describeFile(currentInstaller);
  const archive = [];
  for (const path of archiveFiles.sort()) {
    archive.push(await describeFile(path));
  }

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    projectVersion: version,
    current,
    archive
  };
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
  );

  console.log(
    `Organized Vellora ${version}: 1 current installer, ${archive.length} archived file(s).`
  );
}

if (checkOnly) {
  await checkRelease();
} else {
  await organizeRelease();
}
