/**
 * Download msedgedriver matching the installed Microsoft Edge major/full version.
 * Writes to tools/webdriver/msedgedriver.exe (gitignored).
 *
 * Usage: node tools/fetch-msedgedriver.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'tools', 'webdriver');
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

function verifyMicrosoftSignature(target) {
  const escapedTarget = target.replace(/'/g, "''");
  const ps = `
$ErrorActionPreference = 'Stop'
Import-Module Microsoft.PowerShell.Security -ErrorAction Stop
$signature = Get-AuthenticodeSignature -LiteralPath '${escapedTarget}'
$result = [PSCustomObject]@{
  Status = [string]$signature.Status
  Subject = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }
}
$result | ConvertTo-Json -Compress
`;

  let output = null;
  let lastError = null;
  for (const shell of ['pwsh.exe', 'powershell.exe']) {
    try {
      output = execFileSync(
        shell,
        ['-NoProfile', '-NonInteractive', '-Command', ps],
        { encoding: 'utf8', windowsHide: true }
      );
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (output == null) {
    throw new Error(
      `Failed to verify msedgedriver Authenticode signature: ${lastError?.message || lastError}`
    );
  }

  let result;
  try {
    result = JSON.parse(output.trim());
  } catch (err) {
    throw new Error(`Invalid Authenticode verification output: ${err?.message || err}`);
  }

  const status = typeof result?.Status === 'string' ? result.Status : '';
  const subject = typeof result?.Subject === 'string' ? result.Subject : '';
  if (status !== 'Valid' || !subject.includes('Microsoft Corporation')) {
    throw new Error(
      `Rejected msedgedriver signature (status=${status || 'missing'}, subject=${subject || 'missing'})`
    );
  }

  return { status, subject };
}

function edgeProductVersion() {
  const candidates = [
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  ];
  const edge = candidates.find((p) => fs.existsSync(p));
  if (!edge) {
    throw new Error('Microsoft Edge not found (required to pick msedgedriver version).');
  }
  const ps = `(Get-Item '${edge.replace(/'/g, "''")}').VersionInfo.ProductVersion`;
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', ps],
    { encoding: 'utf8', windowsHide: true }
  );
  return out.trim();
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
  const version = edgeProductVersion();
  console.log(`[tools] Edge version: ${version}`);

  if (fs.existsSync(driverPath)) {
    try {
      const signature = verifyMicrosoftSignature(driverPath);
      const v = execFileSync(driverPath, ['--version'], { encoding: 'utf8' });
      const majorEdge = version.split('.')[0];
      const majorDriver = (v.match(/(\d+)\./) || [])[1];
      if (majorDriver === majorEdge) {
        cleanupDownloadArtifacts();
        console.log(`[tools] Authenticode: ${signature.status} (${signature.subject})`);
        console.log(`[tools] Already have matching driver: ${v.trim()}`);
        console.log(`[tools] Path: ${driverPath}`);
        return;
      }
      console.log(`[tools] Existing driver major ${majorDriver || 'unknown'} does not match Edge ${majorEdge}.`);
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
    const majorEdge = version.split('.')[0];
    const majorDriver = (verOut.match(/(\d+)\./) || [])[1];
    if (majorDriver !== majorEdge) {
      throw new Error(
        `Downloaded driver major ${majorDriver || 'unknown'} does not match Edge ${majorEdge}`
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
