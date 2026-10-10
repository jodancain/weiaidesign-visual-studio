$port = if ($env:STORY_WORKER_PORT) { [int]$env:STORY_WORKER_PORT } else { 18087 }
try { Invoke-RestMethod "http://127.0.0.1:$port/health" -TimeoutSec 5 | ConvertTo-Json -Depth 4 }
catch { Write-Output "worker not responding on $port" }
