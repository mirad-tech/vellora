import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkMsedgedriver, readWebView2Runtime } from './webview2-runtime.mjs';

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('The WebView2 test driver downloader requires Windows x64.');
}

const root = fs.realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
const driverDirectory = path.join(root, 'artifacts', 'webdriver');
fs.mkdirSync(driverDirectory, { recursive: true });
const realDirectory = fs.realpathSync(driverDirectory);
const relative = path.relative(root, realDirectory);
if (relative !== path.join('artifacts', 'webdriver')) {
  throw new Error('The WebDriver cache must resolve inside this checkout.');
}
const driverPath = path.join(realDirectory, 'msedgedriver.exe');
const runtime = readWebView2Runtime();
console.log('[webdriver] Registered WebView2 Runtime: ' + runtime.version);

function verifyDriver(executable) {
  const result = checkMsedgedriver(executable, runtime.version);
  console.log('[webdriver] ' + result.version + ', Authenticode ' + result.status + ': ' + result.subject);
}

function provision() {
  if (fs.existsSync(driverPath)) {
    try {
      verifyDriver(fs.realpathSync(driverPath));
      console.log('[webdriver] Reusing ' + driverPath);
      return;
    } catch (error) {
      console.warn('[webdriver] Project cache cannot be reused: ' + error.message);
    }
  }

  const staging = fs.mkdtempSync(path.join(realDirectory, 'download-'));
  try {
    const archive = path.join(staging, 'edgedriver_win64.zip');
    const download = 'https://msedgedriver.microsoft.com/' + runtime.version + '/edgedriver_win64.zip';
    execFileSync('curl.exe', [
      '--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https',
      '--connect-timeout', '10', '--max-time', '90', '--retry', '2',
      '--output', archive, download
    ], { stdio: 'inherit', windowsHide: true, timeout: 200_000 });

    const quote = value => "'" + value.replaceAll("'", "''") + "'";
    const extract = '$ErrorActionPreference = "Stop"\n$ProgressPreference = "SilentlyContinue"\nExpand-Archive -LiteralPath ' +
      quote(archive) + ' -DestinationPath ' + quote(staging);
    execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(extract, 'utf16le').toString('base64')
    ], { stdio: 'inherit', windowsHide: true, timeout: 30_000 });

    const candidate = path.join(staging, 'msedgedriver.exe');
    verifyDriver(candidate);
    fs.renameSync(candidate, driverPath);
    console.log('[webdriver] Installed test driver at ' + driverPath);
  } finally {
    const resolved = fs.realpathSync(staging);
    if (path.dirname(resolved) !== realDirectory || !path.basename(resolved).startsWith('download-')) {
      throw new Error('Refusing to clean a directory outside the WebDriver staging cache.');
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

provision();
