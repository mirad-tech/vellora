# Build-only Qt distribution. Never runs Setup or changes installed applications.
param(
  [string]$Version = '0.1.7',
  [string]$QtRoot = $env:QT_ROOT,
  [string]$BuildRoot,
  [string]$CargoTargetDir,
  [string]$OutputDir,
  [string]$MsvcRoot = $env:VELLORA_MSVC_ROOT,
  [string]$WindowsSdkRoot = $env:WindowsSdkDir,
  [string]$MakeNsis,
  [bool]$RunTests = $true
)
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Version must be major.minor.patch.' }
$native = Split-Path -Parent $PSScriptRoot
if (!$QtRoot) { $QtRoot = Join-Path $native 'qt\6.8.3\msvc2022_64' }
$qtVersion = & (Join-Path $QtRoot 'bin\qmake.exe') -query QT_VERSION
if ($LASTEXITCODE -ne 0) { throw 'Could not query Qt version.' }
if (!$BuildRoot) { $BuildRoot = Join-Path $native 'target\qt-release' }
if (!$OutputDir) { $OutputDir = Join-Path $native ('target\qt-package-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
if (!$MakeNsis) { $MakeNsis = Join-Path $env:LOCALAPPDATA 'tauri\NSIS\makensis.exe' }
$BuildRoot = [IO.Path]::GetFullPath($BuildRoot)
$OutputDir = [IO.Path]::GetFullPath($OutputDir)
if (Test-Path -LiteralPath $OutputDir) { throw "Choose a new empty OutputDir; existing output is never deleted: $OutputDir" }
if (!(Test-Path -LiteralPath $MakeNsis)) { throw 'Set -MakeNsis to an already installed official NSIS makensis.exe.' }
$build = @{ QtRoot=$QtRoot; BuildRoot=$BuildRoot; EmitLegacyOutput=$false; Test=$RunTests }
if ($CargoTargetDir) { $build.CargoTargetDir=$CargoTargetDir }
if ($MsvcRoot) { $build.MsvcRoot=$MsvcRoot }
if ($WindowsSdkRoot) { $build.WindowsSdkRoot=$WindowsSdkRoot }
& (Join-Path $native 'qt-app\build.ps1') @build
$builtExe = Join-Path $BuildRoot 'app\vellora.exe'
$exeVersion = (Get-Item -LiteralPath $builtExe).VersionInfo
if ($exeVersion.FileMajorPart -ne ([version]$Version).Major -or
    $exeVersion.FileMinorPart -ne ([version]$Version).Minor -or
    $exeVersion.FileBuildPart -ne ([version]$Version).Build -or
    $exeVersion.FilePrivatePart -ne 0 -or $exeVersion.ProductName -ne 'Vellora') {
  throw "Built executable identity does not match Vellora $Version; refusing to label a mismatched package."
}
New-Item -ItemType Directory -Path $OutputDir | Out-Null
$portable = Join-Path $OutputDir "Vellora-$Version-portable"
New-Item -ItemType Directory -Path $portable | Out-Null
Copy-Item -LiteralPath (Join-Path $BuildRoot 'app\vellora.exe') -Destination $portable
& (Join-Path $QtRoot 'bin\windeployqt.exe') --release --concurrent --no-translations --no-system-d3d-compiler --no-opengl-sw --no-compiler-runtime (Join-Path $portable 'vellora.exe')
if ($LASTEXITCODE -ne 0) { throw "windeployqt failed: $LASTEXITCODE" }
# Deploy the official app-local MSVC runtime, not a machine-wide redistributable installer.
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$vs) { throw 'VS C++ redistributable runtime not found.' }
$redistRoot = Join-Path $vs 'VC\Redist\MSVC'
$redist = Get-ChildItem -LiteralPath $redistRoot -Directory | Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
$crt = Get-ChildItem -LiteralPath (Join-Path $redist.FullName 'x64') -Directory | Where-Object Name -Like 'Microsoft.VC*.CRT' | Select-Object -First 1
if (!$crt) { throw 'App-local x64 VC CRT not found.' }
Get-ChildItem -LiteralPath $crt.FullName -Filter '*.dll' -File | Copy-Item -Destination $portable
foreach ($required in @('vellora.exe','Qt6Core.dll','Qt6Concurrent.dll','Qt6Gui.dll','Qt6Widgets.dll','Qt6Svg.dll','Qt6Network.dll','platforms\qwindows.dll','imageformats\qwebp.dll','msvcp140.dll','vcruntime140.dll')) {
  if (!(Test-Path -LiteralPath (Join-Path $portable $required))) { throw "Missing portable dependency: $required" }
}
$licenses = Join-Path $portable 'licenses'
New-Item -ItemType Directory -Path $licenses | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'assets\LICENSE.txt') -Destination (Join-Path $licenses 'Vellora-MIT.txt')
Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'qt-licenses') -File | Copy-Item -Destination $licenses
# Preserve upstream SBOMs, copyright notices and embedded license texts from this exact Qt kit.
$sbomDir = Join-Path $licenses 'qt-sbom'
New-Item -ItemType Directory -Path $sbomDir | Out-Null
$notices = [Text.StringBuilder]::new()
foreach ($module in @('qtbase','qtsvg','qtimageformats')) {
  $file = Join-Path $QtRoot "sbom\$module-6.8.3.spdx.json"
  if (!(Test-Path -LiteralPath $file)) { throw "Required Qt module SBOM missing: $file" }
  Copy-Item -LiteralPath $file -Destination $sbomDir
  $sbom = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
  foreach ($license in $sbom.hasExtractedLicensingInfos) { [void]$notices.AppendLine("`n$module / $($license.licenseId)`n$($license.extractedText)") }
  foreach ($package in $sbom.packages) { [void]$notices.AppendLine("`n$module / $($package.name)`n$($package.copyrightText)`nLicense: $($package.licenseDeclared)`n$($package.downloadLocation)") }
}
$notices.ToString() | Set-Content -LiteralPath (Join-Path $licenses 'Qt-third-party-notices.txt') -Encoding utf8
# One user-facing note for the installed and the portable copy (UTF-8 with BOM for Notepad).
$readme = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'assets\README-dist.txt'), [Text.Encoding]::UTF8)
$readme = $readme.Replace('{VERSION}', $Version).Replace('{QT_VERSION}', $qtVersion)
[IO.File]::WriteAllText((Join-Path $portable 'README.txt'), $readme, [Text.UTF8Encoding]::new($true))
$uninstall = Join-Path $OutputDir 'uninstall-files.nsh'
$lines = @('; Only remove files shipped in this exact package; preserve unknown user files.')
$entries = Get-ChildItem -LiteralPath $portable -Recurse -File
foreach ($file in $entries) {
  $relative = $file.FullName.Substring($portable.Length + 1).Replace('$','$$')
  $lines += 'Delete "$INSTDIR\' + $relative + '"'
}
Get-ChildItem -LiteralPath $portable -Recurse -Directory | Sort-Object { $_.FullName.Length } -Descending | ForEach-Object {
  $relative = $_.FullName.Substring($portable.Length + 1).Replace('$','$$')
  $lines += 'RMDir "$INSTDIR\' + $relative + '"'
}
$lines | Set-Content -LiteralPath $uninstall -Encoding utf8
Push-Location $PSScriptRoot
try {
  & $MakeNsis "/DAPP_VERSION=$Version" "/DSOURCE_DIR=$portable" "/DOUT_DIR=$OutputDir" "/DUNINSTALL_LIST=$uninstall" 'vellora-qt-preview.nsi'
  if ($LASTEXITCODE -ne 0) { throw "NSIS build failed: $LASTEXITCODE" }
} finally { Pop-Location }
$setup = Join-Path $OutputDir "Vellora-Setup-$Version.exe"
$setupVersion = (Get-Item -LiteralPath $setup).VersionInfo
if ($setupVersion.ProductName -ne 'Vellora' -or $setupVersion.ProductVersion -ne $Version -or
    $setupVersion.FileMajorPart -ne ([version]$Version).Major -or
    $setupVersion.FileMinorPart -ne ([version]$Version).Minor -or
    $setupVersion.FileBuildPart -ne ([version]$Version).Build -or $setupVersion.FilePrivatePart -ne 0) {
  throw 'Installer version identity verification failed.'
}
# The setup and its uninstall list were built from $portable, which must stay
# unmarked. Only this separate copy becomes portable, after NSIS has finished.
if (Test-Path -LiteralPath (Join-Path $portable 'portable.txt')) { throw 'The installer source must not contain portable.txt.' }
$zipStage = Join-Path $OutputDir 'portable-zip-stage'
$zipRoot = Join-Path $zipStage "Vellora-$Version-portable"
New-Item -ItemType Directory -Path $zipStage | Out-Null
Copy-Item -LiteralPath $portable -Destination $zipRoot -Recurse
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'assets\portable.txt') -Destination $zipRoot
$zip = Join-Path $OutputDir "Vellora-$Version-portable-x64.zip"
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$zipFiles = @(Get-ChildItem -LiteralPath $zipRoot -Recurse -File | Sort-Object FullName)
$archive = [IO.Compression.ZipFile]::Open($zip, [IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($file in $zipFiles) {
    # Forward slashes, whatever PowerShell runs this: every unzip tool reads them as folders.
    $name = "Vellora-$Version-portable/" + $file.FullName.Substring($zipRoot.Length + 1).Replace('\', '/')
    [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, $name, [IO.Compression.CompressionLevel]::Optimal)
  }
} finally { $archive.Dispose() }
$zipCheck = [IO.Compression.ZipFile]::OpenRead($zip)
try { $zipNames = @($zipCheck.Entries | ForEach-Object FullName) } finally { $zipCheck.Dispose() }
if ($zipNames.Count -ne ($entries.Count + 1) -or $zipNames -notcontains "Vellora-$Version-portable/portable.txt") {
  throw 'Portable zip verification failed.'
}
Remove-Item -LiteralPath $zipStage -Recurse
$manifest = [ordered]@{
  product='Vellora'; version=$Version; qt_version=$qtVersion; built_at=(Get-Date).ToUniversalTime().ToString('o')
  portable_dir=$portable; setup=$setup; setup_bytes=(Get-Item -LiteralPath $setup).Length
  setup_sha256=(Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash
  portable_zip=$zip; portable_zip_bytes=(Get-Item -LiteralPath $zip).Length
  portable_zip_sha256=(Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
  app_sha256=(Get-FileHash -LiteralPath (Join-Path $portable 'vellora.exe') -Algorithm SHA256).Hash
  files=@($entries | ForEach-Object { @{ path=$_.FullName.Substring($portable.Length+1); bytes=$_.Length; sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash } })
  installed=$false; published=$false; test_hooks_enabled=$false; test_app_included=$false; build_variant='production app; separate test-app excluded'
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $OutputDir 'manifest.json') -Encoding utf8
Write-Host "Portable: $portable"
Write-Host "Portable zip: $zip"
Write-Host "Setup (not executed): $setup"

