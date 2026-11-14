# Samples a process tree's private commit after a settle period.
#
# G1/G2 require: operate -> wait 30 s -> sample 10 times at 1 s -> judge by the
# worst steady-state sample. Peak is reported separately, never substituted for
# the steady-state value.
#
# Usage:
#   pwsh -File native/tools/measure-process.ps1 -Exe <path> [-Arguments <string>]
#        [-SettleSeconds 30] [-Samples 10] [-IntervalSeconds 1] [-Report <path>]

param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [string]$Arguments = '',
  [int]$SettleSeconds = 30,
  [int]$Samples = 10,
  [double]$IntervalSeconds = 1,
  [int]$PeakIntervalMilliseconds = 100,
  [string]$Report = ''
)

$ErrorActionPreference = 'Stop'

function Get-ProcessTree([int]$RootId) {
  $all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId
  $ids = [System.Collections.Generic.HashSet[int]]::new()
  [void]$ids.Add($RootId)
  $added = $true
  while ($added) {
    $added = $false
    foreach ($p in $all) {
      if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)) {
        [void]$ids.Add([int]$p.ProcessId)
        $added = $true
      }
    }
  }
  return $ids
}

function Get-TreeMetrics([System.Collections.Generic.HashSet[int]]$Ids) {
  $private = 0L
  $working = 0L
  foreach ($id in $Ids) {
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($null -ne $p) {
      $private += $p.PrivateMemorySize64
      $working += $p.WorkingSet64
    }
  }
  return [pscustomobject]@{ PrivateMiB = [math]::Round($private / 1MB, 2); WorkingMiB = [math]::Round($working / 1MB, 2) }
}

$startInfo = @{ FilePath = $Exe; PassThru = $true }
if ($Arguments -ne '') { $startInfo.ArgumentList = $Arguments.Split(' ') }
$process = Start-Process @startInfo
Write-Host "started pid=$($process.Id) exe=$Exe args=$Arguments"

Start-Sleep -Seconds 2
$ids = Get-ProcessTree $process.Id
Write-Host "process tree: $($ids -join ', ')"

# High-frequency peak sampling for the whole settle window.
$peak = 0.0
$samplesCollected = 0
$deadline = (Get-Date).AddSeconds($SettleSeconds)
while ((Get-Date) -lt $deadline) {
  $metrics = Get-TreeMetrics $ids
  if ($metrics.PrivateMiB -gt $peak) { $peak = $metrics.PrivateMiB }
  Start-Sleep -Milliseconds $PeakIntervalMilliseconds
  $samplesCollected++
}

$steady = @()
for ($i = 0; $i -lt $Samples; $i++) {
  $metrics = Get-TreeMetrics $ids
  $steady += $metrics.PrivateMiB
  Write-Host ("steady[{0}] private={1} MiB working={2} MiB" -f $i, $metrics.PrivateMiB, $metrics.WorkingMiB)
  Start-Sleep -Seconds $IntervalSeconds
}

$worst = ($steady | Measure-Object -Maximum).Maximum
$result = [pscustomobject]@{
  exe                = $Exe
  arguments          = $Arguments
  pid                = $process.Id
  settle_seconds     = $SettleSeconds
  steady_samples_mib = $steady
  steady_max_mib     = $worst
  steady_min_mib     = ($steady | Measure-Object -Minimum).Minimum
  peak_sample_mib    = [math]::Round($peak, 2)
  peak_samples       = $samplesCollected
}

Write-Host ("RESULT steady_max={0} MiB peak_sampled={1} MiB" -f $result.steady_max_mib, $result.peak_sample_mib)

if ($Report -ne '') {
  $result | ConvertTo-Json -Depth 4 | Set-Content -Path $Report -Encoding UTF8
  Write-Host "report written to $Report"
}

Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
Write-Output ($result | ConvertTo-Json -Depth 4 -Compress)
