$ErrorActionPreference = "Continue"
$PSNativeCommandUseErrorActionPreference = $false
$dir = "C:\Users\qrrwi\build\weiaidesign-web"
$log = "C:\Users\qrrwi\build\weiaidesign-web-build.log"
"=== build start $(Get-Date -Format s) ===" | Out-File $log -Encoding utf8
Set-Location $dir
docker compose -p weiaidesign-web -f "$dir\docker-compose.yml" build 2>&1 | Out-File $log -Append -Encoding utf8
"=== build exit $LASTEXITCODE $(Get-Date -Format s) ===" | Out-File $log -Append -Encoding utf8
