# Prepare an immutable, app-local production snapshot. Does not launch any UI.
param([Parameter(Mandatory=$true)][string]$PortableDir,[Parameter(Mandatory=$true)][string]$TestSlotDir,[Parameter(Mandatory=$true)][string]$OutputDir,[Parameter(Mandatory=$true)][string]$BuildMakefile)
$ErrorActionPreference='Stop'
$PortableDir=(Resolve-Path -LiteralPath $PortableDir).Path;$BuildMakefile=(Resolve-Path -LiteralPath $BuildMakefile).Path
$TestSlotDir=[IO.Path]::GetFullPath($TestSlotDir);$OutputDir=[IO.Path]::GetFullPath($OutputDir)
if((Test-Path -LiteralPath $TestSlotDir) -or (Test-Path -LiteralPath $OutputDir)){throw 'Both output directories must be fresh; immutable evidence is never replaced.'}
$original=Join-Path $PortableDir 'vellora.exe';$hash=(Get-FileHash -LiteralPath $original).Hash
$built=Join-Path (Split-Path -Parent $BuildMakefile) 'vellora.exe';if((Get-FileHash -LiteralPath $built).Hash-ne $hash){throw 'Build Makefile neighboring app hash differs from portable production app.'}
New-Item -ItemType Directory -Path $TestSlotDir,(Join-Path $OutputDir 'fixtures')|Out-Null
Get-ChildItem -LiteralPath $PortableDir|Where-Object Name -NE 'vellora.exe'|Copy-Item -Destination $TestSlotDir -Recurse
$executable=Join-Path $TestSlotDir 'vellora-qt-perf-test.exe';Copy-Item -LiteralPath $original -Destination $executable
if((Get-FileHash -LiteralPath $executable).Hash-ne $hash){throw 'Snapshot hash verification failed.'}
$baseline=Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'tests/fixtures/performance'
$fixtures=Join-Path $OutputDir 'fixtures'
foreach($name in @('small.md','large.md','images-81.md')){Copy-Item -LiteralPath (Join-Path $baseline $name) -Destination $fixtures}
$repo=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
& (Join-Path $repo 'tools/make-perf-images.ps1') -OutputDir $fixtures -ImageSet Picture81 | Out-Null
. (Join-Path $repo 'tools/perf-fixtures.ps1')
Assert-Picture81Fixtures -FixtureDir $fixtures
$hardware=[ordered]@{gpu_process_dedicated_bytes='unmeasured';gpu_process_shared_bytes='unmeasured'}
try{$hardware.cpu=@(Get-CimInstance Win32_Processor|Select-Object Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed)}catch{$hardware.cpu='unavailable'}
try{$hardware.ram_bytes=(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory}catch{$hardware.ram_bytes='unavailable'}
try{$hardware.graphics=@(Get-CimInstance Win32_VideoController|Select-Object Name,DriverVersion,CurrentHorizontalResolution,CurrentVerticalResolution,CurrentRefreshRate)}catch{$hardware.graphics='unavailable'}
[ordered]@{executable=$executable;original_production_executable=$original;sha256=$hash;variant='production portable, no test hooks; official UI verified source/search';qt_core_file_version=(Get-Item -LiteralPath (Join-Path $PortableDir 'Qt6Core.dll')).VersionInfo.FileVersion;platform='qwindows';os=[Environment]::OSVersion.VersionString;hardware=$hardware;compile_flags=@(Select-String -LiteralPath $BuildMakefile -Pattern '^(CXXFLAGS|DEFINES|CXX|LFLAGS)\s*='|ForEach-Object Line);runs_requested=3;fixture_kind='repository-markdown-fixed-seed-png-v1';fixtures=@(Get-ChildItem -LiteralPath (Join-Path $OutputDir 'fixtures') -File|ForEach-Object{@{name=$_.Name;bytes=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName).Hash}});startup_peak='unmeasured before official launch returns; 100 ms settling samples are not instantaneous peaks';image_scenario='81-image fixed-seed PNG v1 (128x128 ARGB, seeds 2001..2081) at initial viewport; no forced scrolling/decoding';search_scenario='mixed text query after seven-stage lifecycle in each independent PID; actual nonzero matches must be verified';gc_trim_or_cache_clear=$false}|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $OutputDir 'metadata.json') -Encoding utf8
Write-Output "Prepared production snapshot: $executable; SHA256=$hash"
