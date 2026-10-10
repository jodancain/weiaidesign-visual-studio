$task = "BlenderStoryWorker"
$port = if ($env:STORY_WORKER_PORT) { [int]$env:STORY_WORKER_PORT } else { 18087 }
Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
$conn = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
if ($conn) { Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue; Write-Output "stopped pid $($conn.OwningProcess)" }
else { Write-Output "nothing listening on $port" }
