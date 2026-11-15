function Assert-Picture81Fixtures {
  param([Parameter(Mandatory=$true)][string]$FixtureDir)

  Add-Type -AssemblyName System.Drawing
  $markdownPath = Join-Path $FixtureDir 'images-81.md'
  $markdown = Get-Content -LiteralPath $markdownPath -Raw -ErrorAction Stop
  $references = @([regex]::Matches($markdown, '!\[[^\]]*\]\(([^)\s]+)\)') | ForEach-Object { $_.Groups[1].Value -replace '^\./', '' })
  $expected = @(1..81 | ForEach-Object { 'picture-{0:D3}.png' -f $_ })
  if ($references.Count -ne 81 -or (@($references | Sort-Object) -join ',') -ne ($expected -join ',')) {
    throw "$markdownPath must reference picture-001.png through picture-081.png exactly once."
  }
  foreach ($name in $references) {
    $path = Join-Path $FixtureDir $name
    if (!(Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing picture fixture: $path" }
    $length = (Get-Item -LiteralPath $path).Length
    if ($length -le 0 -or $length -gt 10MB) { throw "Invalid encoded picture fixture size: $path ($length bytes)" }
    try { $image = [Drawing.Image]::FromFile($path) }
    catch { throw "Cannot decode picture fixture ${path}: $($_.Exception.Message)" }
    try {
      if ($image.RawFormat.Guid -ne [Drawing.Imaging.ImageFormat]::Png.Guid -or $image.Width -ne 128 -or $image.Height -ne 128) {
        throw "Picture fixture must be a 128x128 PNG: $path"
      }
    } finally { $image.Dispose() }
  }
}
