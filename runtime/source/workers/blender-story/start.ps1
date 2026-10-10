# Start the Blender Story worker detached from the calling session.
#
# A plain Start-Process from a non-interactive SSH session dies with the session (the child
# inherits the sshd job object). Registering a Scheduled Task and triggering it runs the
# worker under the Task Scheduler service instead, which also gives us boot-time autostart.
# Idempotent: re-registers the task definition, and does nothing if the port is already served.
$ErrorActionPreference = "Stop"
$port   = if ($env:STORY_WORKER_PORT) { [int]$env:STORY_WORKER_PORT } else { 18087 }
$assets = if ($env:STORY_ASSETS_DIR) { $env:STORY_ASSETS_DIR } else { "D:\story-assets" }
$here   = $PSScriptRoot
if (-not $here) { $here = Split-Path -Parent $MyInvocation.MyCommand.Definition }
# app.py imports Studio v3 at startup; fail clearly before changing task registration
# when a partial legacy deployment copied app.py without its new sibling modules.
foreach ($required in @("app.py", "studio_jobs.py", "studio_render.py", "assets\manifest.json")) {
  if (-not (Test-Path -LiteralPath (Join-Path $here $required) -PathType Leaf)) {
    throw "Incomplete Blender Story worker bundle: missing $required. Copy the full worker bundle before starting."
  }
}
$log    = Join-Path $assets "worker.log"
$task   = "BlenderStoryWorker"

New-Item -ItemType Directory -Force $assets | Out-Null
$py = (Get-Command python).Source
$cmdArgs = "/c `"`"$py`" -u `"$here\app.py`" >> `"$log`" 2>&1`""

$action   = New-ScheduledTaskAction -Execute "cmd.exe" -Argument $cmdArgs -WorkingDirectory $here
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null

if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
  Write-Output "port $port already listening; task '$task' (re)registered, not restarted"
  exit 0
}
Start-ScheduledTask -TaskName $task
Start-Sleep -Seconds 5
if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
  Write-Output "started via scheduled task '$task', listening on $port; log $log"
} else {
  Write-Output "task started but port $port not listening yet; log tail:"
  if (Test-Path $log) { Get-Content $log -Tail 20 }
}
