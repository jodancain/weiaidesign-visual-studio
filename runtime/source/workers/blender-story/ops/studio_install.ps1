param(
  [string]$CodeDir = 'D:\studio-v3-worker',
  [string]$DataDir = 'D:\studio-v3-data',
  [string]$TokenFile = 'C:\Users\studio-user\studio-v3-production\private\studio-worker-token.txt',
  [int]$Port = 18088
)
$ErrorActionPreference = 'Stop'
$taskName = 'BlenderStudioV3Worker'
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  throw 'The V3 task already exists; inspect and explicitly stop/update it rather than overwriting it.'
}
if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) { throw "Port $Port is occupied" }
foreach ($relative in @('studio_service.py','studio_jobs.py','studio_render.py','ops\studio_run.ps1')) {
  if (-not (Test-Path -LiteralPath (Join-Path $CodeDir $relative) -PathType Leaf)) { throw "Incomplete worker: $relative" }
}
if (-not (Test-Path -LiteralPath $TokenFile -PathType Leaf)) { throw 'Private worker token file is required' }
New-Item -ItemType Directory -Force $DataDir | Out-Null
$account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$python = 'C:\Users\studio-user\AppData\Local\Programs\Python\Python311\python.exe'
$ffmpeg = 'C:\Users\studio-user\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.2-full_build\bin\ffmpeg.exe'
$configPath = Join-Path $DataDir 'runtime.json'
$config = [ordered]@{tokenFile=$TokenFile;host='127.0.0.1';port=$Port;renderDir=(Join-Path $DataDir 'renders');logDir=(Join-Path $DataDir 'logs');blenderBin='C:\Program Files\Blender Foundation\Blender 5.2\blender.exe';ffmpegBin=$ffmpeg;ffprobeBin=(Join-Path (Split-Path -Parent $ffmpeg) 'ffprobe.exe')}
[IO.File]::WriteAllText($configPath,($config|ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))
$arguments = '-u "' + (Join-Path $CodeDir 'studio_service.py') + '" --config "' + $configPath + '"'
# The scheduler owns Python directly: stopping the task cannot orphan a wrapper child.
$action = New-ScheduledTaskAction -Execute $python -Argument $arguments -WorkingDirectory $CodeDir
$principal = New-ScheduledTaskPrincipal -UserId $account -LogonType S4U -RunLevel Limited
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Trigger $trigger -Settings $settings | Out-Null
Start-ScheduledTask -TaskName $taskName
[ordered]@{task=$taskName;account=$account;logonType='S4U';trigger='AtStartup';port=$Port;host='127.0.0.1';dataDir=$DataDir} | ConvertTo-Json -Compress
