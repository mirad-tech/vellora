# Read-only sampling of an explicitly verified, already visible test process.
param([Parameter(Mandatory=$true)][int]$ProcessId,[Parameter(Mandatory=$true)][string]$Executable,[Parameter(Mandatory=$true)][string]$OutputDir,[Parameter(Mandatory=$true)][string]$Stage,[Parameter(Mandatory=$true)][int]$Run,[string]$ExpectedTitle='Vellora',[string]$ModeEvidence='unverified; title identifies window only',[string]$UiEvidencePath)
$ErrorActionPreference='Stop'
$Executable=(Resolve-Path -LiteralPath $Executable).Path;$OutputDir=(Resolve-Path -LiteralPath $OutputDir).Path
Add-Type -Path (Join-Path $PSScriptRoot 'perf-window.cs')
$p=Get-Process -Id $ProcessId;if($p.Path -ne $Executable){throw 'Owned process path mismatch'}
function Convert-ObservationTime($Value) {
 if($Value -is [DateTimeOffset]){return $Value.ToUniversalTime()}
 if($Value -is [DateTime]){
  if($Value.Kind-eq [DateTimeKind]::Unspecified){throw 'CUA timestamp has no timezone'}
  return [DateTimeOffset]::new($Value.ToUniversalTime())
 }
 $text=[string]$Value
 if($text-notmatch '(?:[zZ]|[+-]\d{2}:\d{2})$'){throw 'CUA timestamp must include Z or an explicit UTC offset'}
 return [DateTimeOffset]::Parse($text,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::None).ToUniversalTime()
}
$uiEvidence=$null
if($UiEvidencePath){
 $evidencePath=(Resolve-Path -LiteralPath $UiEvidencePath).Path
 $uiEvidence=Get-Content -LiteralPath $evidencePath -Raw|ConvertFrom-Json
 $expectedFile=switch($Stage){'empty'{''} 'small'{'small.md'} 'back-small-after-large'{'small.md'} 'back-small-after-images'{'small.md'} '81-images'{'images-81.md'} 'large-markdown'{'large.md'} 'large-source-mode'{'large.md'} 'large-search'{'large.md'} default{throw 'Unknown evidence stage'}}
 $expectedMode=if($Stage-eq 'empty'){'empty'}elseif($Stage-eq 'large-source-mode'){'source'}elseif($Stage-eq 'large-search'){'document-search'}else{'document'}
 if($uiEvidence.run-ne $Run -or $uiEvidence.stage-ne $Stage -or $uiEvidence.pid-ne $ProcessId -or $uiEvidence.sha256-ne (Get-FileHash -LiteralPath $Executable).Hash -or $uiEvidence.observed_file-ne $expectedFile -or $uiEvidence.observed_mode-ne $expectedMode -or [string]::IsNullOrWhiteSpace($uiEvidence.observed_content)){throw 'CUA evidence does not match this process/stage/file/mode'}
 $observed=Convert-ObservationTime $uiEvidence.observed_utc
 if($observed.UtcDateTime-lt $p.StartTime.ToUniversalTime() -or $observed.UtcDateTime-gt [DateTime]::UtcNow.AddSeconds(5)){throw 'CUA observation timestamp is outside this process lifetime'}
 $observationPath=(Resolve-Path -LiteralPath $uiEvidence.observation_file).Path
 if((Get-Item -LiteralPath $observationPath).Length-eq 0){throw 'CUA observation artifact is empty'}
 $uiEvidence|Add-Member -NotePropertyName observation_sha256 -NotePropertyValue (Get-FileHash -LiteralPath $observationPath).Hash -Force
}
function Verify-Window {
 $p.Refresh();if($p.HasExited){throw 'Owned process exited'};$o=[VelloraTestWindow]::Observe($ProcessId)
 if(!$o[0].Contains($ExpectedTitle) -or ![bool]::Parse($o[4]) -or [int]$o[2]-ne 820 -or [int]$o[3]-ne 900){throw "Visible title/geometry mismatch: $o"};return $o
}
$settling=@();$watch=[Diagnostics.Stopwatch]::StartNew()
while($watch.Elapsed.TotalSeconds-lt 30){$p.Refresh();if($p.HasExited){throw 'Owned process exited'};$settling+=@{ms=$watch.ElapsedMilliseconds;private_bytes=$p.PrivateMemorySize64};Start-Sleep -Milliseconds 100}
$observation=Verify-Window;$steady=@()
for($i=0;$i-lt 10;$i++){Start-Sleep -Seconds 1;$p.Refresh();$steady+=@{sample=$i+1;private_bytes=$p.PrivateMemorySize64;working_set_bytes=$p.WorkingSet64;utc=(Get-Date).ToUniversalTime().ToString('o')}}
$observation=Verify-Window;$values=@($steady|ForEach-Object private_bytes|Sort-Object)
$row=[ordered]@{run=$Run;stage=$Stage;pid=$ProcessId;executable=$Executable;sha256=(Get-FileHash -LiteralPath $Executable).Hash;title=$observation[0];dpi=[int]$observation[1];client_width=820;client_height=900;visible=$true;mode_evidence=$ModeEvidence;natural_settle_seconds=30;median_private_mib=[math]::Round(($values[4]+$values[5])/2/1MB,2);steady_peak_mib=[math]::Round($values[-1]/1MB,2);observed_settling_peak_mib=[math]::Round(($settling|Measure-Object private_bytes -Maximum).Maximum/1MB,2);peak_scope='100ms samples, not exact instantaneous peak';settling_samples=$settling;steady_samples=$steady;gc_trim_or_cache_clear=$false}
$row.document_state_evidence_complete=($null-ne $uiEvidence)
$row.document_state_verification='External official-CUA observation supplied by desktop owner; sampler validates association, not UI semantics. Title alone never verifies document.'
$row.ui_evidence=$uiEvidence
$row|ConvertTo-Json -Depth 6|Set-Content -LiteralPath (Join-Path $OutputDir "run-$Run-$Stage.json") -Encoding utf8
Write-Output "Run $Run $Stage visible median=$($row.median_private_mib) MiB, settling sampled peak=$($row.observed_settling_peak_mib) MiB"
