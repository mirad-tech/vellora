# Captures a top-level window to a PNG for visual verification.
#
# Usage:
#   pwsh -File native/tools/capture-window.ps1 -TitleLike "*Vellora*" -Out file.png

param(
  [string]$TitleLike = '',
  [string]$ProcessName = '',
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$DelayMilliseconds = 800
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Capture {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
}
"@

if ($ProcessName -ne '') {
  $process = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
} else {
  $process = Get-Process | Where-Object { $_.MainWindowTitle -like $TitleLike -and $_.MainWindowHandle -ne 0 } |
    Select-Object -First 1
}
if ($null -eq $process) { throw "no window matching $TitleLike$ProcessName" }

$handle = $process.MainWindowHandle
[void][Win32Capture]::ShowWindow($handle, 9)
[void][Win32Capture]::SetForegroundWindow($handle)
Start-Sleep -Milliseconds $DelayMilliseconds

$rect = New-Object Win32Capture+RECT
[void][Win32Capture]::GetWindowRect($handle, [ref]$rect)
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -le 0 -or $height -le 0) { throw "window has no area" }

$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
$bitmap.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()

Write-Host "captured $($process.MainWindowTitle) ${width}x${height} -> $Out"
