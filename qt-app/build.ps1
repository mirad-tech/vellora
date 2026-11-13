# Build Rust first, then the Qt shell and optional event-driven regressions.
# Requires an existing Qt MSVC kit, Rust MSVC, VS C++ tools and Windows SDK.
param(
  [switch]$Debug,
  [switch]$Clean,
  [switch]$Test,
  [string]$QtRoot = $env:QT_ROOT,
  [string]$MsvcRoot = $env:VELLORA_MSVC_ROOT,
  [string]$WindowsSdkRoot = $env:WindowsSdkDir,
  [string]$BuildRoot,
  [string]$CargoTargetDir,
  [bool]$EmitLegacyOutput = $true
)
$ErrorActionPreference = 'Stop'
$project = $PSScriptRoot
$native = Split-Path -Parent $project
$spec = if ($Debug) { 'debug' } else { 'release' }
if (!$QtRoot) { $QtRoot = Join-Path $native 'qt\6.8.3\msvc2022_64' }
if (!$BuildRoot) { $BuildRoot = Join-Path $native "target\qt-$spec" }
if (!$CargoTargetDir) { $CargoTargetDir = Join-Path $native 'target' }
$BuildRoot = [IO.Path]::GetFullPath($BuildRoot)
$CargoTargetDir = [IO.Path]::GetFullPath($CargoTargetDir)
if (!(Test-Path -LiteralPath (Join-Path $QtRoot 'bin\qmake.exe'))) { throw "Qt qmake not found: $QtRoot" }
if (!$MsvcRoot) {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (!(Test-Path -LiteralPath $vswhere)) { throw 'Set -MsvcRoot to VC\Tools\MSVC or a version directory.' }
  $vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if (!$vs) { throw 'No Visual Studio C++ x64 toolchain found.' }
  $MsvcRoot = Join-Path $vs 'VC\Tools\MSVC'
}
if (Test-Path -LiteralPath (Join-Path $MsvcRoot 'bin\Hostx64\x64\cl.exe')) { $msvc = Get-Item -LiteralPath $MsvcRoot }
else { $msvc = Get-ChildItem -LiteralPath $MsvcRoot -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'bin\Hostx64\x64\cl.exe') } | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1 }
if (!$msvc) { throw "MSVC not found: $MsvcRoot" }
if (!$WindowsSdkRoot) { $WindowsSdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10' }
$sdk = Get-ChildItem -LiteralPath (Join-Path $WindowsSdkRoot 'Lib') -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'um\x64\kernel32.lib') } | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
if (!$sdk) { throw "Windows SDK not found: $WindowsSdkRoot" }
$env:PATH = "$(Join-Path $msvc.FullName 'bin\Hostx64\x64');$(Join-Path $WindowsSdkRoot "bin\$($sdk.Name)\x64");$QtRoot\bin;$env:PATH"
$env:INCLUDE = @((Join-Path $msvc.FullName 'include'), (Join-Path $WindowsSdkRoot "Include\$($sdk.Name)\ucrt"), (Join-Path $WindowsSdkRoot "Include\$($sdk.Name)\shared"), (Join-Path $WindowsSdkRoot "Include\$($sdk.Name)\um")) -join ';'
$env:LIB = @((Join-Path $msvc.FullName 'lib\x64'), (Join-Path $WindowsSdkRoot "Lib\$($sdk.Name)\ucrt\x64"), (Join-Path $WindowsSdkRoot "Lib\$($sdk.Name)\um\x64")) -join ';'
$env:CARGO_TARGET_DIR = $CargoTargetDir
Write-Host "Qt: $QtRoot; MSVC: $($msvc.FullName); SDK: $($sdk.Name); output: $BuildRoot"
$cargoArgs = @('build', '--manifest-path', (Join-Path $native 'Cargo.toml'), '--locked', '-p', 'vellora-bridge')
if (!$Debug) { $cargoArgs += '--release' }
& cargo @cargoArgs
if ($LASTEXITCODE -ne 0) { throw "Rust bridge build failed: $LASTEXITCODE" }
$bridge = Join-Path $CargoTargetDir $spec
if (!(Test-Path -LiteralPath (Join-Path $bridge 'vellora_bridge.lib'))) { throw "Missing newly built bridge: $bridge" }
if ($Test) {
  & cargo test --manifest-path (Join-Path $native 'Cargo.toml') --locked -p vellora-core -p vellora-md -p vellora-bridge
  if ($LASTEXITCODE -ne 0) { throw "Rust regressions failed: $LASTEXITCODE" }
}
function Build-QtProject([string]$Pro, [string]$Output, [bool]$TestHooks = $false) {
  New-Item -ItemType Directory -Force -Path $Output | Out-Null
  Push-Location $Output
  try {
    # Let the generated makefile clean only its own outputs. Never glob sources.
    if ($Clean -and (Test-Path -LiteralPath 'Makefile')) {
      & nmake /NOLOGO clean
      if ($LASTEXITCODE -ne 0) { throw "Qt clean failed: $LASTEXITCODE" }
    }
    $defines = if ($TestHooks) { 'DEFINES+=VELLORA_ENABLE_TEST_HOOKS' } else { 'DEFINES-=VELLORA_ENABLE_TEST_HOOKS' }
    & (Join-Path $QtRoot 'bin\qmake.exe') $Pro $defines "CONFIG+=$spec" 'CONFIG-=debug_and_release' "BRIDGE_DIR=$($bridge.Replace('\','/'))"
    if ($LASTEXITCODE -ne 0) { throw "qmake failed: $LASTEXITCODE" }
    & nmake /NOLOGO
    if ($LASTEXITCODE -ne 0) { throw "Qt build failed: $LASTEXITCODE" }
  } finally { Pop-Location }
}
Build-QtProject (Join-Path $project 'vellora.pro') (Join-Path $BuildRoot 'app')
$exe = Join-Path $BuildRoot 'app\vellora.exe'
if (!(Test-Path -LiteralPath $exe)) { throw "Missing built app: $exe" }
# Retain the installer script's established input path, never use it as input.
if ($EmitLegacyOutput) { Copy-Item -LiteralPath $exe -Destination (Join-Path $project 'vellora.exe') -Force }
if ($Test) {
  Build-QtProject (Join-Path $project 'vellora.pro') (Join-Path $BuildRoot 'test-app') $true
  $suites = @(
    @{ Project = 'regressions'; Output = 'tests'; Exe = 'vellora-regressions' },
    @{ Project = 'accessibility_regressions'; Output = 'accessibility-tests'; Exe = 'vellora-accessibility-regressions' },
    @{ Project = 'serialization_regressions'; Output = 'serialization-tests'; Exe = 'vellora-serialization-regressions' },
    @{ Project = 'code_copy_regressions'; Output = 'code-copy-tests'; Exe = 'vellora-code-copy-regressions' },
    @{ Project = 'conflict_regressions'; Output = 'conflict-tests'; Exe = 'vellora-conflict-regressions' },
    @{ Project = 'feedback_document_regressions'; Output = 'feedback-document-tests'; Exe = 'vellora-feedback-document-regressions' },
    @{ Project = 'focused_ui_feedback'; Output = 'focused-ui-tests'; Exe = 'vellora-focused-ui-feedback' },
    @{ Project = 'parity_document_regressions'; Output = 'parity-document-tests'; Exe = 'vellora-parity-document-regressions' },
    @{ Project = 'chrome_accessibility_regressions'; Output = 'chrome-accessibility-tests'; Exe = 'vellora-chrome-accessibility-regressions' },
    @{ Project = 'chrome_ui_regressions'; Output = 'chrome-ui-tests'; Exe = 'vellora-chrome-ui-regressions' },
    @{ Project = 'highlight_parity'; Output = 'highlight-parity-tests'; Exe = 'vellora-highlight-parity' },
    @{ Project = 'body_layout_regressions'; Output = 'body-layout-tests'; Exe = 'vellora-body-layout-regressions' },
    @{ Project = 'ime_raw_regressions'; Output = 'ime-raw-tests'; Exe = 'vellora-ime-raw-regressions' },
    @{ Project = 'fidelity_regressions'; Output = 'fidelity-tests'; Exe = 'vellora-fidelity-regressions' }
  )
  foreach ($suite in $suites) {
    Build-QtProject (Join-Path $project ("tests\" + $suite.Project + '.pro')) (Join-Path $BuildRoot $suite.Output)
  }
  $oldPlatform = $env:QT_QPA_PLATFORM
  $oldFontDir = $env:QT_QPA_FONTDIR
  try {
    $env:QT_QPA_PLATFORM = 'offscreen'
    if (!$env:QT_QPA_FONTDIR -and $env:WINDIR) { $env:QT_QPA_FONTDIR = Join-Path $env:WINDIR 'Fonts' }
    $failedSuites = @()
    foreach ($suite in $suites) {
      $output = Join-Path $BuildRoot $suite.Output
      & (Join-Path $output ($suite.Exe + '.exe')) -o "$(Join-Path $output 'results.xml'),junitxml" -o "$(Join-Path $output 'results.txt'),txt"
      $suiteExit = $LASTEXITCODE
      if (Test-Path -LiteralPath (Join-Path $output 'results.txt')) { Get-Content -LiteralPath (Join-Path $output 'results.txt') }
      if ($suiteExit -ne 0) { $failedSuites += "$($suite.Project): $suiteExit" }
    }
    if ($failedSuites.Count) { throw ("Qt regressions failed: " + ($failedSuites -join '; ')) }
  } finally { $env:QT_QPA_PLATFORM = $oldPlatform; $env:QT_QPA_FONTDIR = $oldFontDir }
}
Write-Host "Built: $exe"
