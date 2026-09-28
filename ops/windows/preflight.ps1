param(
  [int]$Port = 18192
)

$ErrorActionPreference = "Stop"

function Require-Command([string]$Name) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $command) {
    throw "Missing required command: $Name"
  }
  Write-Host "OK  $Name -> $($command.Source)"
}

Require-Command git
Require-Command node
Require-Command npm
Require-Command docker
Require-Command tailscale
Require-Command ssh

docker version | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "Docker Desktop engine is not ready"
}

$tailscaleIp = tailscale ip -4 2>$null | Select-Object -First 1
if (-not $tailscaleIp) {
  throw "Tailscale is not connected"
}

$listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
if ($listener) {
  Write-Warning "Port $Port is already in use"
}

Write-Host "Node: $(node --version)"
Write-Host "npm: $(npm --version)"
Write-Host "Tailscale IPv4: $tailscaleIp"
Write-Host "Preflight complete"
