param(
  [string]$CodeDir = 'D:\studio-v3-worker',
  [string]$DataDir = 'D:\studio-v3-data',
  [string]$TokenFile = 'C:\Users\studio-user\studio-v3-production\private\studio-worker-token.txt',
  [int]$Port = 18088,
  [string]$ListenHost = '127.0.0.1'
)
$ErrorActionPreference = 'Stop'
$python = 'C:\Users\studio-user\AppData\Local\Programs\Python\Python311\python.exe'
$blender = 'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe'
$ffmpeg = 'C:\Users\studio-user\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.2-full_build\bin\ffmpeg.exe'
$ffprobe = Join-Path (Split-Path -Parent $ffmpeg) 'ffprobe.exe'
$entry = Join-Path $CodeDir 'studio_service.py'
foreach ($path in @($python, $blender, $ffmpeg, $ffprobe, $entry, $TokenFile)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required runtime file is absent: $path" }
}
$token = [IO.File]::ReadAllText($TokenFile).Trim()
if ($token -notmatch '^[a-f0-9]{64}$') { throw 'Worker token must be 32 random bytes encoded as hex' }
$env:STUDIO_WORKER_TOKEN = $token
$env:STUDIO_WORKER_HOST = $ListenHost
$env:STORY_WORKER_PORT = [string]$Port
$env:STUDIO_RENDER_DIR = Join-Path $DataDir 'renders'
$env:BLENDER_BIN = $blender
$env:FFMPEG_BIN = $ffmpeg
$env:FFPROBE_BIN = $ffprobe
$env:PYTHONUNBUFFERED = '1'
$env:STUDIO_RENDER_ENGINE = 'BLENDER_EEVEE'
$logs = Join-Path $DataDir 'logs'
New-Item -ItemType Directory -Force $logs, $env:STUDIO_RENDER_DIR | Out-Null
Set-Location -LiteralPath $CodeDir
$stdout = Join-Path $logs 'worker-stdout.log'
$stderr = Join-Path $logs 'worker-stderr.log'
# cmd owns redirection so native stderr cannot prematurely end the PowerShell wrapper.
$command = '""' + $python + '" -u "' + $entry + '" >> "' + $stdout + '" 2>> "' + $stderr + '""'
& $env:ComSpec /d /s /c $command
exit $LASTEXITCODE
