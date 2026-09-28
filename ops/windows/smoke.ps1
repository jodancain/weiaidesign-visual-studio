param(
  [string]$BaseUrl = "http://127.0.0.1:18192",
  [string]$Token = ""
)

$ErrorActionPreference = "Stop"
$BaseUrl = $BaseUrl.TrimEnd("/")

$health = Invoke-RestMethod "$BaseUrl/api/v1/health" -TimeoutSec 20
if ($health.status -ne "ok") {
  throw "Health response is not ok"
}
Write-Host "PASS health"

$openapi = Invoke-RestMethod "$BaseUrl/api/v1/openapi.json" -TimeoutSec 20
if (-not $openapi.paths) {
  throw "OpenAPI document has no paths"
}
Write-Host "PASS openapi"

try {
  Invoke-WebRequest "$BaseUrl/api/v1/images" -Method Post -ContentType "application/json" -Body "{}" -TimeoutSec 20 | Out-Null
  throw "Protected endpoint unexpectedly accepted an unauthenticated request"
} catch {
  $status = [int]$_.Exception.Response.StatusCode
  if ($status -ne 401) {
    throw "Expected unauthenticated status 401, received $status"
  }
}
Write-Host "PASS unauthenticated request returns 401"

if ($Token) {
  $headers = @{ Authorization = "Bearer $Token" }
  $body = @{
    mode = "plan"
    messages = @(@{ role = "user"; content = "Analyze only: plan a clean square visual for a contemporary womenswear brand. Do not generate an image." })
    canvas_state = @{}
  } | ConvertTo-Json -Depth 8
  $agent = Invoke-RestMethod "$BaseUrl/api/agent-chat" -Method Post -Headers $headers -ContentType "application/json" -Body $body -TimeoutSec 120
  if (-not $agent.data.plan -or -not $agent.data.model) {
    throw "Agent planning response is incomplete"
  }
  Write-Host "PASS agent plan (model returned, secret not printed)"
}

Write-Host "Smoke complete"
