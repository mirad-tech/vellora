# Unified formatting, static analysis, release-profile guard, and test runner.
param(
  [switch]$Full
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$manifest = Join-Path $repoRoot 'Cargo.toml'

function Assert-ReleaseUnwindProfile([string]$TomlPath) {
  $lines = Get-Content -LiteralPath $TomlPath -Encoding UTF8
  $section = ''
  $lineNumber = 0
  foreach ($rawLine in $lines) {
    $lineNumber++
    $line = ($rawLine -replace '#.*$', '').Trim()
    if (!$line) { continue }
    if ($line -match '^\[([^\]]+)\]$') {
      $section = $Matches[1].Trim()
      continue
    }
    if ($section -match '^profile\.(release|bench)(\.|$)' -and $line -match '^panic\s*=\s*["'']abort["'']') {
      throw "Release profile must unwind across FFI so catch_unwind works; found panic = `"abort`" at ${TomlPath}:${lineNumber}"
    }
  }
}

Write-Host '==> [1/5] Checking Rust formatting (cargo fmt --check)...'
& cargo fmt --manifest-path $manifest --all -- --check
if ($LASTEXITCODE -ne 0) { throw "cargo fmt --check failed: $LASTEXITCODE" }

Write-Host '==> [2/5] Running Clippy (cargo clippy -- -D warnings)...'
& cargo clippy --manifest-path $manifest --workspace --all-targets --locked -- -D warnings
if ($LASTEXITCODE -ne 0) { throw "cargo clippy failed: $LASTEXITCODE" }

Write-Host '==> [3/5] Verifying release panic unwind policy...'
foreach ($rel in @('Cargo.toml', 'core\Cargo.toml', 'md\Cargo.toml', 'bridge\Cargo.toml')) {
  Assert-ReleaseUnwindProfile (Join-Path $repoRoot $rel)
}

# Static guards for the installer and the portable zip, e.g. that portable.txt
# never reaches the installed copy. They read files only and need tomllib (3.11+).
Write-Host '==> [4/5] Checking release packaging rules and UI translations...'
$python = Get-Command python -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (!$python) { throw 'Python 3.11 or newer is required on PATH for the release packaging rules.' }
& $python.Source -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)'
if ($LASTEXITCODE -ne 0) { throw "Python 3.11 or newer is required for the release packaging rules: $($python.Source)" }
& $python.Source (Join-Path $repoRoot 'installer\tests\test_release_policy.py')
if ($LASTEXITCODE -ne 0) { throw "Release packaging rules failed: $LASTEXITCODE" }
# Every interface string has its English translation (qt-app/translations).
& $python.Source (Join-Path $repoRoot 'tools\check_translations.py')
if ($LASTEXITCODE -ne 0) { throw "English translation check failed: $LASTEXITCODE" }

if ($Full) {
  Write-Host '==> [5/5] Building and running full Rust + Qt regression suites...'
  $oldQtRoot = $env:QT_ROOT
  try {
    if (!$env:QT_ROOT -and $env:QT_ROOT_DIR) {
      $env:QT_ROOT = $env:QT_ROOT_DIR
    }
    & (Join-Path $repoRoot 'qt-app\build.ps1') -Test -EmitLegacyOutput $false
  } finally {
    $env:QT_ROOT = $oldQtRoot
  }
} else {
  Write-Host '==> [5/5] Running Rust workspace tests...'
  & cargo test --manifest-path $manifest --workspace --locked
  if ($LASTEXITCODE -ne 0) { throw "cargo test failed: $LASTEXITCODE" }
}

Write-Host 'All checks passed.'
