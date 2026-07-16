/**
 * Windows desktop E2E launcher (external drivers only).
 *
 * - Never kills Vellora by process name or path bulk.
 * - Process listing is fail-closed (query errors abort the run).
 * - Cleanup only stops WDIO / tauri-driver PIDs this script spawned,
 *   plus Vellora instances that carry this run's unique session token.
 *
 * Prerequisites on PATH:
 *   - tauri-driver  (cargo install tauri-driver --locked)
 *   - msedgedriver.exe matching Edge major version
 */
import { spawn, spawnSync, execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DesktopE2EError,
  assertNoPreexistingVellora,
  createCleanupController,
  isValidSessionToken
} from './desktop-processes.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');
const appBinary = path.resolve(root, 'src-tauri', 'target', 'release', 'vellora.exe');

function fail(msg) {
  throw new DesktopE2EError(`[e2e:desktop] ${msg}`);
}

function which(cmd) {
  try {
    const out = execSync(
      process.platform === 'win32' ? `where ${cmd}` : `command -v ${cmd}`,
      { encoding: 'utf8', shell: true }
    );
    return out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)[0];
  } catch {
    return null;
  }
}

function edgeVersion() {
  const candidates = [
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  ];
  const edge = candidates.find((p) => fs.existsSync(p));
  if (!edge) fail('Microsoft Edge not found (required for WebView2 desktop E2E).');
  try {
    const ps = `powershell -NoProfile -Command "(Get-Item '${edge.replace(/'/g, "''")}').VersionInfo.ProductVersion"`;
    return execSync(ps, { encoding: 'utf8' }).trim();
  } catch {
    fail(`Could not read Edge version from ${edge}`);
  }
}

function major(version) {
  const m = String(version).match(/^(\d+)/);
  return m ? m[1] : null;
}

function msedgedriverVersion(driverPath) {
  try {
    const out = execSync(`"${driverPath}" --version`, { encoding: 'utf8' });
    const m = out.match(/(\d+\.\d+\.\d+\.\d+|\d+\.\d+\.\d+)/);
    return m ? m[1] : out.trim();
  } catch {
    fail(`Could not run msedgedriver --version at ${driverPath}`);
  }
}

function resolveMsedgedriver() {
  const candidates = [
    process.env.MSEDGEDRIVER_PATH,
    which('msedgedriver'),
    which('msedgedriver.exe'),
    // Project-local install from: npm run tools:msedgedriver
    path.join(root, 'tools', 'webdriver', 'msedgedriver.exe')
  ].filter(Boolean);
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return path.resolve(p);
  }
  return null;
}

function ensureDrivers() {
  const tauriDriver = which('tauri-driver') || which('tauri-driver.exe');
  if (!tauriDriver) {
    fail(
      'tauri-driver not found on PATH. Install with: cargo install tauri-driver --locked\n' +
        'See https://v2.tauri.app/develop/tests/webdriver/'
    );
  }

  const msedgedriver = resolveMsedgedriver();
  if (!msedgedriver) {
    fail(
      'msedgedriver.exe not found. Install a build matching your Edge major version:\n' +
        '  npm run tools:msedgedriver\n' +
        'or download from https://developer.microsoft.com/en-us/microsoft-edge/tools/webdriver/\n' +
        'and set MSEDGEDRIVER_PATH / PATH, or place it at tools/webdriver/msedgedriver.exe'
    );
  }

  const edgeV = edgeVersion();
  const driverV = msedgedriverVersion(msedgedriver);
  const edgeMajor = major(edgeV);
  const driverMajor = major(driverV);
  if (!edgeMajor || !driverMajor || edgeMajor !== driverMajor) {
    fail(
      `Edge major version (${edgeV}) does not match msedgedriver (${driverV}). ` +
        'Install a matching driver; refusing to fall back to mocks.'
    );
  }

  console.log(`[e2e:desktop] tauri-driver: ${tauriDriver}`);
  console.log(`[e2e:desktop] msedgedriver: ${msedgedriver} (${driverV})`);
  console.log(`[e2e:desktop] Edge: ${edgeV}`);
  return { tauriDriver, msedgedriver };
}

function writeFixtures() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vellora-desktop-e2e-'));
  const source = path.join(dir, 'source.md');
  const target = path.join(dir, 'target.md');
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
  return { dir, source, target };
}

function runSync(cmd, args) {
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: process.env
  });
  if (r.status !== 0) {
    fail(`${cmd} ${args.join(' ')} exited ${r.status}`);
  }
}

async function main() {
  if (process.platform !== 'win32') {
    fail('Desktop E2E is Windows-only.');
  }

  const session = crypto.randomUUID();
  if (!isValidSessionToken(session)) {
    fail(`Generated session token is invalid: ${session}`);
  }
  console.log(`[e2e:desktop] session: ${session}`);

  let fixtures = null;
  let driverProc = null;
  let wdioProc = null;

  const controller = createCleanupController();
  const cleanupState = () => ({
    wdioPid: wdioProc?.pid ?? null,
    driverPid: driverProc?.pid ?? null,
    appBinary,
    session,
    fixtureDir: fixtures?.dir ?? null
  });

  const cleanup = () => controller.cleanup(cleanupState());

  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });

  try {
    // Before drivers/build: fail closed if any Vellora is running or query fails.
    assertNoPreexistingVellora();

    const { tauriDriver, msedgedriver } = ensureDrivers();

    fixtures = writeFixtures();
    const driverPort = Number(process.env.TAURI_DRIVER_PORT || 4444);

    console.log('[e2e:desktop] building web + release binary (custom-protocol)…');
    runSync('npm', ['run', 'build:web']);
    // Must enable custom-protocol; otherwise Tauri stays in dev mode and loads
    // http://localhost:1420 instead of the embedded frontendDist assets.
    runSync('cargo', [
      'build',
      '--manifest-path',
      'src-tauri/Cargo.toml',
      '--release',
      '--features',
      'custom-protocol'
    ]);

    if (!fs.existsSync(appBinary)) {
      fail(`Release binary missing: ${appBinary}`);
    }

    // Re-check before launching (user may have opened app during build).
    assertNoPreexistingVellora();

    console.log(`[e2e:desktop] starting tauri-driver on :${driverPort}`);
    driverProc = spawn(
      tauriDriver,
      ['--port', String(driverPort), '--native-driver', msedgedriver],
      {
        cwd: root,
        stdio: 'inherit',
        shell: true,
        env: process.env
      }
    );

    await new Promise((r) => setTimeout(r, 1500));

    const wdioBin = path.join(root, 'node_modules', '.bin', 'wdio.cmd');
    const status = await new Promise((resolve) => {
      wdioProc = spawn(wdioBin, ['run', 'wdio.desktop.conf.js'], {
        cwd: root,
        stdio: 'inherit',
        shell: true,
        env: {
          ...process.env,
          VELLORA_E2E_SOURCE: fixtures.source,
          VELLORA_E2E_TARGET: fixtures.target,
          VELLORA_E2E_SESSION: session,
          TAURI_DRIVER_PORT: String(driverPort)
        }
      });
      wdioProc.on('exit', (code) => resolve(code ?? 1));
      wdioProc.on('error', () => resolve(1));
    });

    const { cleanupFailed } = cleanup();
    if (cleanupFailed) {
      process.exit(1);
    }
    process.exit(status ?? 1);
  } catch (err) {
    console.error(err instanceof DesktopE2EError ? err.message : err);
    cleanup();
    process.exit(1);
  }
}

main();
