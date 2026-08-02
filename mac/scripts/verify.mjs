import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const version = packageJson.version;
const outputDirectory = path.join(root, 'artifacts', 'releases', 'macos', version);
const dmgName = `Vellora_${version}_universal.dmg`;
const dmgPath = path.join(outputDirectory, dmgName);
const checksumPath = path.join(outputDirectory, 'SHA256SUMS.txt');
const requireNotarization = process.env.VELLORA_REQUIRE_NOTARIZATION === '1';

function fail(message) {
  throw new Error(`[mac:verify] ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : 'pipe'
  });
  if (result.error) fail(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout || ''}`);
  }
  return result.stdout?.trim() ?? '';
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

if (process.platform !== 'darwin') fail('DMG verification requires macOS system tools.');

const checksum = (await readFile(checksumPath, 'utf8')).trim().match(/^([0-9a-f]{64})\s{2}(.+)$/i);
if (!checksum || checksum[2] !== dmgName) fail('SHA256SUMS.txt has an invalid entry.');
const actualDigest = await sha256(dmgPath);
if (actualDigest !== checksum[1].toLowerCase()) fail('DMG SHA-256 does not match SHA256SUMS.txt.');

const attachOutput = run('hdiutil', ['attach', '-nobrowse', '-readonly', dmgPath]);
const mountLine = attachOutput
  .split(/\r?\n/)
  .find((line) => line.includes('/Volumes/'));
if (!mountLine) fail(`could not determine mounted volume from:\n${attachOutput}`);
const mountPoint = mountLine.slice(mountLine.indexOf('/Volumes/')).trim();

try {
  const appPath = path.join(mountPoint, 'Vellora.app');
  const applicationsLink = path.join(mountPoint, 'Applications');
  const binaryPath = path.join(appPath, 'Contents', 'MacOS', 'vellora');
  const infoPlist = path.join(appPath, 'Contents', 'Info.plist');

  const applicationLinkInfo = await lstat(applicationsLink);
  if (!applicationLinkInfo.isSymbolicLink()) fail('DMG is missing the Applications symlink.');

  const architectures = new Set(run('lipo', ['-archs', binaryPath]).split(/\s+/));
  for (const architecture of ['arm64', 'x86_64']) {
    if (!architectures.has(architecture)) fail(`application binary is missing ${architecture}.`);
  }

  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  const plist = JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', infoPlist]));
  if (plist.CFBundleIdentifier !== 'app.markdown-viewer.desktop') {
    fail(`unexpected bundle identifier: ${plist.CFBundleIdentifier ?? '(missing)'}`);
  }
  if (plist.LSMinimumSystemVersion !== '12.0') {
    fail(`unexpected minimum macOS version: ${plist.LSMinimumSystemVersion ?? '(missing)'}`);
  }

  const documentTypes = Array.isArray(plist.CFBundleDocumentTypes)
    ? plist.CFBundleDocumentTypes
    : [];
  const markdownDocumentTypes = documentTypes.filter((type) =>
    (type.CFBundleTypeExtensions || []).some((value) =>
      ['md', 'markdown'].includes(value.toLowerCase())
    )
  );
  const extensions = new Set(
    markdownDocumentTypes
      .flatMap((type) => type.CFBundleTypeExtensions || [])
      .map((value) => value.toLowerCase())
  );
  const contentTypes = new Set(
    markdownDocumentTypes.flatMap((type) => type.LSItemContentTypes || [])
  );
  const mimeTypes = new Set(
    markdownDocumentTypes.flatMap((type) => type.CFBundleTypeMIMETypes || [])
  );
  if (!extensions.has('md') || !extensions.has('markdown')) {
    fail('Info.plist does not associate both .md and .markdown.');
  }
  if (!contentTypes.has('net.daringfireball.markdown')) {
    fail('Info.plist is missing the system Markdown content type.');
  }
  if (!mimeTypes.has('text/markdown')) {
    fail('Info.plist is missing the text/markdown MIME declaration.');
  }
  if (markdownDocumentTypes.some((type) => type.CFBundleTypeRole !== 'Editor')) {
    fail('Info.plist Markdown associations must use the Editor role.');
  }
  if (markdownDocumentTypes.some((type) => type.LSHandlerRank !== 'Default')) {
    fail('Info.plist Markdown associations must use the Default handler rank.');
  }

  const iconName = plist.CFBundleIconFile;
  if (!iconName) fail('Info.plist is missing CFBundleIconFile.');
  const iconPath = path.join(
    appPath,
    'Contents',
    'Resources',
    iconName.toLowerCase().endsWith('.icns') ? iconName : `${iconName}.icns`
  );
  await lstat(iconPath);

  if (requireNotarization) {
    run('spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath]);
    // Tauri notarizes and staples the app before placing it in the DMG.
    run('xcrun', ['stapler', 'validate', appPath]);
  } else {
    console.log('[mac:verify] ad-hoc test artifact: Gatekeeper notarization checks skipped.');
  }
} finally {
  run('hdiutil', ['detach', mountPoint]);
}

console.log(`[mac:verify] ${dmgName} is a valid Universal macOS 12+ artifact (${actualDigest}).`);
