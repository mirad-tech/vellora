import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { checkMsedgedriver, readWebView2Runtime } from '../../tools/webdriver/webview2-runtime.mjs';
import { runDesktopSmoke } from './smoke.desktop.mjs';
import { openWebDriverSession, waitFor, webdriverRequest } from './webdriver.mjs';

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('Native E2E requires Windows x64.');
}

const root = fs.realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
const target = path.join(root, 'src-tauri', 'target', 'desktop-e2e');
const application = path.join(target, 'release', 'vellora.exe');
const identifier = 'com.vellora.e2e.run-' + crypto.createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 12);
const profilePrefix = 'vellora-desktop-e2e-';
const temporary = fs.realpathSync(os.tmpdir());

function findExecutable(name, override, fallback) {
  if (override) return fs.realpathSync(override);
  if (fallback && fs.existsSync(fallback)) return fs.realpathSync(fallback);
  try {
    const file = execFileSync('where.exe', [name], { encoding: 'utf8', windowsHide: true, timeout: 5_000 })
      .split(/\r?\n/).map(line => line.trim()).find(Boolean);
    if (file) return fs.realpathSync(file);
  } catch {
    // Preflight below explains how to provide the required executable.
  }
  throw new Error(name + ' was not found. Prepare the native test drivers before running E2E.');
}

function buildExecutable() {
  fs.mkdirSync(target, { recursive: true });
  if (path.relative(root, fs.realpathSync(target)) !== path.join('src-tauri', 'target', 'desktop-e2e')) {
    throw new Error('The native test target must resolve inside this checkout.');
  }
  const npmCli = process.env.npm_execpath;
  if (!npmCli || !fs.existsSync(npmCli)) throw new Error('Run native E2E with npm run test:e2e:desktop.');
  console.log('[desktop E2E] Building embedded assets and an isolated test executable (' + identifier + ')');
  execFileSync(process.execPath, [npmCli, 'run', 'build:web'], { cwd: root, stdio: 'inherit', windowsHide: true });
  execFileSync('cargo', ['build', '--locked', '--manifest-path', 'src-tauri/Cargo.toml',
    '--target-dir', target, '--release', '--features', 'custom-protocol'], {
    cwd: root, stdio: 'inherit', windowsHide: true,
    env: { ...process.env, TAURI_CONFIG: JSON.stringify({ identifier }) }
  });
  if (!fs.statSync(application).isFile()) throw new Error('Missing native test executable at ' + application);
}

function listedTestProcesses() {
  const ps = '$ErrorActionPreference = "Stop"\n$ProgressPreference = "SilentlyContinue"\n' +
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n' +
    "$items = @(Get-CimInstance Win32_Process -Filter \"Name = 'vellora.exe'\" | " +
    'Select-Object ProcessId, ExecutablePath, CommandLine)\n' +
    'ConvertTo-Json -InputObject $items -Compress';
  const rows = JSON.parse(execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')
  ], { encoding: 'utf8', windowsHide: true, timeout: 10_000 }));
  if (!Array.isArray(rows)) throw new Error('Could not verify native test process ownership.');
  return rows.filter(row => typeof row.ExecutablePath === 'string' &&
    path.normalize(row.ExecutablePath).toLowerCase() === application.toLowerCase());
}

function refuseExistingTestApplication() {
  if (listedTestProcesses().length) {
    throw new Error('An executable from this isolated test target is already running.');
  }
}

async function freePorts() {
  const listeners = [net.createServer(), net.createServer()];
  try {
    await Promise.all(listeners.map(server => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    })));
    return listeners.map(server => server.address().port);
  } finally {
    await Promise.all(listeners.filter(server => server.listening)
      .map(server => new Promise(resolve => server.close(resolve))));
  }
}

function ownsListeningPort(port, pid) {
  const table = execFileSync('netstat.exe', ['-ano', '-p', 'tcp'], {
    encoding: 'utf8', windowsHide: true, timeout: 5_000
  });
  return table.split(/\r?\n/).some(line => {
    const [protocol, local, remote, , owner] = line.trim().split(/\s+/);
    return protocol === 'TCP' && local === '127.0.0.1:' + port && remote === '0.0.0.0:0' && owner === String(pid);
  });
}

async function runNative() {
  const tauriDriver = findExecutable('tauri-driver.exe', process.env.TAURI_DRIVER_PATH);
  const msedgedriver = findExecutable('msedgedriver.exe', process.env.MSEDGEDRIVER_PATH,
    path.join(root, 'artifacts', 'webdriver', 'msedgedriver.exe'));
  const runtime = readWebView2Runtime();
  const driverInfo = checkMsedgedriver(msedgedriver, runtime.version);
  console.log('[desktop E2E] WebView2 ' + runtime.version + ', msedgedriver ' + driverInfo.version +
    ', Authenticode ' + driverInfo.status + ': ' + driverInfo.subject);

  refuseExistingTestApplication();
  buildExecutable();
  refuseExistingTestApplication();
  const [port, nativePort] = await freePorts();
  const baseUrl = 'http://127.0.0.1:' + port;
  const scratch = fs.mkdtempSync(path.join(temporary, profilePrefix));
  const token = '--vellora-e2e-session=' + crypto.randomUUID();
  const source = path.join(scratch, 'source.md');
  const linked = path.join(scratch, 'target.md');
  const screenshotDirectory = process.env.VELLORA_DESKTOP_SCREENSHOT_DIR;
  let driver;
  let driverExit;
  let driverDone;
  let browser;
  let failure;
  const cleanupErrors = [];
  const stopDriver = () => { if (driver?.pid && !driverExit) driver.kill(); };
  process.once('SIGINT', stopDriver);
  process.once('SIGTERM', stopDriver);

  try {
    fs.writeFileSync(source, [
      '# 源文档', '', '正文搜索词 alpha', '', '[本地目标](./target.md)', '',
      '[外链](https://example.com/path)', ''
    ].join('\r\n'), 'utf8');
    fs.writeFileSync(linked, [
      '# 目标文档', '', '来自链接跳转。', '', '[外链](https://example.com/path)', ''
    ].join('\r\n'), 'utf8');
    const env = { ...process.env, WEBVIEW2_USER_DATA_FOLDER: path.join(scratch, 'webview-profile') };
    // Match the registered Runtime instead of inheriting a fixed distribution override.
    delete env.WEBVIEW2_BROWSER_EXECUTABLE_FOLDER;
    driver = spawn(tauriDriver, [
      '--port', String(port), '--native-port', String(nativePort), '--native-driver', msedgedriver
    ], { cwd: root, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true, env });
    driverDone = new Promise(resolve => {
      driver.once('error', error => { driverExit = error.message; resolve(); });
      driver.once('exit', (code, signal) => { driverExit = String(code ?? signal); resolve(); });
    });

    await waitFor('the isolated WebDriver listener', async () => {
      if (driverExit) throw new Error('tauri-driver exited before readiness: ' + driverExit);
      if (!ownsListeningPort(port, driver.pid)) return false;
      try { return (await webdriverRequest(baseUrl + '/status', 'GET', undefined, 1_000)).ready; }
      catch { return false; }
    });
    browser = await openWebDriverSession(baseUrl, application, [source, token]);
    const viewport = await runDesktopSmoke(browser, { source, target: linked, screenshotDirectory });
    if (screenshotDirectory) {
      fs.writeFileSync(path.join(screenshotDirectory, 'metrics.json'), JSON.stringify({
        renderer: 'Native Tauri WebView2', viewport, runtime: runtime.version, driver: driverInfo.version,
        version: browser.capabilities?.browserVersion, authenticode: driverInfo.status, identifier
      }, null, 2) + '\n');
    }
  } catch (error) {
    failure = error;
  } finally {
    try { await browser?.close(); } catch (error) { cleanupErrors.push(error); }
    try {
      // tauri-driver 2.0.6 owns a Windows kill-on-close Job Object for its children.
      stopDriver();
      if (driverDone) {
        const ended = await Promise.race([driverDone.then(() => true), delay(5_000, false, { ref: false })]);
        if (!ended) throw new Error('The owned WebDriver process did not exit.');
      }
      const running = listedTestProcesses();
      if (running.length) {
        const pids = running.map(row => String(row.ProcessId) + (row.CommandLine?.includes(token) ? ' (this session)' : ' (unverified)'));
        throw new Error('Processes from the isolated test target remain. PIDs ' + pids.join(', '));
      }
      const resolved = fs.realpathSync(scratch);
      if (path.dirname(resolved) !== temporary || !path.basename(resolved).startsWith(profilePrefix)) {
        throw new Error('Refusing to clean a path outside the test fixture directory.');
      }
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch (error) {
      cleanupErrors.push(error);
      console.error('[desktop E2E] Test fixture directory retained: ' + scratch);
    }
    process.removeListener('SIGINT', stopDriver);
    process.removeListener('SIGTERM', stopDriver);
  }
  if (failure || cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], 'Native E2E failed.');
  console.log('[desktop E2E] Owned session and fixture cleanup passed');
}

if (process.argv.includes('--build-only')) {
  refuseExistingTestApplication();
  buildExecutable();
} else {
  await runNative();
}
