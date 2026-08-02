import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tauriCli = path.join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const macConfig = path.join('mac', 'tauri.macos.conf.json');
const isDev = process.argv.includes('--dev');

function fail(message) {
  throw new Error(`[mac:build] ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: options.capture ? 'pipe' : 'inherit',
    encoding: options.capture ? 'utf8' : undefined,
    env: {
      ...process.env,
      MACOSX_DEPLOYMENT_TARGET: '12.0',
      ...options.env
    }
  });
  if (result.error) {
    fail(options.failureMessage || `${command} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    if (options.failureMessage) fail(options.failureMessage);
    const detail = options.capture ? `\n${result.stderr || result.stdout || ''}` : '';
    fail(`${command} ${args.join(' ')} exited ${result.status}.${detail}`);
  }
  return result.stdout?.trim() ?? '';
}

function runNpm(args) {
  const npmCli = process.env.npm_execpath;
  if (npmCli && existsSync(npmCli)) {
    run(process.execPath, [npmCli, ...args]);
    return;
  }
  run('npm', args);
}

if (process.platform !== 'darwin') {
  fail('macOS builds must run on a Mac. Use GitHub Actions or a macOS 12+ machine.');
}
if (!existsSync(tauriCli)) {
  fail('Tauri CLI is missing. Run npm ci first.');
}

run('xcode-select', ['-p'], {
  capture: true,
  failureMessage: 'Xcode Command Line Tools are missing. Install explicitly with: xcode-select --install'
});
runNpm(['run', 'generate:icon']);

if (isDev) {
  run(process.execPath, [tauriCli, 'dev', '--config', macConfig]);
  process.exit(0);
}

const installedTargets = new Set(
  run('rustup', ['target', 'list', '--installed'], {
    capture: true,
    failureMessage: 'Rustup is missing. Install Rust from https://rustup.rs/ and rerun npm ci.'
  }).split(/\r?\n/)
);
const requiredTargets = ['aarch64-apple-darwin', 'x86_64-apple-darwin'];
const missingTargets = requiredTargets.filter((target) => !installedTargets.has(target));
if (missingTargets.length > 0) {
  fail(
    `missing Rust target(s): ${missingTargets.join(', ')}. Install explicitly with: ` +
      `rustup target add ${missingTargets.join(' ')}`
  );
}

runNpm(['run', 'typecheck']);
const args = [
  tauriCli,
  'build',
  '--config',
  macConfig,
  '--target',
  'universal-apple-darwin',
  '--bundles',
  'app,dmg'
];
if (process.env.APPLE_SIGNING_IDENTITY) {
  // The checked-in overlay defaults to ad-hoc signing. A release identity must
  // explicitly override that value so a tagged build can never inherit `-`.
  args.push(
    '--config',
    JSON.stringify({
      bundle: { macOS: { signingIdentity: process.env.APPLE_SIGNING_IDENTITY } }
    })
  );
}
if (process.env.CI) args.push('--ci');
run(process.execPath, args);

console.log('[mac:build] Universal app and DMG build completed.');
