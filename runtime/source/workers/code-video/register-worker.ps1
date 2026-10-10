param(
 [string]$Release=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
 [string]$TaskName='WeiaiCodeVideoWorker',
 [string]$RuntimeFile='D:\studio-v3-data\runtime.json',
 [string]$DataDirectory='D:\studio-code-video\data',
 [string]$LogDirectory='D:\studio-code-video\logs',
 [int]$Port=18089
)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$Release=(Resolve-Path -LiteralPath $Release).Path
foreach($file in @('start-worker.ps1','daemon-job.ps1','worker.mjs')){if(-not(Test-Path -LiteralPath (Join-Path $Release ('workers\code-video\'+$file)))){throw 'Incomplete worker release'}}
$old=Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if($old -and $old.State -eq 'Running'){
 Stop-ScheduledTask -TaskName $TaskName
 $deadline=[DateTime]::UtcNow.AddSeconds(15)
 do{Start-Sleep -Milliseconds 100;$state=(Get-ScheduledTask -TaskName $TaskName).State}while($state -eq 'Running' -and [DateTime]::UtcNow -lt $deadline)
 if($state -eq 'Running'){throw 'Old task did not stop; no replacement started'}
}
# A pre-JobObject orphan must be inspected/terminated by its exact PID and path
# by the operator. Never kill arbitrary processes merely because they own a port.
$deadline=[DateTime]::UtcNow.AddSeconds(10)
do{$listeners=@(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue);if($listeners.Count){Start-Sleep -Milliseconds 100}}while($listeners.Count -and [DateTime]::UtcNow -lt $deadline)
if($listeners.Count){throw ('Port '+$Port+' is still owned by PID '+(($listeners|Select-Object -ExpandProperty OwningProcess -Unique)-join ',')+'. Inspect the old release; no process was killed and no new task was started.')}
foreach($value in @($Release,$RuntimeFile,$DataDirectory,$LogDirectory)){if($value.Contains('"') -or $value.Contains("`n") -or $value.Contains("`r")){throw 'Invalid task path'}}
$argument='-NoProfile -ExecutionPolicy Bypass -File "'+$Release+'\workers\code-video\start-worker.ps1" -Release "'+$Release+'" -RuntimeFile "'+$RuntimeFile+'" -DataDirectory "'+$DataDirectory+'" -LogDirectory "'+$LogDirectory+'" -Port '+$Port
$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argument -WorkingDirectory $Release
$principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $principal.UserId
$settings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -Trigger $trigger -Settings $settings -Description 'Limited interactive Studio worker held by kill-on-close JobObject; stopping the task kills only its own descendants.' -Force|Out-Null
Start-ScheduledTask -TaskName $TaskName
Get-ScheduledTask -TaskName $TaskName|Select-Object TaskName,State
