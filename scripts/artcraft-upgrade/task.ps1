#requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateSet('Submit','Status')][string]$Mode='Status',
    [Parameter(Mandatory=$true)][string]$PlanPath,
    [ValidateSet('Inspect','Prepare','Canary','Cutover','Rollback','Readback')][string]$Phase,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-zA-Z0-9-]{8,64}$')][string]$InvocationId,
    [string]$GateReceipt
)
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop'
try {
    $plan=Get-Content -LiteralPath $PlanPath -Raw|ConvertFrom-Json
    if($plan.ReleaseId -notmatch '^[a-z0-9][a-z0-9-]{3,36}$'){throw 'invalid release'}
    if($env:USERNAME -ine 'qrrwi' -or $env:COMPUTERNAME -ine 'AI'){throw 'wrong host'}
    $root=Join-Path 'C:\Users\qrrwi\studio-v3-production\releases' "artcraft-$($plan.ReleaseId)"
    $name="ArtCraft-$($plan.ReleaseId)-$InvocationId";$requestPath=Join-Path $root "request-$InvocationId.json";$completion=Join-Path $root "completion-$InvocationId.json"
    if($Mode -eq 'Status'){
        $task=Get-ScheduledTask -TaskName $name;$info=Get-ScheduledTaskInfo -TaskName $name
        if(!(Test-Path -LiteralPath $completion)){$terminal=($task.State -ne 'Running' -and $task.State -ne 'Queued' -and $info.LastTaskResult -ne 267011);@{InvocationId=$InvocationId;TaskState=[string]$task.State;LastTaskResult=$info.LastTaskResult;Completed=$false;Success=$false;ReceiptMissing=$true;TerminalWithoutReceipt=$terminal}|ConvertTo-Json -Compress;if($terminal){exit 1};exit 2}
        $r=Get-Content -LiteralPath $completion -Raw|ConvertFrom-Json
        $complete=($task.State -ne 'Running' -and $task.State -ne 'Queued')
        $ok=($complete -and $r.InvocationId -ceq $InvocationId -and $r.ExitCode -eq 0 -and $info.LastTaskResult -eq 0)
        @{InvocationId=$InvocationId;TaskState=[string]$task.State;LastTaskResult=$info.LastTaskResult;ExitCode=$r.ExitCode;Completed=$complete;Success=$ok;ReceiptPath=$completion;StatePath=$r.StatePath;StateSha256=$(if($r.PSObject.Properties['StateSha256']){$r.StateSha256}else{$null})}|ConvertTo-Json -Compress
        if(!$complete){exit 2};if(!$ok){exit 1};exit 0
    }
    if(!$Phase){throw 'phase required'}
    if((Test-Path -LiteralPath $requestPath) -or (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue)){throw 'invocation already exists; use Status'}
    $runner=Join-Path $PSScriptRoot 'upgrade.ps1';$ledger=Join-Path $PSScriptRoot '..\..\services\image2\ops\upgrade-ledger.mjs';$bff=Join-Path $PSScriptRoot 'bff-probe.mjs'
    $r=@{InvocationId=$InvocationId;Phase=$Phase;PlanPath=[IO.Path]::GetFullPath($PlanPath);PlanSha256=(Get-FileHash -LiteralPath $PlanPath -Algorithm SHA256).Hash.ToLowerInvariant();RunnerSha256=(Get-FileHash -LiteralPath $runner -Algorithm SHA256).Hash.ToLowerInvariant();LedgerSha256=(Get-FileHash -LiteralPath $ledger -Algorithm SHA256).Hash.ToLowerInvariant();BffSha256=(Get-FileHash -LiteralPath $bff -Algorithm SHA256).Hash.ToLowerInvariant();GateReceipt=$GateReceipt;GateSha256=$null;FrozenFiles=@{}}
    if($GateReceipt){$r.GateReceipt=[IO.Path]::GetFullPath($GateReceipt);$r.GateSha256=(Get-FileHash -LiteralPath $GateReceipt -Algorithm SHA256).Hash.ToLowerInvariant()}
    $r.BootstrapRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
    $manifestPath=Join-Path $r.BootstrapRoot 'UPGRADE-SOURCE.json'
    if((Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $plan.SourceManifestSha256){throw 'manifest drift'}
    if((Get-FileHash -LiteralPath $plan.SourceArchive -Algorithm SHA256).Hash.ToLowerInvariant() -cne $plan.SourceArchiveSha256){throw 'archive drift'}
    $manifest=Get-Content -LiteralPath $manifestPath -Raw|ConvertFrom-Json
    if($manifest.head -cne $plan.SourceCommit){throw 'source HEAD drift'}
    foreach($file in $manifest.files.PSObject.Properties){
        if($file.Name -match '(^|/)\.\.(/|$)|\\|:|^/|(^|/)\.env'){throw 'unsafe source path'}
        $digest=(Get-FileHash -LiteralPath (Join-Path $r.BootstrapRoot $file.Name) -Algorithm SHA256).Hash.ToLowerInvariant()
        if($digest -cne $file.Value){throw 'source drift'};$r.FrozenFiles[$file.Name]=$digest
    }
    $null=[IO.Directory]::CreateDirectory($root)
    $acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetAccessRuleProtection($true,$false)
    foreach($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'),[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))};(Get-Item -LiteralPath $root).SetAccessControl($acl)
    [IO.File]::WriteAllText($requestPath,($r|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
    # Interactive qrrwi context reaches their Docker Desktop engine; no password,
    # RunLevel elevation, SSH-owned jobs, auto-restart or automatic stage chaining.
    $args='-NoProfile -NonInteractive -File "'+$runner+'" -RequestFile "'+$requestPath+'"'
    $action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $args -WorkingDirectory $root
    $principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    $settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    $null=Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Settings $settings
    Start-ScheduledTask -TaskName $name
    @{InvocationId=$InvocationId;TaskName=$name;Submitted=$true;Completed=$false;RequestPath=$requestPath;ReceiptPath=$completion}|ConvertTo-Json -Compress
    exit 0
} catch {Write-Output '{"Success":false,"Error":"task request failed; raw output suppressed"}';exit 1}
