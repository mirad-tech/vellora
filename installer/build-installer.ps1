# Builds the per-user preview installer.
#
# Requires: Rust MSVC toolchain and NSIS (the copy bundled with the Tauri CLI at
# %LOCALAPPDATA%\tauri\NSIS is used when makensis is not on PATH).
#
# Usage:
#   pwsh -File native/installer/build-installer.ps1 [-Version 0.1.0]

param(
  [string]$Version = '0.1.0'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$native = Join-Path $root 'native'
$installer = $PSScriptRoot

function Find-Makensis {
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'tauri\NSIS\makensis.exe'),
    'C:\Program Files (x86)\NSIS\makensis.exe',
    'C:\Program Files\NSIS\makensis.exe'
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) { return $candidate }
  }
  $onPath = Get-Command makensis.exe -ErrorAction SilentlyContinue
  if ($null -ne $onPath) { return $onPath.Source }
  throw 'makensis.exe not found'
}

Push-Location $native
try {
  Write-Host '== cargo build --release =='
  cargo build --release
  if ($LASTEXITCODE -ne 0) { throw "cargo build failed: $LASTEXITCODE" }

  $exe = Join-Path $native 'target\release\vellora-native.exe'
  if (-not (Test-Path $exe)) { throw "missing $exe" }
  $exeHash = (Get-FileHash $exe -Algorithm SHA256).Hash
  Write-Host "exe: $exe"
  Write-Host "exe sha256: $exeHash"

  $outDir = Join-Path $installer 'out'
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null

  $makensis = Find-Makensis
  Write-Host "== $makensis =="
  Push-Location $installer
  try {
    & $makensis "/DAPP_VERSION=$Version" "/DOUT_DIR=out" 'vellora-native.nsi'
  }
  finally {
    Pop-Location
  }
  if ($LASTEXITCODE -ne 0) { throw "makensis failed: $LASTEXITCODE" }

  $setup = Join-Path $outDir "VelloraNative-Setup-$Version.exe"
  if (-not (Test-Path $setup)) { throw "missing $setup" }
  $setupHash = (Get-FileHash $setup -Algorithm SHA256).Hash
  $size = (Get-Item $setup).Length

  $manifest = [ordered]@{
    product      = 'Vellora Native (Preview)'
    version      = $Version
    setup        = $setup
    setup_bytes  = $size
    setup_sha256 = $setupHash
    exe_sha256   = $exeHash
    built_at     = (Get-Date).ToString('s')
    rustc        = (& rustc --version)
  }
  $manifestPath = Join-Path $outDir "VelloraNative-Setup-$Version.json"
  $manifest | ConvertTo-Json | Set-Content -Path $manifestPath -Encoding UTF8
  Write-Host "installer: $setup ($size bytes)"
  Write-Host "sha256: $setupHash"
  Write-Host "manifest: $manifestPath"
}
finally {
  Pop-Location
}
