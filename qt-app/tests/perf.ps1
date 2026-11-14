# Optional real-qwindows memory sampling. No GC, trim, cache clear, or installation.
param(
  [Parameter(Mandatory=$true)][string]$Executable,
  [string]$QtRoot = $env:QT_ROOT,
  [string]$OutputDir,
  [ValidateRange(1,3)][int]$Runs = 3,
  [switch]$Synthetic,
  [string]$BuildMakefile,
  [switch]$ProductionOnly,
  [switch]$SearchOnly,
  [switch]$LargeImagesOnly
)
$ErrorActionPreference='Stop'
$Executable=(Resolve-Path -LiteralPath $Executable).Path
if (!$QtRoot) { $QtRoot=Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'qt\6.8.3\msvc2022_64' }
if (!$OutputDir) { $OutputDir=Join-Path $env:TEMP ('vellora-qt-perf-'+[guid]::NewGuid()) }
$OutputDir=[IO.Path]::GetFullPath($OutputDir)
if(Test-Path -LiteralPath $OutputDir){throw 'Use a fresh OutputDir; this script never deletes existing output.'}
New-Item -ItemType Directory -Path $OutputDir | Out-Null
$fixtures=Join-Path $OutputDir 'fixtures';New-Item -ItemType Directory -Path $fixtures | Out-Null
$fixtureKind='repository-structured-baseline'
$native=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if ($Synthetic) {
$small=Join-Path $fixtures 'small.md';[IO.File]::WriteAllText($small,"# Small document`n`nA short paragraph.`n",[Text.UTF8Encoding]::new($false))
$large=Join-Path $fixtures '2MiB.md';$line=('text '*400)+"`n`n";$text=[Text.StringBuilder]::new();while($text.Length -lt 2MB){[void]$text.Append($line)};[IO.File]::WriteAllText($large,$text.ToString().Substring(0,2MB),[Text.UTF8Encoding]::new($false))
Add-Type -AssemblyName System.Drawing
$images=Join-Path $fixtures '81-images.md';$markdown=[Text.StringBuilder]::new("# 81 images`n`n")
for($i=0;$i -lt 81;$i++){
  $name="image-$i.png";$bitmap=[Drawing.Bitmap]::new(1280,720);$graphics=[Drawing.Graphics]::FromImage($bitmap)
  try {$graphics.Clear([Drawing.Color]::FromArgb(255,($i*31)%256,($i*53)%256,($i*79)%256));$bitmap.Save((Join-Path $fixtures $name),[Drawing.Imaging.ImageFormat]::Png)}finally{$graphics.Dispose();$bitmap.Dispose()}
  [void]$markdown.Append("![image $i]($name)`n`n")
}
[IO.File]::WriteAllText($images,$markdown.ToString(),[Text.UTF8Encoding]::new($false))
& (Join-Path $native 'tools\make-perf-images.ps1') -OutputDir $fixtures | Out-Null
Copy-Item -LiteralPath (Join-Path $native 'tests\fixtures\performance\large-images.md') -Destination $fixtures
$largeImages=Join-Path $fixtures 'large-images.md'

  $fixtureKind='synthetic-control-repeated-paragraph-and-solid-images'
} else {
  $baseline=Join-Path $native 'tests\fixtures\performance'
  & (Join-Path $native 'tools\make-perf-images.ps1') -OutputDir $baseline | Out-Null
  foreach($name in @('small.md','large.md','images-81.md','large-images.md')){Copy-Item -LiteralPath (Join-Path $baseline $name) -Destination $fixtures}
  Get-ChildItem -LiteralPath $baseline -Filter 'picture-*.png' -File | Copy-Item -Destination $fixtures
  Get-ChildItem -LiteralPath $baseline -Filter 'large-image-*.png' -File | Copy-Item -Destination $fixtures
  $small=Join-Path $fixtures 'small.md';$large=Join-Path $fixtures 'large.md';$images=Join-Path $fixtures 'images-81.md';$largeImages=Join-Path $fixtures 'large-images.md'
}
Add-Type -Path (Join-Path $PSScriptRoot 'perf-window.cs')
$executableHash=(Get-FileHash -LiteralPath $Executable).Hash
$qtVersion=& (Join-Path $QtRoot 'bin\qmake.exe') -query QT_VERSION
# Inventory is read once before any measured process starts, never in sampling.
$hardware=[ordered]@{gpu_process_dedicated_bytes='unmeasured';gpu_process_shared_bytes='unmeasured'}
try{$hardware.cpu=@(Get-CimInstance Win32_Processor|Select-Object Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed)}catch{$hardware.cpu='unavailable'}
try{$hardware.ram_bytes=(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory}catch{$hardware.ram_bytes='unavailable'}
try{$hardware.graphics=@(Get-CimInstance Win32_VideoController|Select-Object Name,DriverVersion,CurrentHorizontalResolution,CurrentVerticalResolution,CurrentRefreshRate)}catch{$hardware.graphics='unavailable'}
$buildEvidence=[ordered]@{status='unmeasured; provide matching -BuildMakefile'}
if($BuildMakefile){
 $make=(Resolve-Path -LiteralPath $BuildMakefile).Path;$builtExe=Join-Path (Split-Path -Parent $make) 'vellora.exe'
 if(!(Test-Path -LiteralPath $builtExe) -or (Get-FileHash -LiteralPath $builtExe).Hash -ne $executableHash){throw 'BuildMakefile executable hash does not match measured executable.'}
 $buildEvidence=[ordered]@{makefile=$make;matching_executable_sha256=$executableHash;compiler_flags=@(Select-String -LiteralPath $make -Pattern '^(CXXFLAGS|DEFINES|CXX)\s*='|ForEach-Object Line)}
}
$fixtureManifest=@(Get-ChildItem -LiteralPath $fixtures -File | ForEach-Object {@{name=$_.Name;bytes=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName).Hash}})
[ordered]@{executable=$Executable;sha256=$executableHash;qt_version=$qtVersion;os=[Environment]::OSVersion.VersionString;fixture_kind=$fixtureKind;fixtures=$fixtureManifest;instrumentation=if($ProductionOnly){'production; no hooks'}else{'VELLORA_ENABLE_TEST_HOOKS test-app; not production portable'};hardware=$hardware;build=$buildEvidence;requested_runs=$Runs;platform='qwindows';peak_scope='100ms process samples during 30s natural settling; not an exact instantaneous peak';idle_seconds=30;sample_count=10;gc_or_cache_trimming=$false} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $OutputDir 'metadata.json') -Encoding utf8
$environmentKeys=@('PATH','QT_QPA_PLATFORM','VELLORA_TEST_INSTANCE','VELLORA_SCREENSHOT','VELLORA_TEST_STATE','VELLORA_TEST_OBSERVE','VELLORA_DIALOG','VELLORA_SEARCH','VELLORA_SEARCH_QUERY','VELLORA_DEBUG_TREE','QT_SCALE_FACTOR','QT_SCREEN_SCALE_FACTORS')
$old=@{};foreach($key in $environmentKeys){$old[$key]=[Environment]::GetEnvironmentVariable($key,'Process')}
$rows=[Collections.Generic.List[object]]::new()
try{
  $env:PATH="$QtRoot\bin;$env:PATH";$env:QT_QPA_PLATFORM='windows'
  foreach($key in $environmentKeys | Where-Object {$_ -notin @('PATH','QT_QPA_PLATFORM','VELLORA_TEST_INSTANCE')}){Remove-Item -LiteralPath ('Env:' + $key) -ErrorAction SilentlyContinue}
  for($run=1;$run -le $Runs;$run++){
    $env:VELLORA_TEST_INSTANCE='perf-'+[guid]::NewGuid();$primary=$null
    if($ProductionOnly){
      Remove-Item Env:VELLORA_TEST_INSTANCE -ErrorAction SilentlyContinue
      $homePath=[Environment]::GetFolderPath('UserProfile').Replace('\','/');$sha=[Security.Cryptography.SHA256]::Create()
      try{$suffix=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($homePath)))).Replace('-','').ToLowerInvariant().Substring(0,24)}finally{$sha.Dispose()}
      $endpoint='vellora.qt.preview.'+$suffix
      if([IO.Directory]::GetFiles('\\.\pipe\')|Where-Object {$_.EndsWith('\'+$endpoint,[StringComparison]::OrdinalIgnoreCase)}){throw 'Existing production Qt instance detected; never contact it for a benchmark.'}
    }
    $env:VELLORA_TEST_OBSERVE=Join-Path $OutputDir "run-$run-state.json"
    try{
      $startArgs=@{}
      if($SearchOnly){$env:VELLORA_SEARCH='find';$env:VELLORA_SEARCH_QUERY='mixed text';$startArgs.ArgumentList='"'+$large+'"'}
      if($LargeImagesOnly){$startArgs.ArgumentList='"'+$largeImages+'"'}
      $primary=Start-Process @startArgs -FilePath $Executable -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $OutputDir "run-$run.stderr.txt")
      $stages=@(@{name='empty';path=$null},@{name='small';path=$small},@{name='large-markdown';path=$large},@{name='large-source-mode';path=$large;source=$true},@{name='back-small-after-large';path=$small},@{name='81-images';path=$images},@{name='back-small-after-images';path=$small},@{name='large-images';path=$largeImages},@{name='back-small-after-large-images';path=$small})
      if($SearchOnly){$stages=@(@{name='large-search';path=$large;alreadyLoaded=$true})}
      elseif($LargeImagesOnly){$stages=@(@{name='large-images';path=$largeImages;alreadyLoaded=$true})}
      elseif($ProductionOnly){$stages=@(@{name='empty';path=$null},@{name='small';path=$small},@{name='large-markdown';path=$large},@{name='81-images';path=$images},@{name='back-small-after-images';path=$small},@{name='large-images';path=$largeImages},@{name='back-small-after-large-images';path=$small})}
      foreach($stage in $stages){
        $loadingSamples=@();$settling=[Diagnostics.Stopwatch]::StartNew()
        if($stage.path -and !$stage.alreadyLoaded){
          $arguments='"'+$stage.path+'"';if($stage.source){$arguments+=' --source-mode'}
          $forward=Start-Process -FilePath $Executable -ArgumentList $arguments -WindowStyle Hidden -PassThru
          $forwardWait=[Diagnostics.Stopwatch]::StartNew()
          while(!$forward.HasExited){
            if($forwardWait.ElapsedMilliseconds -gt 10000){ $forward.Kill();throw 'Test forwarding process timed out.' }
            $primary.Refresh();if($primary.HasExited){throw 'Owned process exited during forwarding.'}
            $loadingSamples+=@{elapsed_ms=$settling.ElapsedMilliseconds;private_bytes=$primary.PrivateMemorySize64;utc=(Get-Date).ToUniversalTime().ToString('o')}
            Start-Sleep -Milliseconds 10
          }
          if($forward.ExitCode -ne 0){throw "Forward failed: $($forward.ExitCode)"}
        }
        Write-Host "Run $run stage $($stage.name): natural idle 30 seconds"
        $idleStart=$settling.Elapsed.TotalSeconds
        while(($settling.Elapsed.TotalSeconds - $idleStart) -lt 30){
          $primary.Refresh();if($primary.HasExited){throw 'Owned process exited during natural settling.'}
          $loadingSamples+=@{elapsed_ms=$settling.ElapsedMilliseconds;private_bytes=$primary.PrivateMemorySize64;utc=(Get-Date).ToUniversalTime().ToString('o')}
          $stepMs=if(($settling.Elapsed.TotalSeconds - $idleStart) -lt 2){10}else{100}
          Start-Sleep -Milliseconds $stepMs
        }
        $primary.Refresh();$observation=[VelloraTestWindow]::Observe($primary.Id)
        $expectedTitle=if($stage.path){[IO.Path]::GetFileName($stage.path)}else{'Vellora'}
        if(!$observation[0].Contains('Vellora')){throw "Unexpected owned window title: $($observation[0])"}
        # A fixed title cannot prove a requested file loaded. The periodic test
        # observer has mode/counts only, not source text or a content hash.
        if(!$ProductionOnly){
        $metadata=Get-Content -LiteralPath $env:VELLORA_TEST_OBSERVE -Raw | ConvertFrom-Json
        if($metadata.platform -ne 'windows' -or ($metadata.sourceVisible -ne [bool]$stage.source) -or !$metadata.title.Contains('Vellora') -or ($stage.path -and $metadata.documentChars -le 1)){throw "Observer did not confirm qwindows mode/nonempty document (file identity remains unverified): $expectedTitle"}
        }else{$metadata=@{verification='owned PID/window identity only; requested file, source/search/documentChars unverified';title=$observation[0]}}
        if($SearchOnly -and (!$metadata.searchVisible -or $metadata.searchMatches -le 0)){throw 'Search stage has no verified visible panel and nonzero match count.'}
        $samples=@()
        for($sample=1;$sample -le 10;$sample++){
          Start-Sleep -Seconds 1;$primary.Refresh();if($primary.HasExited){throw "Primary test process exited unexpectedly: $($primary.ExitCode). See run-$run.stderr.txt."}
          $samples+=@{sample=$sample;private_bytes=$primary.PrivateMemorySize64;working_set_bytes=$primary.WorkingSet64;utc=(Get-Date).ToUniversalTime().ToString('o')}
        }
        $private=@($samples | ForEach-Object private_bytes | Sort-Object)
        $row=[ordered]@{run=$run;stage=$stage.name;pid=$primary.Id;title=$observation[0];dpi=[int]$observation[1];client_width_pixels=[int]$observation[2];client_height_pixels=[int]$observation[3];native_window_visible=[bool]::Parse($observation[4]);fixture_kind=$fixtureKind;source_mode=[bool]$stage.source;observed=$metadata;settling_samples=$loadingSamples;settling_sample_interval_ms=100;observed_settling_peak_mib=[math]::Round(($loadingSamples|Measure-Object private_bytes -Maximum).Maximum/1MB,2);kernel_peak_private_mib=[math]::Round($primary.PeakPagedMemorySize64/1MB,2);median_private_mib=[math]::Round((($private[4]+$private[5])/2)/1MB,2);max_private_mib=[math]::Round($private[-1]/1MB,2);samples=$samples}
        $row.document_state_evidence_complete=$false;$row.document_state_verification='unverified: requested path and fixed window title are not file-content evidence';$rows.Add($row);$rows | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $OutputDir 'samples.json') -Encoding utf8
        Write-Host "Run $run $($stage.name): peak $($row.observed_settling_peak_mib) MiB (kernel peak $($row.kernel_peak_private_mib) MiB), median $($row.median_private_mib) MiB, max $($row.max_private_mib) MiB"
      }
    }finally{if($primary -and !$primary.HasExited){$primary.Kill();$primary.WaitForExit()}}
  }
}finally{foreach($key in $environmentKeys){if ($null -eq $old[$key]) { Remove-Item -LiteralPath ('Env:' + $key) -ErrorAction SilentlyContinue } else { [Environment]::SetEnvironmentVariable($key,$old[$key],'Process') }}}
if($LargeImagesOnly){
  $peaks=@($rows|ForEach-Object { $_.observed_settling_peak_mib }|Sort-Object)
  $kernelPeaks=@($rows|ForEach-Object { $_.kernel_peak_private_mib }|Sort-Object)
  $values=@($rows|ForEach-Object { $_.median_private_mib }|Sort-Object)
  $median=if($values.Count%2){$values[[int][math]::Floor($values.Count/2)]}else{($values[$values.Count/2-1]+$values[$values.Count/2])/2}
  [ordered]@{executable=$Executable;sha256=$executableHash;fixture_kind=$fixtureKind;fixtures=$fixtureManifest;platform='qwindows';qt_version=$qtVersion;runs=$Runs;observed_peak_max_mib=$peaks[-1];kernel_peak_max_mib=$kernelPeaks[-1];steady_median_mib=$median;document_state_evidence_complete=$false;passed=$false;results=$rows}|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $OutputDir 'report.json') -Encoding utf8
  throw 'Large-images numeric diagnostics saved; loaded document identity is unverified by the metadata-only observer.'
}
if($ProductionOnly){
  $gates=@();for($run=1;$run -le $Runs;$run++){
    $r=@($rows|Where-Object run -EQ $run);$empty=($r|Where-Object stage -EQ 'empty').median_private_mib;$small=($r|Where-Object stage -EQ 'small').median_private_mib;$large=($r|Where-Object stage -EQ 'large-markdown').median_private_mib;$back=($r|Where-Object stage -EQ 'back-small-after-images').median_private_mib
    $largeImg=($r|Where-Object stage -EQ 'large-images');$backLargeImg=($r|Where-Object stage -EQ 'back-small-after-large-images').median_private_mib
    $gates+=@{run=$run;empty_mib=$empty;small_mib=$small;large_mib=$large;return_growth_mib=[math]::Round(($back-$empty),2);large_images_peak_mib=$largeImg.observed_settling_peak_mib;large_images_kernel_peak_mib=$largeImg.kernel_peak_private_mib;large_images_median_mib=$largeImg.median_private_mib;after_large_images_growth_mib=[math]::Round(($backLargeImg-$empty),2);passed=($empty-le 60 -and $small-le 80 -and $large-le 200 -and ($back-$empty)-le 20 -and ($backLargeImg-$empty)-le 20)}
  }
  @{executable=$Executable;sha256=$executableHash;instrumentation='production; no hooks';runs=$Runs;passed=$false;document_state_evidence_complete=$false;not_measured=@('loaded document identity','source mode','search','after-large recovery separately');gates=$gates;results=$rows}|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $OutputDir 'report.json') -Encoding utf8
  throw 'Production numeric diagnostics saved; loaded document identity unverified. Use official-CUA per-stage visible sampling for acceptance.'
}
if($SearchOnly){
  $values=@($rows|ForEach-Object median_private_mib|Sort-Object)
  $median=if($values.Count%2){$values[[int][math]::Floor($values.Count/2)]}else{($values[$values.Count/2-1]+$values[$values.Count/2])/2}
  [ordered]@{executable=$Executable;sha256=$executableHash;fixture_kind=$fixtureKind;fixtures=$fixtureManifest;platform='qwindows';qt_version=$qtVersion;query='mixed text';runs=$Runs;steady_median_mib=$median;limit_mib=200;memory_thresholds_passed=($median -le 200);document_state_evidence_complete=$false;passed=$false;results=$rows}|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $OutputDir 'report.json') -Encoding utf8
  throw 'Search numeric diagnostics saved; loaded document identity is unverified by the metadata-only observer.'
}
$gates=@()
for($run=1;$run -le $Runs;$run++) {
  $empty=$rows | Where-Object {$_.run -eq $run -and $_.stage -eq 'empty'}
  $smallResult=$rows | Where-Object {$_.run -eq $run -and $_.stage -eq 'small'}
  $largeResult=$rows | Where-Object {$_.run -eq $run -and $_.stage -eq 'large-markdown'}
  $largeSource=$rows | Where-Object {$_.run -eq $run -and $_.stage -eq 'large-source-mode'}
  $backLarge=$rows | Where-Object {$_.run -eq $run -and $_.stage -eq 'back-small-after-large'}
  $backImages=$rows | Where-Object {$_.run -eq $run -and $_.stage -eq 'back-small-after-images'}
  $largeImagesResult=$rows | Where-Object {$_.run -eq $run -and $_.stage -eq 'large-images'}
  $backLargeImages=$rows | Where-Object {$_.run -eq $run -and $_.stage -eq 'back-small-after-large-images'}
  $largeGrowth=[math]::Round($backLarge.median_private_mib-$empty.median_private_mib,2)
  $imageGrowth=[math]::Round($backImages.median_private_mib-$empty.median_private_mib,2)
  $largeImageGrowth=[math]::Round($backLargeImages.median_private_mib-$empty.median_private_mib,2)
  $gates+=@{run=$run;empty_median_mib=$empty.median_private_mib;small_median_mib=$smallResult.median_private_mib;large_median_mib=$largeResult.median_private_mib;large_source_median_mib=$largeSource.median_private_mib;large_images_peak_mib=$largeImagesResult.observed_settling_peak_mib;large_images_kernel_peak_mib=$largeImagesResult.kernel_peak_private_mib;large_images_median_mib=$largeImagesResult.median_private_mib;return_growth_limit_mib=20;return_growth_reference='same-run initial empty';after_large_growth_mib=$largeGrowth;after_images_growth_mib=$imageGrowth;after_large_images_growth_mib=$largeImageGrowth;after_large_pass=($largeGrowth -le 20);after_images_pass=($imageGrowth -le 20);after_large_images_pass=($largeImageGrowth -le 20)}
}
# The plan defines steady-state medians across independent runs; raw/max samples
# remain in results, rather than silently substituting a peak for a steady value.
function Median-Stage([string]$Name) {
  $values=@($rows | Where-Object stage -EQ $Name | ForEach-Object median_private_mib | Sort-Object)
  if($values.Count % 2){return $values[[int][math]::Floor($values.Count/2)]}
  return ($values[$values.Count/2-1]+$values[$values.Count/2])/2
}
$steady=[ordered]@{empty_mib=(Median-Stage 'empty');small_mib=(Median-Stage 'small');large_mib=(Median-Stage 'large-markdown');large_source_mib=(Median-Stage 'large-source-mode');large_images_mib=(Median-Stage 'large-images');empty_limit_mib=60;small_limit_mib=80;large_limit_mib=200;runs=$Runs}
$steady.passed=($steady.empty_mib -le 60 -and $steady.small_mib -le 80 -and $steady.large_mib -le 200 -and $steady.large_source_mib -le 200)
[ordered]@{executable=$Executable;sha256=$executableHash;qt_version=$qtVersion;os=[Environment]::OSVersion.VersionString;fixture_kind=$fixtureKind;fixtures=$fixtureManifest;platform='qwindows';dpi='system default; no scale override';runs=$Runs;idle_seconds=30;sample_count=10;interval_seconds=1;large_fixture_bytes=(Get-Item -LiteralPath $large).Length;image_count=81;image_dimensions=if($Synthetic){'1280x720'}else{'original repository PNGs; see fixture hashes'};gc_or_cache_trimming=$false;document_state_evidence_complete=$false;passed=$false;steady_state_gates=$steady;recovery_gates=$gates;results=$rows} | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath (Join-Path $OutputDir 'report.json') -Encoding utf8
Write-Host "Report: $OutputDir\report.json"







throw "Numeric diagnostics saved; loaded document identity is unverified by the metadata-only observer. Use official-CUA per-stage visible sampling for acceptance."



