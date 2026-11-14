# Generates deterministic high-entropy PNG fixtures (5-9.5 MiB each, below the
# 10 MiB local image cap) for image-pipeline peak memory benchmarking.
param(
  [string]$OutputDir = (Join-Path (Split-Path -Parent $PSScriptRoot) 'tests\fixtures\performance'),
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$specs = @(
  @{ Name = 'large-image-001.png'; Width = 1920; Height = 1200; Seed = 1001 },
  @{ Name = 'large-image-002.png'; Width = 1920; Height = 1280; Seed = 1002 },
  @{ Name = 'large-image-003.png'; Width = 1920; Height = 1360; Seed = 1003 },
  @{ Name = 'large-image-004.png'; Width = 1920; Height = 1440; Seed = 1004 },
  @{ Name = 'large-image-005.png'; Width = 1920; Height = 1500; Seed = 1005 },
  @{ Name = 'large-image-006.png'; Width = 1920; Height = 1560; Seed = 1006 }
)

$minBytes = 5L * 1024 * 1024
$maxBytes = 10L * 1024 * 1024 - 65536

foreach ($spec in $specs) {
  $target = Join-Path $OutputDir $spec.Name
  if (!$Force -and (Test-Path -LiteralPath $target)) {
    $existing = (Get-Item -LiteralPath $target).Length
    if ($existing -ge $minBytes -and $existing -le $maxBytes) {
      continue
    }
  }

  $width = [int]$spec.Width
  $height = [int]$spec.Height
  $rng = [System.Random]::new([int]$spec.Seed)
  $bitmap = [System.Drawing.Bitmap]::new($width, $height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  try {
    $rect = [System.Drawing.Rectangle]::new(0, 0, $width, $height)
    $lock = $bitmap.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::WriteOnly, $bitmap.PixelFormat)
    try {
      $totalBytes = [Math]::Abs($lock.Stride) * $height
      $buffer = [byte[]]::new($totalBytes)
      $rng.NextBytes($buffer)
      [System.Runtime.InteropServices.Marshal]::Copy($buffer, 0, $lock.Scan0, $totalBytes)
    } finally {
      $bitmap.UnlockBits($lock)
    }
    $bitmap.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $bitmap.Dispose()
  }

  $length = (Get-Item -LiteralPath $target).Length
  if ($length -lt $minBytes -or $length -gt $maxBytes) {
    throw "Generated $($spec.Name) size $length bytes is outside the expected 5..10 MiB range."
  }
  Write-Host ("Generated {0}: {1} MiB ({2} bytes)" -f $spec.Name, [math]::Round($length / 1MB, 2), $length)
}
