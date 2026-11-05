/**
 * Download msedgedriver matching the registered Microsoft Edge WebView2 Runtime.
 * Writes to artifacts/webdriver/msedgedriver.exe (gitignored).
 *
 * Usage: npm run tools:msedgedriver
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  driverMatchesRuntime,
  readWebView2Runtime,
  verifyMicrosoftSignature
} from './webview2-runtime.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');
const outDir = path.join(root, 'artifacts', 'webdriver');
const zipPath = path.join(outDir, 'edgedriver_win64.zip');
const driverPath = path.join(outDir, 'msedgedriver.exe');
const driverNotesPath = path.join(outDir, 'Driver_Notes');

function removePath(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function cleanupDownloadArtifacts({ removeDriver = false } = {}) {
  removePath(zipPath);
  removePath(driverNotesPath);
  if (removeDriver) {
    removePath(driverPath);
  }
}

function download(url, dest) {
  // Prefer curl.exe (handles this CDN more reliably than some PowerShell TLS stacks).
  const curl = spawnSync(
    'curl.exe',
    ['-L', '--http1.1', '--retry', '5', '--retry-delay', '2', '-o', dest, url],
    { stdio: 'inherit', windowsHide: true }
  );
  if (curl.status === 0 && fs.existsSync(dest) && fs.statSync(dest).size > 100_000) {
    return;
  }
  removePath(dest);
  // Fallback: PowerShell Invoke-WebRequest
  const ps = `
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -Uri '${url.replace(/'/g, "''")}' -OutFile '${dest.replace(/'/g, "''")}' -UseBasicParsing
`;
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', ps],
    { stdio: 'inherit', windowsHide: true }
  );
  if (r.status !== 0 || !fs.existsSync(dest) || fs.statSync(dest).size <= 100_000) {
    throw new Error(`Failed to download msedgedriver from ${url}`);
  }
}

function extractZip(zip, destDir) {
  const ps = `
$ErrorActionPreference = 'Stop'
Expand-Archive -Path '${zip.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force
`;
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', ps],
    { stdio: 'inherit', windowsHide: true }
  );
  if (r.status !== 0 || !fs.existsSync(driverPath)) {
    throw new Error('Failed to extract msedgedriver.exe from zip');
  }
}

function main() {
  if (process.platform !== 'win32') {
    throw new Error('msedgedriver fetch is Windows-only.');
  }

  fs.mkdirSync(outDir, { recursive: true });
  const runtime = readWebView2Runtime();
  const version = runtime.version;
  console.log(`[tools] WebView2 Runtime: ${version}`);
  console.log(`[tools] Runtime registry: ${runtime.sources.join('; ')}`);

  if (fs.existsSync(driverPath)) {
    try {
      const signature = verifyMicrosoftSignature(driverPath);
      const v = execFileSync(driverPath, ['--version'], { encoding: 'utf8' });
      if (driverMatchesRuntime(v, version)) {
        cleanupDownloadArtifacts();
        console.log(`[tools] Authenticode: ${signature.status} (${signature.subject})`);
        console.log(`[tools] Already have matching driver: ${v.trim()}`);
        console.log(`[tools] Path: ${driverPath}`);
        return;
      }
      console.log(`[tools] Existing driver ${v.trim()} does not match WebView2 Runtime ${version}.`);
    } catch (err) {
      console.warn(`[tools] Existing driver rejected: ${err?.message || err}`);
    }
    cleanupDownloadArtifacts({ removeDriver: true });
  }

  const url = `https://msedgedriver.microsoft.com/${version}/edgedriver_win64.zip`;
  cleanupDownloadArtifacts();
  try {
    console.log(`[tools] Downloading ${url}`);
    download(url, zipPath);
    console.log(`[tools] Extracting to ${outDir}`);
    extractZip(zipPath, outDir);

    // Never execute a downloaded driver before its Authenticode signature is trusted.
    const signature = verifyMicrosoftSignature(driverPath);
    const verOut = execFileSync(driverPath, ['--version'], { encoding: 'utf8' }).trim();
    if (!driverMatchesRuntime(verOut, version)) {
      throw new Error(
        `Downloaded driver ${verOut} does not match WebView2 Runtime ${version}`
      );
    }

    cleanupDownloadArtifacts();
    console.log(`[tools] Authenticode: ${signature.status} (${signature.subject})`);
    console.log(`[tools] Installed: ${verOut}`);
    console.log(`[tools] Path: ${driverPath}`);
    console.log('[tools] Desktop E2E will pick this up automatically (or set MSEDGEDRIVER_PATH).');
  } catch (err) {
    cleanupDownloadArtifacts({ removeDriver: true });
    throw err;
  }
}

try {
  main();
} catch (err) {
  console.error(`[tools] ${err?.message || err}`);
  process.exit(1);
}
