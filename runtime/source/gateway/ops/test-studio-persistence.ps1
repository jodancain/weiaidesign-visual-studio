param(
  [Parameter(Mandatory=$true)][string]$FixtureDirectory,
  [string]$Image = "",
  [string]$EvidencePath = ""
)
# Read-only fixture mount, dedicated named volume, no ports and no network.
# No production container, production volume or provider credential is touched.
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false
if (-not $Image) {
  $Image = (docker inspect --format '{{.Image}}' moneyprinterturbo-gateway 2>$null).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $Image) { throw "Pass an existing local Node 22 image with -Image" }
}
$fixturePath = (Resolve-Path $FixtureDirectory).Path
if (-not (Test-Path (Join-Path $fixturePath 'studio/container-persistence.mjs'))) { throw "FixtureDirectory must contain studio/container-persistence.mjs and its sibling modules" }
$testSuffix = [guid]::NewGuid().ToString('N')
$testVolume = "studio-v3-acceptance-$testSuffix"
$seedContainer = "studio-v3-seed-$testSuffix"
$restoreContainer = "studio-v3-restore-$testSuffix"
$results = @()
try {
  docker volume create $testVolume | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not create dedicated fixture volume" }
  foreach ($phase in @('seed','restore')) {
    $containerName = if ($phase -eq 'seed') { $seedContainer } else { $restoreContainer }
    $ErrorActionPreference = 'Continue'
    $output = @(docker run --rm --pull never --name $containerName --network none --read-only `
      --tmpfs /tmp --mount "type=volume,source=$testVolume,target=/data/studio" `
      --mount "type=bind,source=$fixturePath,target=/fixture,readonly" `
      --env STUDIO_DATA_DIR=/data/studio --env NODE_NO_WARNINGS=1 --entrypoint node $Image `
      /fixture/studio/container-persistence.mjs $phase 2>&1)
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    $resultLine = $output | ForEach-Object { "$_" } | Where-Object { $_.StartsWith('{') } | Select-Object -Last 1
    if ($exitCode -ne 0 -or -not $resultLine) { throw "Container $phase failed (exit $exitCode): $($output -join [Environment]::NewLine)" }
    $result = $resultLine | ConvertFrom-Json
    if (-not $result.passed) { throw "Container $phase did not pass" }
    $results += $result
  }
  if ($results[0].containerHostname -eq $results[1].containerHostname) { throw 'Expected two different containers' }
  $evidence = [ordered]@{ at=[DateTime]::UtcNow.ToString('o'); passed=$true; image=$Image; dedicatedVolume=$testVolume; network='none'; productionContainersChanged=$false; phases=$results }
  $json = $evidence | ConvertTo-Json -Depth 8
  if ($EvidencePath) { [IO.File]::WriteAllText($EvidencePath,$json,[Text.UTF8Encoding]::new($false)) }
  Write-Output $json
} finally {
  # These randomly named resources belong exclusively to this invocation.
  $ErrorActionPreference = 'Continue'
  docker rm -f $seedContainer $restoreContainer 2>&1 | Out-Null
  docker volume rm $testVolume 2>&1 | Out-Null
}
