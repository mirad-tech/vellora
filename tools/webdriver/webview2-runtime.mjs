/** Shared Windows preflight for the existing desktop E2E tools. */
import { execFileSync } from 'node:child_process';

export function parseWindowsVersion(value) {
  return String(value).match(/\b(\d+\.\d+\.\d+\.\d+)\b/)?.[1] ?? null;
}

// Microsoft requires the first three version components to match. A driver's
// patch revision may differ from the installed WebView2 runtime's revision.
export function driverMatchesRuntime(driverVersion, runtimeVersion) {
  const driver = parseWindowsVersion(driverVersion);
  const runtime = parseWindowsVersion(runtimeVersion);
  return Boolean(driver && runtime && driver.split('.').slice(0, 3).join('.') ===
    runtime.split('.').slice(0, 3).join('.'));
}

export function selectWebView2Runtime(registrations) {
  const installed = (Array.isArray(registrations) ? registrations : [])
    .filter((entry) => typeof entry?.version === 'string' && typeof entry?.source === 'string' &&
      /^\d+\.\d+\.\d+\.\d+$/.test(entry.version.trim()))
    .map((entry) => ({ version: parseWindowsVersion(entry.version), source: entry.source }))
    .filter((entry) => entry.version && !/^0\./.test(entry.version));
  if (installed.length === 0) {
    throw new Error('Microsoft Edge WebView2 Runtime is not registered. Install the WebView2 Runtime before desktop E2E.');
  }
  if (new Set(installed.map((entry) => entry.version)).size !== 1) {
    throw new Error(`WebView2 registry versions disagree; cannot safely choose a driver: ${
      installed.map((entry) => `${entry.source} = ${entry.version}`).join('; ')
    }`);
  }
  return { version: installed[0].version, sources: installed.map((entry) => entry.source) };
}

export function readWebView2Runtime() {
  // Documented Runtime detection keys, covering 64-bit, 32-bit and per-user
  // installations. Full Edge's executable version is not the WebView2 version.
  // https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$runtimeKeys = @(
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
  'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
  'HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
)
$registrations = @()
foreach ($runtimeKey in $runtimeKeys) {
  $entry = Get-ItemProperty -LiteralPath $runtimeKey -Name pv -ErrorAction SilentlyContinue
  if ($null -ne $entry) {
    $registrations += [PSCustomObject]@{ version = [string]$entry.pv; source = $runtimeKey }
  }
}
ConvertTo-Json -InputObject $registrations -Compress
`;
  let registrations;
  try {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', windowsHide: true
    });
    registrations = JSON.parse(output.trim());
  } catch (error) {
    throw new Error(`Could not read the WebView2 Runtime registry version: ${error?.message || error}`);
  }
  return selectWebView2Runtime(registrations);
}

export function verifyMicrosoftSignature(target) {
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
      output = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', ps], {
        encoding: 'utf8', windowsHide: true
      });
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (output == null) {
    throw new Error(`Failed to verify msedgedriver Authenticode signature: ${lastError?.message || lastError}`);
  }
  let result;
  try {
    result = JSON.parse(output.trim());
  } catch (error) {
    throw new Error(`Invalid Authenticode verification output: ${error?.message || error}`);
  }
  const status = typeof result?.Status === 'string' ? result.Status : '';
  const subject = typeof result?.Subject === 'string' ? result.Subject : '';
  if (status !== 'Valid' || !subject.includes('Microsoft Corporation')) {
    throw new Error(`Rejected msedgedriver signature (status=${status || 'missing'}, subject=${subject || 'missing'})`);
  }
  return { status, subject };
}
