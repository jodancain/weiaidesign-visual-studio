param(
  [Parameter(Mandatory=$true)][string]$FixtureDirectory,
  [Parameter(Mandatory=$true)][string]$EvidenceDirectory,
  [string]$Image = "",
  [string]$Dockerfile = "ops/Dockerfile"
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$fixturePath = (Resolve-Path $FixtureDirectory).Path
$evidencePath = (Resolve-Path $EvidenceDirectory).Path
$suffix = [guid]::NewGuid().ToString('N')
if (-not $Image) { $Image = "studio-v3-image-acceptance:$suffix" }
$container = "studio-v3-image-$suffix"
$volume = "studio-v3-image-$suffix"
$buildLog = Join-Path $evidencePath 'docker-build.log'
try {
  # Only this newly packaged, credential-free fixture is the build context.
  $ErrorActionPreference = 'Continue'
  docker build --progress plain --tag $Image --file (Join-Path $fixturePath $Dockerfile) $fixturePath *> $buildLog
  $buildExit = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  if ($buildExit -ne 0) { throw "Docker build failed ($buildExit). See $buildLog" }
  $imageId = (docker image inspect --format '{{.Id}}' $Image).Trim()
  if ($LASTEXITCODE -ne 0) { throw 'Built image was not found' }
  docker volume create $volume | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not create isolated volume' }
  docker run --detach --pull never --name $container --network none --read-only --tmpfs /tmp `
    --mount "type=volume,source=$volume,target=/data/studio" `
    --env STUDIO_DATA_DIR=/data/studio --env MPT_CONFIG_PATH=/config.toml --env MPT_LOCAL_VIDEO_DIR=/tmp/videos `
    --env VIDEO_API_TOKEN=isolated-image-test-capability --env PORT=18082 --env NODE_NO_WARNINGS=1 $Image | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not start isolated gateway' }
  $ErrorActionPreference = 'Continue'
  $output = @(docker exec $container node /studio/image-acceptance.mjs 2>&1)
  $smokeExit = $LASTEXITCODE
  docker logs $container *> (Join-Path $evidencePath 'docker-gateway.log')
  $ErrorActionPreference = 'Stop'
  $resultLine = $output | ForEach-Object { "$_" } | Where-Object { $_.StartsWith('{') } | Select-Object -Last 1
  if ($smokeExit -ne 0 -or -not $resultLine) { throw "Baked image acceptance failed ($smokeExit): $($output -join [Environment]::NewLine)" }
  $runtime = $resultLine | ConvertFrom-Json
  if (-not $runtime.passed) { throw 'Baked image acceptance did not pass' }
  foreach ($entry in $runtime.sourceHashes.psobject.Properties) {
    $sourceHash = (Get-FileHash (Join-Path $fixturePath $entry.Name) -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($sourceHash -ne $entry.Value) { throw "Baked source mismatch: $($entry.Name)" }
  }
  & (Join-Path $fixturePath 'ops/test-studio-persistence.ps1') -FixtureDirectory $fixturePath -Image $Image -EvidencePath (Join-Path $evidencePath 'container-recreation-schema2.json') | Out-Null
  $persistence = Get-Content -Raw (Join-Path $evidencePath 'container-recreation-schema2.json') | ConvertFrom-Json
  if (-not $persistence.passed -or $persistence.phases[1].schemaVersion -ne 2 -or -not $persistence.phases[1].completedAliasPreserved) { throw 'Schema 2 persistence failed' }
  $buildContext = [ordered]@{ dockerfile=$Dockerfile; dockerfileSha256=(Get-FileHash (Join-Path $fixturePath $Dockerfile) -Algorithm SHA256).Hash.ToLowerInvariant() }
  if (Test-Path (Join-Path $fixturePath '.dockerignore')) { $buildContext.dockerignoreSha256=(Get-FileHash (Join-Path $fixturePath '.dockerignore') -Algorithm SHA256).Hash.ToLowerInvariant() }
  $receipt = [ordered]@{ at=[DateTime]::UtcNow.ToString('o'); passed=$true; image=$Image; imageId=$imageId; buildExitCode=$buildExit; buildContext=$buildContext; sourceHashesVerified=$true; runtime=$runtime; persistence=$persistence; productionContainersChanged=$false; productionVolumesUsed=$false }
  $json = $receipt | ConvertTo-Json -Depth 12
  [IO.File]::WriteAllText((Join-Path $evidencePath 'docker-image-acceptance.json'),$json,[Text.UTF8Encoding]::new($false))
  Write-Output $json
} finally {
  $ErrorActionPreference = 'Continue'
  docker rm -f $container 2>&1 | Out-Null
  docker volume rm $volume 2>&1 | Out-Null
  # Keep the uniquely tagged test image and logs as build evidence; no image pruning.
}
