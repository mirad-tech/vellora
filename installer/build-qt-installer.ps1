# Builds the Qt shell and packages it with the Qt runtime (per-user installer).
#
# Usage:
#   pwsh -File native/installer/build-qt-installer.ps1 [-Version 0.2.0]

param(
  [string]$Version = '0.2.0'
)

$ErrorActionPreference = 'Stop'
$native = Split-Path -Parent $PSScriptRoot
$project = Join-Path $native 'qt-app'
$qtRoot = Join-Path $native 'qt\6.8.3\msvc2022_64'
$dist = Join-Path $project 'dist'

Write-Host '== build Qt shell =='
& (Join-Path $project 'build.ps1')
if ($LASTEXITCODE -ne 0 -and $null -ne $LASTEXITCODE) { throw "Qt build failed: $LASTEXITCODE" }

$exe = Join-Path $project 'vellora.exe'
if (-not (Test-Path $exe)) { throw "missing $exe" }

Write-Host '== deploy Qt runtime =='
if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dist | Out-Null
Copy-Item $exe $dist
& (Join-Path $qtRoot 'bin\windeployqt.exe') --release --no-translations --no-system-d3d-compiler --no-opengl-sw (Join-Path $dist 'vellora.exe') | Out-Null
if ($LASTEXITCODE -ne 0) { throw "windeployqt failed: $LASTEXITCODE" }

$bytes = (Get-ChildItem $dist -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host ("runtime files: {0}, {1:N1} MB" -f (Get-ChildItem $dist -Recurse -File).Count, ($bytes / 1MB))

Write-Host '== package =='
$makensis = Join-Path $env:LOCALAPPDATA 'tauri\NSIS\makensis.exe'
if (-not (Test-Path $makensis)) { throw 'makensis.exe not found' }
Push-Location $PSScriptRoot
try {
  & $makensis "/DAPP_VERSION=$Version" "/DSOURCE_DIR=$dist" '/DOUT_DIR=out' 'vellora-qt.nsi'
  if ($LASTEXITCODE -ne 0) { throw "makensis failed: $LASTEXITCODE" }
}
finally {
  Pop-Location
}

$setup = Join-Path $PSScriptRoot "out\VelloraQt-Setup-$Version.exe"
if (-not (Test-Path $setup)) { throw "missing $setup" }
$manifest = [ordered]@{
  product      = 'Vellora (Qt Preview)'
  version      = $Version
  setup        = $setup
  setup_bytes  = (Get-Item $setup).Length
  setup_sha256 = (Get-FileHash $setup -Algorithm SHA256).Hash
  exe_sha256   = (Get-FileHash $exe -Algorithm SHA256).Hash
  qt_runtime   = 'Qt 6.8.3 msvc2022_64'
  built_at     = (Get-Date).ToString('s')
}
$manifest | ConvertTo-Json | Set-Content -Path (Join-Path $PSScriptRoot "out\VelloraQt-Setup-$Version.json") -Encoding UTF8
Write-Host ("installer: {0} ({1:N0} bytes)" -f $setup, (Get-Item $setup).Length)
Write-Host ("sha256: {0}" -f $manifest.setup_sha256)
