$PSNativeCommandUseErrorActionPreference = $false
$dir = "C:\Users\qrrwi\build\weiaidesign-web"
Set-Location $dir
docker compose -p weiaidesign-web -f "$dir\docker-compose.yml" up -d --no-build 2>&1 | Out-String
Start-Sleep -Seconds 8
docker ps --filter name=weiaidesign-web --format '{{.Names}} {{.Status}} {{.Image}}'
docker inspect weiaidesign-web --format '{{.Image}}'
docker volume ls --filter name=weiaidesign --format '{{.Name}}'
docker inspect weiaidesign-web --format '{{range .Mounts}}{{.Name}} -> {{.Destination}}{{end}}'
try { (Invoke-RestMethod http://127.0.0.1:18191/api/v1/health -TimeoutSec 15 | ConvertTo-Json -Compress) } catch { "health err: $_" }
