param([Parameter(Mandatory=$true)][string]$OutputDir)
$ErrorActionPreference = 'Stop'
$OutputDir = [IO.Path]::GetFullPath($OutputDir)
if (Test-Path -LiteralPath $OutputDir) { throw 'Use a fresh regression output directory.' }
New-Item -ItemType Directory -Path $OutputDir | Out-Null
. (Join-Path $PSScriptRoot 'perf-fixtures.ps1')
$generator = Join-Path $PSScriptRoot 'make-perf-images.ps1'
$markdown = Join-Path (Split-Path -Parent $PSScriptRoot) 'tests/fixtures/performance/images-81.md'
$checks = [Collections.Generic.List[string]]::new()
function Expect-Failure([scriptblock]$Action, [string]$Message) {
  $failed = $false
  try { & $Action }
  catch {
    if (!$_.Exception.Message.Contains($Message)) { throw }
    $failed = $true
  }
  if (!$failed) { throw "Expected fixture failure containing: $Message" }
}

foreach ($name in @('first','second')) {
  $dir = Join-Path $OutputDir $name
  & $generator -OutputDir $dir -ImageSet Picture81 6>$null
  Copy-Item -LiteralPath $markdown -Destination $dir
  Assert-Picture81Fixtures -FixtureDir $dir
  if (@(Get-ChildItem -LiteralPath $dir -Filter '*.png' -File).Count -ne 81) { throw 'Picture81 must generate exactly 81 PNG files.' }
  foreach ($file in Get-ChildItem -LiteralPath $dir -Filter '*.png' -File) {
    $image = [Drawing.Image]::FromFile($file.FullName)
    try {
      if ($image.PixelFormat -ne [Drawing.Imaging.PixelFormat]::Format32bppArgb) { throw "Unexpected pixel format: $($file.Name)" }
    } finally { $image.Dispose() }
  }
}
$first = Join-Path $OutputDir 'first'
$second = Join-Path $OutputDir 'second'
foreach ($file in Get-ChildItem -LiteralPath $first -Filter '*.png' -File) {
  if ((Get-FileHash -LiteralPath $file.FullName).Hash -ne (Get-FileHash -LiteralPath (Join-Path $second $file.Name)).Hash) { throw "Non-deterministic PNG: $($file.Name)" }
}
$checks.Add('Two clean Picture81 generations decode, match all references/specifications and have identical SHA256s.')

$missing = Join-Path $second 'picture-001.png'
Remove-Item -LiteralPath $missing
Expect-Failure { Assert-Picture81Fixtures -FixtureDir $second } 'Missing picture fixture:'
Copy-Item -LiteralPath (Join-Path $first 'picture-001.png') -Destination $missing
[IO.File]::WriteAllText((Join-Path $second 'picture-002.png'), 'not a PNG')
Expect-Failure { Assert-Picture81Fixtures -FixtureDir $second } 'Cannot decode picture fixture'
$checks.Add('Missing and corrupt image fixtures explicitly fail validation.')

foreach ($set in @('Large','All')) {
  $dir = Join-Path $OutputDir $set
  & $generator -OutputDir $dir -ImageSet $set 6>$null
  $files = @(Get-ChildItem -LiteralPath $dir -Filter 'large-image-*.png' -File | Sort-Object Name)
  if ($files.Count -ne 6) { throw "$set must generate six large images." }
  $heights = @(1200,1280,1360,1440,1500,1560)
  for ($index = 0; $index -lt 6; $index++) {
    $file = $files[$index]
    $image = [Drawing.Image]::FromFile($file.FullName)
    try {
      if ($image.RawFormat.Guid -ne [Drawing.Imaging.ImageFormat]::Png.Guid -or $image.Width -ne 1920 -or $image.Height -ne $heights[$index] -or $image.PixelFormat -ne [Drawing.Imaging.PixelFormat]::Format24bppRgb -or $file.Length -lt 5MB -or $file.Length -gt (10MB - 65536)) { throw "Invalid large image: $($file.Name)" }
    } finally { $image.Dispose() }
  }
  if ($set -eq 'All') {
    Copy-Item -LiteralPath $markdown -Destination $dir
    Assert-Picture81Fixtures -FixtureDir $dir
    if (@(Get-ChildItem -LiteralPath $dir -Filter '*.png' -File).Count -ne 87) { throw 'All must generate 87 PNG files.' }
    foreach ($file in $files) {
      if ((Get-FileHash -LiteralPath $file.FullName).Hash -ne (Get-FileHash -LiteralPath (Join-Path (Join-Path $OutputDir 'Large') $file.Name)).Hash) { throw "All changed the large image seed/specification: $($file.Name)" }
    }
  }
}
$checks.Add('Large and All retain six 24-bit 1920-wide PNGs, their expected heights, size limits and matching hashes; All also validates 81 pictures.')
$checks | ForEach-Object { Write-Host "PASS: $_" }
@{passed=$true;checks=@($checks);output_dir=$OutputDir} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDir 'results.json') -Encoding utf8
