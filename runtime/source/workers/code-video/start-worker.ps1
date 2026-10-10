param(
 [string]$Release=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
 [string]$RuntimeFile='D:\studio-v3-data\runtime.json',
 [string]$DataDirectory='D:\studio-code-video\data',
 [string]$LogDirectory='D:\studio-code-video\logs',
 [int]$Port=18089
)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$runtime=Get-Content -Raw -LiteralPath $RuntimeFile|ConvertFrom-Json
$env:STUDIO_CODE_WORKER_TOKEN=(Get-Content -Raw -LiteralPath $runtime.tokenFile).Trim()
$env:STUDIO_CODE_DATA=$DataDirectory
$env:STUDIO_CODE_HOST='127.0.0.1'
$env:STUDIO_CODE_PORT=[string]$Port
$env:STUDIO_CHROME_BIN='C:\Program Files\Google\Chrome\Application\chrome.exe'
$env:STUDIO_CHROME_GL='angle'
if (-not $env:STUDIO_NR_EXE) { $env:STUDIO_NR_EXE=Join-Path $Release 'optional-tools\dlss5-convert.exe' }
$env:FFMPEG_BIN=$runtime.ffmpegBin
$env:FFPROBE_BIN=$runtime.ffprobeBin
$env:STUDIO_PYTHON_BIN='C:\Users\studio-user\AppData\Local\Programs\Python\Python311\python.exe'
$env:STUDIO_GPU_MUTEX='Global\WeiaiStudioGpuV1'
New-Item -ItemType Directory -Force -Path $LogDirectory|Out-Null
$Release=(Resolve-Path -LiteralPath $Release).Path
$stamp=[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')+'-'+$PID
& (Join-Path $Release 'workers\code-video\daemon-job.ps1') -Node 'C:\Program Files\nodejs\node.exe' -Script (Join-Path $Release 'workers\code-video\worker.mjs') -WorkingDirectory $Release -StdoutLog (Join-Path $LogDirectory 'worker.stdout.log') -StderrLog (Join-Path $LogDirectory 'worker.stderr.log') -LifecyclePath (Join-Path $LogDirectory ('worker-lifecycle-'+$stamp+'.json'))
exit $LASTEXITCODE
