# Validate app-local runtime resolution without Qt/VS on PATH. Never runs Setup.
param([Parameter(Mandatory=$true)][string]$PortableDir,[Parameter(Mandatory=$true)][string]$OutputDir)
$ErrorActionPreference='Stop'
$PortableDir=(Resolve-Path -LiteralPath $PortableDir).Path
$OutputDir=[IO.Path]::GetFullPath($OutputDir)
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$keys=@('PATH','QT_PLUGIN_PATH','QT_QPA_PLATFORM_PLUGIN_PATH','QT_QPA_PLATFORM','VELLORA_TEST_INSTANCE','VELLORA_SCREENSHOT','VELLORA_TEST_STATE','VELLORA_TEST_OBSERVE','VELLORA_DIALOG','VELLORA_SEARCH','VELLORA_DEBUG_TREE')
$old=@{};foreach($key in $keys){$old[$key]=[Environment]::GetEnvironmentVariable($key,'Process')}
Add-Type -Path (Join-Path $PSScriptRoot 'perf-window.cs')
$homePath=[Environment]::GetFolderPath('UserProfile').Replace('\','/')
$sha=[Security.Cryptography.SHA256]::Create();try{$suffix=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($homePath)))).Replace('-','').ToLowerInvariant().Substring(0,24)}finally{$sha.Dispose()}
$endpoint='vellora.qt.preview.'+$suffix
if([IO.Directory]::GetFiles('\\.\pipe\')|Where-Object {$_.EndsWith('\'+$endpoint,[StringComparison]::OrdinalIgnoreCase)}){throw 'An existing production Qt instance is running; smoke refuses to contact it.'}
$binary=[IO.File]::ReadAllBytes((Join-Path $PortableDir 'vellora.exe'));$ascii=[Text.Encoding]::ASCII.GetString($binary);$wide=[Text.Encoding]::Unicode.GetString($binary);$wideOdd=[Text.Encoding]::Unicode.GetString($binary,1,$binary.Length-1)
$hookTokens=@('VELLORA_TEST_INSTANCE','VELLORA_TEST_OBSERVE','VELLORA_TEST_STATE','VELLORA_SCREENSHOT','VELLORA_DEBUG_TREE','VELLORA_DIALOG','VELLORA_SEARCH_QUERY','VELLORA_SCROLL','VELLORA_SEARCH','VELLORA_LAYOUT_DUMP','VELLORA_TABLE_SCROLL')
foreach($token in $hookTokens){if($ascii.Contains($token) -or $wide.Contains($token) -or $wideOdd.Contains($token)){throw "Production binary contains test hook token $token"}}
$p=$null
try{
 foreach($key in $keys){Remove-Item -LiteralPath ('Env:'+$key) -ErrorAction SilentlyContinue}
 $env:PATH="$env:WINDIR\System32;$env:WINDIR";$env:QT_QPA_PLATFORM='windows';$env:VELLORA_TEST_INSTANCE='ignored-in-production-'+[guid]::NewGuid()
 $env:VELLORA_SCREENSHOT=Join-Path $OutputDir 'portable.png';$env:VELLORA_TEST_STATE=Join-Path $OutputDir 'state.json'
 $p=Start-Process -FilePath (Join-Path $PortableDir 'vellora.exe') -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $OutputDir 'stderr.txt')
 Start-Sleep -Milliseconds 1000;$p.Refresh();if($p.HasExited){throw "Portable app exited early: $($p.ExitCode)"}
 $modules=@($p.Modules | Where-Object {$_.ModuleName -like 'Qt6*.dll' -or $_.ModuleName -eq 'qwindows.dll' -or $_.ModuleName -like 'msvcp140*.dll' -or $_.ModuleName -like 'vcruntime140*.dll' -or $_.ModuleName -eq 'concrt140.dll'} | ForEach-Object { @{name=$_.ModuleName;path=$_.FileName} })
 if(!($modules | Where-Object name -EQ 'qwindows.dll')){throw 'The qwindows runtime plugin was not loaded.'}
 foreach($module in $modules){if(!$module.path.StartsWith($PortableDir+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw "Nonportable runtime dependency: $($module.path)"}}
 $observed=[VelloraTestWindow]::Observe($p.Id)
 if(!$observed[0].Contains('Vellora')){throw 'Owned production process did not create its window.'}
 Start-Sleep -Seconds 3;$p.Refresh();if($p.HasExited){throw 'Production app exited through a test hook or crashed.'}
 if(Test-Path -LiteralPath (Join-Path $OutputDir 'state.json')){throw 'Production app unexpectedly wrote test state.'}
 if(Test-Path -LiteralPath (Join-Path $OutputDir 'portable.png')){throw 'Production app unexpectedly honored screenshot hook.'}
 $state=@{title=$observed[0];dpi=[int]$observed[1];client_width_pixels=[int]$observed[2];client_height_pixels=[int]$observed[3]}
 @{portable=$PortableDir;sha256=(Get-FileHash -LiteralPath (Join-Path $PortableDir 'vellora.exe')).Hash;path_without_qt=$env:PATH;runtime_modules=$modules;state=$state;test_hooks_ignored=$true;absent_ascii_utf16_hook_tokens=$hookTokens;setup_executed=$false;termination='only owned PID stopped after read-only smoke'} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $OutputDir 'report.json') -Encoding utf8
 Write-Host "Portable smoke passed: $OutputDir"
}finally{
 if($p -and !$p.HasExited){$p.Kill();$p.WaitForExit()}
 foreach($key in $keys){if($null -eq $old[$key]){Remove-Item -LiteralPath ('Env:'+$key) -ErrorAction SilentlyContinue}else{[Environment]::SetEnvironmentVariable($key,$old[$key],'Process')}}
}

