# Generates fixed-seed PNG fixtures for image-pipeline memory benchmarks.
# Large images retain the 5..10 MiB encoded-size requirement.
param(
  [string]$OutputDir = (Join-Path (Split-Path -Parent $PSScriptRoot) 'tests\fixtures\performance'),
  [switch]$Force,
  [ValidateSet('Large','Picture81','All')][string]$ImageSet = 'Large'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$specs = @()
if ($ImageSet -in @('Large','All')) {
  $specs += @(
    @{ Name = 'large-image-001.png'; Width = 1920; Height = 1200; Seed = 1001 },
    @{ Name = 'large-image-002.png'; Width = 1920; Height = 1280; Seed = 1002 },
    @{ Name = 'large-image-003.png'; Width = 1920; Height = 1360; Seed = 1003 },
    @{ Name = 'large-image-004.png'; Width = 1920; Height = 1440; Seed = 1004 },
    @{ Name = 'large-image-005.png'; Width = 1920; Height = 1500; Seed = 1005 },
    @{ Name = 'large-image-006.png'; Width = 1920; Height = 1560; Seed = 1006 }
  )
}
if ($ImageSet -in @('Picture81','All')) {
  $specs += @(1..81 | ForEach-Object {
    @{ Name = ('picture-{0:D3}.png' -f $_); Width = 128; Height = 128; Seed = 2000 + $_ }
  })
}

$minBytes = 5L * 1024 * 1024
$maxBytes = 10L * 1024 * 1024 - 65536

foreach ($spec in $specs) {
  $target = Join-Path $OutputDir $spec.Name
  $isPicture = $spec.Name.StartsWith('picture-')
  if (!$isPicture -and !$Force -and (Test-Path -LiteralPath $target)) {
    $existing = (Get-Item -LiteralPath $target).Length
    if ($existing -ge $minBytes -and $existing -le $maxBytes) {
      continue
    }
  }

  $width = [int]$spec.Width
  $height = [int]$spec.Height
  $rng = [System.Random]::new([int]$spec.Seed)
  $pixelFormat = if ($isPicture) { [System.Drawing.Imaging.PixelFormat]::Format32bppArgb } else { [System.Drawing.Imaging.PixelFormat]::Format24bppRgb }
  $bitmap = [System.Drawing.Bitmap]::new($width, $height, $pixelFormat)
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
  $minimum = if ($isPicture) { 1L } else { $minBytes }
  if ($length -lt $minimum -or $length -gt $maxBytes) {
    throw "Generated $($spec.Name) size $length bytes is outside the expected $minimum..$maxBytes range."
  }
  Write-Host ("Generated {0}: {1} MiB ({2} bytes)" -f $spec.Name, [math]::Round($length / 1MB, 2), $length)
}
