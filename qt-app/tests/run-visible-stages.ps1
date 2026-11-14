param([int]$ProcessId,[string]$Executable,[string]$OutputDir,[int]$Run,[string[]]$Stages,[switch]$ForwardOnly)
$ErrorActionPreference='Stop';$Executable=(Resolve-Path -LiteralPath $Executable).Path;$OutputDir=(Resolve-Path -LiteralPath $OutputDir).Path
if($ForwardOnly -and $Stages.Count-ne 1){throw 'ForwardOnly takes exactly one stage; observe it with official CUA before sampling'}
foreach($name in @('VELLORA_TEST_INSTANCE','VELLORA_SCREENSHOT','VELLORA_TEST_OBSERVE','VELLORA_TEST_STATE','VELLORA_SEARCH','VELLORA_SEARCH_QUERY','VELLORA_DIALOG','VELLORA_DEBUG_TREE')){Remove-Item -LiteralPath ('Env:'+$name) -ErrorAction SilentlyContinue}
foreach($stage in $Stages){
 $owned=Get-Process -Id $ProcessId;if($owned.Path-ne $Executable){throw 'Owned primary executable changed'}
 $name=switch($stage){'small'{'small.md'} 'large-markdown'{'large.md'} 'back-small-after-large'{'small.md'} '81-images'{'images-81.md'} 'back-small-after-images'{'small.md'} default{throw 'Unsupported stage; source/search require explicit CUA verification'}}
 $path=Join-Path $OutputDir "fixtures/$name";$forward=Start-Process -FilePath $Executable -ArgumentList ('"'+$path+'"') -WindowStyle Hidden -PassThru
 if(!$forward.WaitForExit(10000)){$forward.Kill();throw 'Owned forwarding process timeout'};if($forward.ExitCode-ne 0){throw 'Forwarding failed'}
 if($ForwardOnly){Write-Output 'Forwarded only. Verify file, mode and content with official CUA, record evidence, then call sample-visible.ps1 -UiEvidencePath.';continue}
 # Batch forwarding cannot perform a CUA observation between stages. Preserve
 # numeric diagnostics, but never represent requested paths as observed files.
 & (Join-Path $PSScriptRoot 'sample-visible.ps1') -ProcessId $ProcessId -Executable $Executable -OutputDir $OutputDir -Stage $stage -Run $Run -ExpectedTitle 'Vellora'
}
