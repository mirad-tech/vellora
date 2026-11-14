param([Parameter(Mandatory=$true)][string]$OutputDir,[switch]$KeyRecoveryOnly)
$ErrorActionPreference='Stop';$OutputDir=(Resolve-Path $OutputDir).Path
$rows=@(Get-ChildItem -LiteralPath $OutputDir -Filter 'run-*.json'|ForEach-Object{Get-Content -LiteralPath $_.FullName -Raw|ConvertFrom-Json})
$names=@('empty','small','large-markdown','large-source-mode','back-small-after-large','81-images','back-small-after-images','large-search')
if($KeyRecoveryOnly){$names=@('empty','large-markdown','large-source-mode','back-small-after-large')}
if($rows.Count-ne 3*$names.Count -or @($rows|Where-Object {$_.stage-notin $names -or $_.run-notin @(1,2,3)}).Count){throw 'Unexpected rows/run IDs for the selected scope; use a fresh output directory'}
foreach($name in $names){$group=@($rows|Where-Object stage -EQ $name);if($group.Count-ne 3 -or @($group.run|Sort-Object -Unique).Count-ne 3){throw "Need exactly three independent runs of $name"}}
if(@(($rows|Where-Object stage -EQ 'empty').pid|Sort-Object -Unique).Count-ne 3){throw 'Baseline runs were not independent processes'}
for($run=1;$run-le 3;$run++){if(@(($rows|Where-Object run -EQ $run).pid|Sort-Object -Unique).Count-ne 1){throw "Run $run changed PID between stages"}}
$hashes=@($rows.sha256|Sort-Object -Unique);if($hashes.Count-ne 1){throw 'Binary changed between measurements'}
$medians=@{};foreach($name in $names){$v=@($rows|Where-Object stage -EQ $name|ForEach-Object median_private_mib|Sort-Object);$medians[$name]=$v[1]}
$recoveryNames=@('back-small-after-large','back-small-after-images');if($KeyRecoveryOnly){$recoveryNames=@('back-small-after-large')}
$recovery=@();for($run=1;$run-le 3;$run++){$r=$rows|Where-Object run -EQ $run;$empty=($r|Where-Object stage -EQ 'empty').median_private_mib;foreach($name in $recoveryNames){$growth=[math]::Round(($r|Where-Object stage -EQ $name).median_private_mib-$empty,2);$recovery+=@{run=$run;stage=$name;growth_mib=$growth;limit_mib=20;passed=($growth-le 20)}}}
$passed=($medians.empty-le 60 -and $medians.'large-markdown'-le 200 -and $medians.'large-source-mode'-le 200 -and !($recovery|Where-Object {!$_.passed}))
if(!$KeyRecoveryOnly){$passed=$passed -and $medians.small-le 80 -and $medians.'large-search'-le 200}
$evidenceComplete=@($rows|Where-Object {$_.document_state_evidence_complete-ne $true -or $null-eq $_.ui_evidence}).Count-eq 0
@{scope=if($KeyRecoveryOnly){'key-recovery-only'}else{'full-eight-stage'};unmeasured_stages=if($KeyRecoveryOnly){@('initial-small','81-images','back-small-after-images','large-search')}else{@()};sha256=$hashes[0];variant=(Get-Content (Join-Path $OutputDir 'metadata.json') -Raw|ConvertFrom-Json).variant;three_run_steady_medians_mib=$medians;recovery=$recovery;memory_thresholds_passed=$passed;document_state_evidence_complete=$evidenceComplete;passed=($passed -and $evidenceComplete);startup_peak='unmeasured before launch returned';raw_measurements=$rows;metadata=(Get-Content (Join-Path $OutputDir 'metadata.json') -Raw|ConvertFrom-Json)}|ConvertTo-Json -Depth 10|Set-Content (Join-Path $OutputDir 'report.json') -Encoding utf8
Write-Output ($medians|ConvertTo-Json);if(!$passed -or !$evidenceComplete){throw 'Visible acceptance incomplete: memory thresholds failed or per-stage CUA document evidence missing; report preserved.'}
