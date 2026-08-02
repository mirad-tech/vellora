import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tauriCli = path.join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const wdioCli = path.join(root, 'node_modules', '@wdio', 'cli', 'bin', 'wdio.js');
const appBinary = path.join(root, 'src-tauri', 'target', 'debug', 'vellora');

function fail(message) {
  throw new Error(`[mac:e2e] ${message}`);
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...env, MACOSX_DEPLOYMENT_TARGET: '12.0' }
  });
  if (result.error) fail(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(' ')} exited ${result.status}.`);
}

if (process.platform !== 'darwin') fail('embedded WKWebView E2E must run on macOS.');
if (!fs.existsSync(tauriCli) || !fs.existsSync(wdioCli)) fail('run npm ci before macOS E2E.');

const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'vellora-macos-e2e-'));
const source = path.join(fixtureDirectory, 'source.md');
const target = path.join(fixtureDirectory, 'target.md');
fs.writeFileSync(
  source,
  '# 源文档\n\n正文搜索词 alpha\n\n## 小节\n\n[本地目标](./target.md)\n\n[外链](https://example.com/path)\n',
  'utf8'
);
fs.writeFileSync(
  target,
  '# 目标文档\n\n来自链接跳转。\n\n[外链](https://example.com/path)\n',
  'utf8'
);

try {
  const buildArgs = [
    tauriCli,
    'build',
    '--debug',
    '--no-bundle',
    '--config',
    path.join('mac', 'tauri.e2e.conf.json'),
    '--features',
    'custom-protocol,macos-e2e'
  ];
  if (process.env.CI) buildArgs.push('--ci');
  run(process.execPath, buildArgs);
  if (!fs.existsSync(appBinary)) fail(`debug binary is missing: ${appBinary}`);

  run(process.execPath, [wdioCli, 'run', 'mac/tests/wdio.macos.conf.js'], {
    ...process.env,
    VELLORA_E2E_SOURCE: source,
    VELLORA_E2E_TARGET: target,
    VELLORA_E2E_MODIFIER: 'Meta'
  });
} finally {
  const resolvedFixture = path.resolve(fixtureDirectory);
  const resolvedTemp = `${path.resolve(os.tmpdir())}${path.sep}`;
  if (resolvedFixture.startsWith(resolvedTemp) && path.basename(resolvedFixture).startsWith('vellora-macos-e2e-')) {
    fs.rmSync(resolvedFixture, { recursive: true, force: true });
  }
}

console.log('[mac:e2e] real-IPC macOS desktop E2E passed.');
