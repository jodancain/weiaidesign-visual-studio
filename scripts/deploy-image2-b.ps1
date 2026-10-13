#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_-]{3,63}$')][string]$ReleaseId,
    [Parameter(Mandatory = $true)][string]$SourceArchive,
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedSha,
    [Parameter(Mandatory = $true)][ValidateSet('Prepare','Canary','Cutover','Rollback')][string]$Phase,
    [string]$GateReceipt,
    [switch]$DryRun
)

# Runs on the already inspected Windows AI host. No SSH, tunnel changes, or provider submissions.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)
$ExpectedSha = $ExpectedSha.ToLowerInvariant()
$ProductionRoot = 'C:\Users\qrrwi\studio-v3-production'
$ReleaseRoot = Join-Path $ProductionRoot "releases\$ReleaseId"
$SourceRoot = Join-Path $ReleaseRoot 'web'
$PrivateBase = Join-Path $ProductionRoot 'private\image2'
$PrivateRoot = Join-Path $PrivateBase $ReleaseId
$BackupRoot = Join-Path $PrivateRoot 'backup'
$StatePath = Join-Path $PrivateRoot 'release-state.json'
if (!$GateReceipt) { $GateReceipt = Join-Path $PrivateRoot 'gate-receipt.json' }
$AppNetwork = 'weiai-studio-v3-production'
$WebName = 'weiai-studio-v3-web'
$GatewayName = 'weiai-studio-v3-gateway'
$LegacyWebName = 'weiaidesign-web'
$CoreName = 'weiai-image2'
$CoreVolume = 'weiai-image2-data'
$LegacyVolume = 'weiaidesign-web_weiaidesign-data'
$GatewayVolume = 'weiai-studio-v3-production-data'
$CanaryName = "weiai-image2-web-canary-$ReleaseId"
$CanaryVolume = "weiai-image2-web-canary-data-$ReleaseId"
$RestoreVolume = "weiai-image2-restore-check-$ReleaseId"
$OldWebName = "weiai-studio-v3-web-pre-image2-$ReleaseId"
$OldCoreName = "weiai-image2-pre-production-$ReleaseId"
$NewWebTag = "weiai-studio-v3-web:image2-$ReleaseId"
$NewCoreTag = "weiai-image2:$ReleaseId"
$OriginalWebEnv = Join-Path $ProductionRoot 'private\web-runtime.env'
$OriginalGatewayEnv = Join-Path $ProductionRoot 'private\gateway-runtime.env'
$CoreCanaryEnv = Join-Path $PrivateRoot 'image2-canary.env'
$WebCanaryEnv = Join-Path $PrivateRoot 'web-canary.env'
$CoreProductionEnv = Join-Path $PrivateRoot 'image2-production.env'
$WebProductionEnv = Join-Path $PrivateRoot 'web-production.env'
$script:Step = 'parameters'
$script:FailureCode = 'phase_failed'
$script:PausedWebs = @()
$script:State = $null
$script:Lock = $null

function Field($Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    if ($Object -is [Collections.IDictionary]) { return $Object[$Name] }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -ne $property) { return $property.Value }
    return $null
}
function Fail([string]$Code, [string]$Message) {
    $script:FailureCode = $Code
    throw [InvalidOperationException]::new($Message)
}
function Require($Condition, [string]$Code, [string]$Message) { if (!$Condition) { Fail $Code $Message } }
function Require-True($Object, [string]$Name) {
    $value = Field $Object $Name
    Require (($value -is [bool]) -and $value) 'gate_rejected' "$Name must be the boolean true in the acceptance receipt."
}
function Require-False($Object, [string]$Name) {
    $value = Field $Object $Name
    Require (($value -is [bool]) -and !$value) 'gate_rejected' "$Name must remain the boolean false while acceptance is pending."
}
function Read-Json([string]$Path) {
    Require (Test-Path -LiteralPath $Path -PathType Leaf) 'receipt_missing' 'Required release receipt is missing.'
    try { return [IO.File]::ReadAllText($Path) | ConvertFrom-Json } catch { Fail 'receipt_invalid' 'Release receipt is not valid JSON.' }
}
function Assert-GateFlags {
    $script:Step = 'acceptance-gate'
    $gate = Read-Json $GateReceipt
    $deployFirst = Field $gate 'DeployBeforeUiTesting'
    Require (($null -eq $deployFirst) -or ($deployFirst -is [bool])) 'gate_rejected' 'DeployBeforeUiTesting must be a JSON boolean when supplied.'
    if ($deployFirst -eq $true) {
        # The user changed the order, not the acceptance facts. Infrastructure gates remain below.
        foreach ($name in @('GateBPassed','OriginalPagePassed','CanaryPassed')) { Require-False $gate $name }
        Require ((Field $gate 'AuthorizationSource') -ceq 'user') 'deployment_authorization_missing' 'Deploy-first requires direct user authorization.'
        $instruction = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('5YWI6YOo572y55Sf5Lqn5YaN5rWL6K+V'))
        Require ((Field $gate 'AuthorizationInstruction') -ceq $instruction) 'deployment_authorization_missing' 'Deploy-first receipt must preserve the explicit user instruction.'
        Require-True $gate 'PostDeploymentTestingRequired'
    } else {
        foreach ($name in @('GateBPassed','OriginalPagePassed','CanaryPassed')) { Require-True $gate $name }
    }
    Require ((Field $gate 'ReleaseId') -ceq $ReleaseId) 'gate_release_mismatch' 'Gate receipt belongs to another release.'
    Require ((Field $gate 'SourceSha256') -ceq $ExpectedSha) 'gate_source_mismatch' 'Gate receipt does not bind the supplied source archive.'
    foreach ($name in @('GenerationCalls','LlmCalls','VisionCalls')) {
        $value = Field $gate $name
        Require ((($value -is [int]) -or ($value -is [long]) -or ($value -is [double])) -and ($value -eq 0)) 'gate_model_calls' 'Canary receipt must record zero model calls as numbers.'
    }
    return $gate
}

# CUTOVER_GATE precedes host checks, environment reads, locks and all mutating phases.
$gate = $null
if ($Phase -eq 'Cutover') { $gate = Assert-GateFlags }
if ($DryRun) {
    # Plan only: never invokes Docker, accesses runtime environments, or writes a receipt.
    $steps = @{
        Prepare = @('VerifyArchive','ComparePrivateConfigBoolean','ReadActivity','OnlineSQLiteBackup','PauseBothWebWriters','ArchiveLegacyVolume','UnpauseFinally','RestoreIntoIsolatedVolumes','VerifySQLiteAndAssets','BuildPinnedReleaseImages')
        Canary = @('RequirePrepareReceipt','CreatePrivateModelBlankConfig','StartCoreWithoutPublishedPorts','StartWebOn12700118196','ReadHealthBuildIdCapabilities','RecordRuntimeReadyOnly')
        Cutover = @('RequireBoundAcceptanceOrExplicitDeployBeforeUiTestingReceipt','RequireRestoreReceipt','RequireCanaryRuntimeReady','RecheckImageDigestsConfigActivity','PromoteCoreWithSameLedger','ReplaceOnlyWeb18194','ReadbackOrRestoreOldWeb','RunPendingOriginalPageTestsAfterAuthorizedDeployFirst')
        Rollback = @('RequireMatchingReleaseAndOldContainerDigest','StopAndRetainCandidateWeb','StartOriginalWebOn18194','PreserveAllLedgersAndVolumes')
    }
    [ordered]@{ DryRun=$true; DeploymentExecuted=$false; Phase=$Phase; ReleaseId=$ReleaseId; SourceSha256=$ExpectedSha; GateRequired=($Phase -eq 'Cutover'); DeployBeforeUiTesting=((Field $gate 'DeployBeforeUiTesting') -eq $true); PostDeploymentTestingRequired=((Field $gate 'DeployBeforeUiTesting') -eq $true); Steps=$steps[$Phase]; CorePublishedPorts=@(); CanaryBinding='127.0.0.1:18196:18084'; CutoverBinding='18194:18084'; AppNetwork=$AppNetwork; RuntimeConfigRead=$false } | ConvertTo-Json -Depth 5 -Compress
    return
}

function Invoke-Docker([string[]]$Arguments, [string]$Label, [string]$InputText) {
    $script:Step = $Label
    # Native stderr is captured in memory, including inspect output. Never emit it or Config.Env.
    $local:ErrorActionPreference = 'Continue'
    if ($PSBoundParameters.ContainsKey('InputText')) { $raw = @($InputText | & docker @Arguments 2>&1 | ForEach-Object { [string]$_ }) }
    else { $raw = @(& docker @Arguments 2>&1 | ForEach-Object { [string]$_ }) }
    $code = $LASTEXITCODE
    if ($code -ne 0) { Fail 'docker_action_failed' "Docker action $Label failed; raw output was suppressed." }
    return ($raw -join "`n").Trim()
}
function Docker-Object([string]$Kind, [string]$Name) {
    $text = Invoke-Docker -Arguments @($Kind,'inspect',$Name) -Label "inspect-$Kind"
    try { $items = @($text | ConvertFrom-Json); Require ($items.Count -eq 1) 'inspect_invalid' 'Unexpected Docker inspect result.'; return $items[0] }
    catch { Fail 'inspect_invalid' 'Docker inspect result was invalid; raw output was suppressed.' }
}
function Container-Exists([string]$Name) {
    $names = Invoke-Docker -Arguments @('ps','-a','--format','{{.Names}}') -Label 'container-names'
    return @($names -split '\r?\n') -contains $Name
}
function Safe-Container([string]$Name) {
    $c = Docker-Object 'container' $Name
    $network = Field (Field $c.NetworkSettings 'Networks') $AppNetwork
    return [ordered]@{ Name=$Name; Id=$c.Id; ImageId=$c.Image; ImageTag=$c.Config.Image; Running=[bool]$c.State.Running; Paused=[bool]$c.State.Paused; NetworkPresent=($null -ne $network); Ports=$c.NetworkSettings.Ports; Mounts=@($c.Mounts | ForEach-Object { [ordered]@{Name=$_.Name;Type=$_.Type;Destination=$_.Destination;RW=$_.RW} }); ReleaseLabel=(Field $c.Config.Labels 'weiai.image2.release'); SourceLabel=(Field $c.Config.Labels 'weiai.image2.source-sha') }
}
function Read-EnvMap([string]$Path) {
    Require (Test-Path -LiteralPath $Path -PathType Leaf) 'private_config_missing' 'Required private runtime configuration is missing.'
    $map = @{}
    foreach ($line in [IO.File]::ReadAllLines($Path)) {
        if ($line -match '^\s*(#|$)') { continue }
        Require ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$') 'private_config_invalid' 'Private runtime configuration must use literal KEY=value lines.'
        $key = $Matches[1]; $value = $Matches[2]
        Require (!$map.ContainsKey($key)) 'private_config_invalid' 'Duplicate private runtime configuration field.'
        $map[$key] = $value
    }
    return $map
}
function Assert-PrivateConfig([string]$Container, [string]$Path) {
    $file = Read-EnvMap $Path; $live = @{}; $c = Docker-Object 'container' $Container
    foreach ($pair in $c.Config.Env) { $parts = $pair -split '=',2; if ($parts.Count -eq 2) { $live[$parts[0]] = $parts[1] } }
    $matches = $true
    foreach ($key in $file.Keys) { if (!$live.ContainsKey($key) -or $live[$key] -cne $file[$key]) { $matches = $false } }
    Require $matches 'private_config_drift' 'Private runtime configuration differs from the actual container; only this boolean result is recorded.'
    return [ordered]@{ Matches=$matches; ComparedFieldCount=$file.Count }
}
function Guest-Secret($Map) {
    foreach ($key in @('STUDIO_VISITOR_SECRET','VIDEO_API_PROXY_TOKEN','VIDEO_API_TOKEN')) { if ($Map.ContainsKey($key) -and $Map[$key]) { return $Map[$key] } }
    Fail 'visitor_secret_missing' 'Original signed visitor configuration is unavailable.'
}
function Protect-PrivateDirectory([string]$Path) {
    $null = [IO.Directory]::CreateDirectory($Path)
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true,$false)
    $current = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl.SetOwner($current)
    foreach ($sid in @($current,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'),[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}
function Write-Env([string]$Path, $Map) {
    $lines = @($Map.Keys | Sort-Object | ForEach-Object { "$_=$($Map[$_])" })
    [IO.File]::WriteAllLines($Path,$lines,[Text.UTF8Encoding]::new($false))
}
function Save-State {
    $script:State.UpdatedAt = (Get-Date).ToUniversalTime().ToString('o')
    $temp = "$StatePath.partial"
    [IO.File]::WriteAllText($temp,($script:State | ConvertTo-Json -Depth 14),[Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temp -Destination $StatePath -Force
}
function Require-State {
    $script:State = Read-Json $StatePath
    Require (($script:State.ReleaseId -ceq $ReleaseId) -and ($script:State.SourceSha256 -ceq $ExpectedSha)) 'state_source_mismatch' 'Release state is bound to another source archive.'
    Require ($script:State.Prepared -is [bool] -and $script:State.Prepared) 'prepare_required' 'Prepare has not completed successfully.'
}
function Invoke-Node([string]$Container,[string]$Code) {
    $json = Invoke-Docker -Arguments @('exec','-i',$Container,'node','--no-warnings','--input-type=module') -Label 'node-read-or-backup' -InputText $Code
    try { return $json | ConvertFrom-Json } catch { Fail 'node_receipt_invalid' 'Node receipt is invalid; raw output was suppressed.' }
}
$LedgerCode = @'
import {DatabaseSync} from 'node:sqlite';
const d=new DatabaseSync('/data/studio/studio.sqlite',{readOnly:true});
const r={schemaVersion:d.prepare('PRAGMA user_version').get().user_version,quickCheck:d.prepare('PRAGMA quick_check').get().quick_check,projects:d.prepare('SELECT COUNT(*) AS n FROM projects').get().n,assets:d.prepare('SELECT COUNT(*) AS n FROM assets').get().n,jobStates:d.prepare('SELECT state,COUNT(*) AS count FROM jobs GROUP BY state ORDER BY state').all()};
d.close();console.log(JSON.stringify(r));
'@
$LegacyJobsCode = @'
import {existsSync,readdirSync,readFileSync} from 'node:fs';
const p='/data/generated_images/_jobs',counts={},r={parseErrors:0,present:existsSync(p)};
if(r.present)for(const name of readdirSync(p).filter(n=>n.endsWith('.json'))){try{const j=JSON.parse(readFileSync(p+'/'+name,'utf8')),k=String(j.state||'unknown');counts[k]=(counts[k]||0)+1;}catch{r.parseErrors++;}}
r.states=counts;console.log(JSON.stringify(r));
'@
$CoreLedgerCode = @'
import {DatabaseSync} from 'node:sqlite';
const d=new DatabaseSync('/data/image2/image2.sqlite',{readOnly:true});
const tables=new Set(d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name));
const r={quickCheck:d.prepare('PRAGMA quick_check').get().quick_check,jobs:[],runs:[],generationCalls:0,llmCalls:0,visionCalls:0};
if(tables.has('jobs'))for(const row of d.prepare('SELECT json FROM jobs').all()){const j=JSON.parse(row.json);r.jobs.push(j.state);for(const k of ['generationCalls','llmCalls','visionCalls'])r[k]+=Number(j.metrics?.[k]||0);}
if(tables.has('runs'))r.runs=d.prepare('SELECT json FROM runs').all().map(x=>JSON.parse(x.json).state);
d.close();console.log(JSON.stringify(r));
'@
function Assert-NoActivity {
    $ledger = Invoke-Node $GatewayName $LedgerCode
    Require ($ledger.quickCheck -eq 'ok') 'ledger_invalid' 'V3 database quick_check failed.'
    $active = @($ledger.jobStates | Where-Object { $_.state -notin @('complete','failed','cancelled') })
    Require ($active.Count -eq 0) 'existing_task_active' 'V3 has active/unknown tasks. Preserve receipts; do not interrupt or resubmit.'
    foreach ($name in @($WebName,$LegacyWebName)) {
        $legacy = Invoke-Node $name $LegacyJobsCode
        Require (($legacy.parseErrors -eq 0) -and $legacy.present) 'legacy_ledger_unknown' 'Legacy image task state is missing or unreadable.'
        foreach ($property in $legacy.states.PSObject.Properties) { Require ($property.Name -in @('done','failed','cancelled')) 'legacy_task_active' 'Legacy image tasks remain active or unknown.' }
    }
    return $ledger
}
function Assert-CoreIdle([switch]$ZeroModels) {
    $ledger = Invoke-Node $CoreName $CoreLedgerCode
    Require ($ledger.quickCheck -eq 'ok') 'core_ledger_invalid' 'Image2 database quick_check failed.'
    Require (@($ledger.jobs | Where-Object { $_ -notin @('complete','failed','cancelled') }).Count -eq 0) 'core_task_active' 'Image2 contains active or uncertain jobs; preserve the ledger.'
    Require (@($ledger.runs | Where-Object { $_ -notin @('complete','failed','cancelled') }).Count -eq 0) 'core_run_active' 'Image2 contains active or uncertain runs; preserve the ledger.'
    if ($ZeroModels) { Require (($ledger.generationCalls -eq 0) -and ($ledger.llmCalls -eq 0) -and ($ledger.visionCalls -eq 0)) 'canary_model_calls' 'Canary recorded a model call; cutover is refused.' }
    return $ledger
}
function Ensure-Volume([string]$Name) {
    $names = (Invoke-Docker -Arguments @('volume','ls','--format','{{.Name}}') -Label 'volume-names') -split '\r?\n'
    if ($names -contains $Name) {
        $v = Docker-Object 'volume' $Name
        Require ((Field $v.Labels 'weiai.image2.release') -ceq $ReleaseId) 'volume_owner_unknown' 'An existing target volume belongs to another or unknown release.'
    } else { $null = Invoke-Docker -Arguments @('volume','create','--label',"weiai.image2.release=$ReleaseId",$Name) -Label 'create-isolated-volume' }
}
function Assert-OriginalWeb {
    $web = Safe-Container $WebName
    Require ($web.Running -and !$web.Paused -and $web.NetworkPresent) 'web_not_ready' 'Original production web is not running on the expected network.'
    Require (@($web.Mounts | Where-Object { $_.Name -eq $LegacyVolume -and $_.Destination -eq '/data' }).Count -eq 1) 'web_mount_mismatch' 'Original web data mount differs from inspection.'
    $bindings = Field $web.Ports '18084/tcp'
    Require (@($bindings | Where-Object { $_.HostPort -eq '18194' }).Count -gt 0) 'web_port_mismatch' 'Original production web is not bound to 18194.'
    if ($null -ne $script:State -and $null -ne (Field $script:State 'OriginalWeb')) { Require ($web.ImageId -ceq $script:State.OriginalWeb.ImageId) 'production_superseded' 'Production image changed after Prepare. Rebase the release; do not overwrite it.' }
    return $web
}
function Unpause-Webs {
    $failed = @()
    foreach ($name in $script:PausedWebs) {
        try { $c = Safe-Container $name; if ($c.Paused) { $null = Invoke-Docker -Arguments @('unpause',$name) -Label 'unpause-web' } }
        catch { $failed += $name }
    }
    $script:PausedWebs = $failed
    if ($failed.Count) { Fail 'unpause_required' 'A paused original web could not be resumed. The release remains failed and needs recovery.' }
}
function Check-Archive {
    Require (Test-Path -LiteralPath $SourceArchive -PathType Leaf) 'source_missing' 'Source archive is missing.'
    Require ((Get-FileHash -LiteralPath $SourceArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $ExpectedSha) 'source_hash_mismatch' 'Source archive SHA-256 does not match the frozen release.'
    $local:ErrorActionPreference='Continue'
    $entries=@(& tar -tzf $SourceArchive 2>&1 | ForEach-Object {[string]$_});$code=$LASTEXITCODE
    Require ($code -eq 0 -and $entries.Count -gt 0) 'archive_invalid' 'Cannot list the source archive.'
    foreach($entry in $entries){$path=$entry.Replace('\','/');Require ($path -notmatch '^/|^[A-Za-z]:|(^|/)\.\.(/|$)' -and $path -notmatch '[\x00-\x1f]') 'archive_unsafe' 'Source archive contains an unsafe path.'
        Require ($path -notmatch '(^|/)(node_modules|\.git|\.next|runtime|data|models)(/|$)') 'archive_private' 'Source archive contains runtime/private directories.'
        Require (($path -notmatch '(^|/)\.env(?:\.[^/]*)?(/|$)') -or ($path -match '(^|/)\.env\.example$')) 'archive_private' 'Source archive contains private environment files.'
    }
    $verbose=@(& tar -tvzf $SourceArchive 2>&1 | ForEach-Object {[string]$_});Require ($LASTEXITCODE -eq 0) 'archive_invalid' 'Cannot validate archive entry types.'
    Require (@($verbose | Where-Object {$_ -match '^[lh]'}).Count -eq 0) 'archive_links' 'Source archive symlinks and hardlinks are not allowed.'
}
function New-Token {
    $bytes=New-Object byte[] 32;$rng=[Security.Cryptography.RandomNumberGenerator]::Create()
    try{$rng.GetBytes($bytes)}finally{$rng.Dispose()};return [Convert]::ToBase64String($bytes)
}
function Write-CanaryConfig {
    $original=Read-EnvMap $OriginalWebEnv
    if(Test-Path -LiteralPath $CoreCanaryEnv){$core=Read-EnvMap $CoreCanaryEnv;Require ($core.ContainsKey('IMAGE2_API_TOKEN') -and $core.IMAGE2_API_TOKEN.Length -ge 24) 'core_token_invalid' 'Existing private Image2 token is invalid.'}
    else{$core=@{IMAGE2_API_TOKEN=(New-Token);IMAGE2_DATA_DIR='/data/image2';PORT='18088';HOSTNAME='0.0.0.0'}}
    $web=@{};foreach($key in $original.Keys){if($key -notmatch '^(IMAGE2_|IMAGE_OPENAI_|OPENAI_|AGENT_LLM_|GPU_COMFY_)'){$web[$key]=$original[$key]}}
    foreach($key in @('IMAGE_OPENAI_BASE_URL','IMAGE_OPENAI_API_KEY','OPENAI_API_KEY','AGENT_LLM_BASE_URL','AGENT_LLM_API_KEY','GPU_COMFY_BASE_URL','GPU_COMFY_TOKEN')){$web[$key]=''}
    $web.IMAGE2_API_URL='http://image2:18088';$web.IMAGE2_API_TOKEN=$core.IMAGE2_API_TOKEN
    Require ((Guest-Secret $web) -ceq (Guest-Secret $original)) 'visitor_secret_changed' 'Canary cannot change the signed guest identity.'
    Write-Env $CoreCanaryEnv $core;Write-Env $WebCanaryEnv $web
}
function Verify-Image([string]$Tag,[string]$ExpectedId) { $i=Docker-Object 'image' $Tag;Require ($i.Id -ceq $ExpectedId) 'image_digest_drift' 'Release image tag no longer resolves to its frozen image.';return $i.Id }
function Start-Core([string]$EnvFile) {
    # CORE_NO_PUBLISH: never publish host 18088; the native video worker already owns it.
    $null=Invoke-Docker -Arguments @('run','-d','--name',$CoreName,'--restart','unless-stopped','--network',$AppNetwork,'--network-alias','image2','--label',"weiai.image2.release=$ReleaseId",'--label',"weiai.image2.source-sha=$ExpectedSha",'--env-file',$EnvFile,'--mount',"type=volume,source=$CoreVolume,target=/data/image2",$script:State.NewCoreImageId) -Label 'start-internal-image2'
}
function Wait-Core {
    $code=@'
const r=await fetch('http://127.0.0.1:18088/health',{signal:AbortSignal.timeout(4000)});
if(!r.ok)process.exit(1);const j=await r.json();if(j.status!=='ok'||j.persistent!==true)process.exit(1);console.log(JSON.stringify({healthy:true}));
'@
    for($i=0;$i -lt 30;$i++){try{$r=Invoke-Node $CoreName $code;if($r.healthy){return}}catch{};Start-Sleep -Milliseconds 1000}
    Fail 'core_health_failed' 'Image2 did not become healthy.'
}
function Wait-Web([int]$Port,[string]$Container,[switch]$Image2) {
    for($i=0;$i -lt 30;$i++){try{
        $health=Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/v1/health" -TimeoutSec 4
        if($health.status -ne 'ok'){throw 'not ready'}
        if($Image2){$null=Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/v3/image2/capabilities" -TimeoutSec 6}
        $build=(Invoke-Docker -Arguments @('exec',$Container,'cat','/app/.next/BUILD_ID') -Label 'web-build-id').Trim()
        Require ($build.Length -gt 0 -and $build.Length -le 200) 'build_id_invalid' 'Web BUILD_ID is missing.';return $build
    }catch{};Start-Sleep -Milliseconds 1000}
    Fail 'web_health_failed' 'Web/route health did not become ready.'
}
function Read-PublicRoutes {
    $result=@()
    foreach($domain in @('weiaidesign.com','www.weiaidesign.com','weiaidesign.youngtuo.win','visual.youngtuo.win')){
        try{$health=Invoke-RestMethod -Uri "https://$domain/api/v1/health" -TimeoutSec 15;Require ($health.status -eq 'ok') 'public_health_failed' 'Public web health failed.';$null=Invoke-RestMethod -Uri "https://$domain/api/v3/image2/capabilities" -TimeoutSec 20}
        catch{Fail 'public_route_failed' 'A public domain did not read back the Image2 route; restore the retained web and inspect routing.'}
        $result+=[ordered]@{Domain=$domain;WebHealth=$true;Image2Capabilities=$true}
    }
    return $result
}
function Assert-OwnedContainer([string]$Name,[string]$ImageId,[string]$EnvFile) {
    $c=Safe-Container $Name
    Require (($c.ReleaseLabel -ceq $ReleaseId) -and ($c.SourceLabel -ceq $ExpectedSha) -and ($c.ImageId -ceq $ImageId)) 'container_owner_mismatch' 'Existing candidate container is not this frozen release.'
    $null=Assert-PrivateConfig $Name $EnvFile
    Require ($c.Running -and !$c.Paused -and $c.NetworkPresent) 'candidate_not_running' 'Candidate container is not running.'
}
function Assert-ModelBlank([string]$Name) {
    $c=Docker-Object 'container' $Name
    foreach($pair in $c.Config.Env){$p=$pair -split '=',2;if($p.Count -eq 2 -and $p[0] -match '^(IMAGE_OPENAI_|OPENAI_|AGENT_LLM_|GPU_COMFY_)'){Require ([string]::IsNullOrEmpty($p[1])) 'canary_provider_configured' 'Canary model configuration is not empty; do not run the non-AI matrix.'}}
}
function Assert-CoreMountAndPorts {
    $c=Safe-Container $CoreName
    Require (@($c.Mounts|Where-Object {$_.Name -eq $CoreVolume -and $_.Destination -eq '/data/image2'}).Count -eq 1) 'core_mount_mismatch' 'Image2 is not using its independent named ledger volume.'
    foreach($property in $c.Ports.PSObject.Properties){Require ($null -eq $property.Value -or @($property.Value).Count -eq 0) 'core_port_published' 'Image2 must not publish a host port.'}
}
function Assert-CanaryBinding {
    $c=Safe-Container $CanaryName;$bindings=Field $c.Ports '18084/tcp'
    Require (@($bindings).Count -eq 1 -and @($bindings)[0].HostIp -eq '127.0.0.1' -and @($bindings)[0].HostPort -eq '18196') 'canary_binding_mismatch' 'Web canary must be bound only to localhost 18196.'
    Require (@($c.Mounts|Where-Object {$_.Name -eq $CanaryVolume -and $_.Destination -eq '/data'}).Count -eq 1) 'canary_mount_mismatch' 'Canary is not using its restored independent image volume.'
}
function Prepare-Release {
    Check-Archive
    Require (!(Test-Path -LiteralPath $StatePath)) 'prepare_exists' 'This release already has state. Use its next phase or inspect the preserved partial state; do not overwrite backups.'
    Require (!(Test-Path -LiteralPath $SourceRoot)) 'source_directory_exists' 'Source directory already exists; a frozen release must extract into a fresh directory.'
    Require (!(Container-Exists $CoreName)) 'existing_image2' 'Image2 already exists. This first-deployment script cannot adopt or overwrite an existing ledger.'
    $web=Assert-OriginalWeb;$gateway=Safe-Container $GatewayName;$legacy=Safe-Container $LegacyWebName
    Require ($gateway.Running -and !$gateway.Paused -and $gateway.NetworkPresent -and $legacy.Running -and !$legacy.Paused) 'existing_service_not_ready' 'Existing services must be running and unpaused.'
    Require (@($gateway.Mounts|Where-Object {$_.Name -eq $GatewayVolume -and $_.Destination -eq '/data/studio'}).Count -eq 1) 'gateway_mount_mismatch' 'V3 ledger mount differs from inspection.'
    Require (@($legacy.Mounts|Where-Object {$_.Name -eq $LegacyVolume -and $_.Destination -eq '/data'}).Count -eq 1) 'legacy_mount_mismatch' 'Old web does not share the expected image volume.'
    $wc=Assert-PrivateConfig $WebName $OriginalWebEnv;$gc=Assert-PrivateConfig $GatewayName $OriginalGatewayEnv;$null=Assert-NoActivity
    $script:State=[ordered]@{Version=1;ReleaseId=$ReleaseId;SourceSha256=$ExpectedSha;Prepared=$false;CanaryRuntimeReady=$false;CutoverComplete=$false;RollbackComplete=$false;CreatedAt=(Get-Date).ToUniversalTime().ToString('o');UpdatedAt='';OriginalWeb=$web;OriginalGateway=$gateway;OriginalWebBuildId=(Invoke-Docker -Arguments @('exec',$WebName,'cat','/app/.next/BUILD_ID') -Label 'original-build-id');PrivateConfigComparison=@{Web=$wc;Gateway=$gc};Backup=@{};NewWebImageId='';NewCoreImageId='';CanaryBuildId='';LastFailure=$null}
    Save-State
    $null=[IO.Directory]::CreateDirectory($BackupRoot)
    Copy-Item -LiteralPath $OriginalWebEnv -Destination (Join-Path $BackupRoot 'web-runtime.env')
    Copy-Item -LiteralPath $OriginalGatewayEnv -Destination (Join-Path $BackupRoot 'gateway-runtime.env')
    $tempDb="/tmp/image2-$ReleaseId-$([Guid]::NewGuid().ToString('N')).sqlite"
    $backupCode=@"
import {DatabaseSync,backup} from 'node:sqlite';
const d=new DatabaseSync('/data/studio/studio.sqlite',{readOnly:true});await backup(d,'$tempDb');d.close();console.log(JSON.stringify({backedUp:true}));
"@
    $null=Invoke-Node $GatewayName $backupCode
    $dbFile=Join-Path $BackupRoot 'studio.sqlite';$null=Invoke-Docker -Arguments @('cp',"${GatewayName}:$tempDb",$dbFile) -Label 'copy-online-sqlite-backup'
    $null=Invoke-Docker -Arguments @('run','--rm','--mount',"type=volume,source=$GatewayVolume,target=/source,readonly",'--mount',"type=bind,source=$BackupRoot,target=/backup",'--entrypoint','tar',$gateway.ImageId,'-cf','/backup/studio-files.tar','--exclude=./studio.sqlite','--exclude=./studio.sqlite-wal','--exclude=./studio.sqlite-shm','-C','/source','.') -Label 'archive-immutable-studio-assets'
    try {
        foreach($name in @($WebName,$LegacyWebName)){$script:PausedWebs+=$name;$null=Invoke-Docker -Arguments @('pause',$name) -Label 'pause-web-for-consistent-legacy-snapshot'}
        $null=Invoke-Docker -Arguments @('run','--rm','--mount',"type=volume,source=$LegacyVolume,target=/source,readonly",'--mount',"type=bind,source=$BackupRoot,target=/backup",'--entrypoint','tar',$web.ImageId,'-cf','/backup/legacy-web-data.tar','-C','/source','.') -Label 'archive-legacy-image-volume'
    } finally { Unpause-Webs }
    Ensure-Volume $RestoreVolume;Ensure-Volume $CanaryVolume
    $null=Invoke-Docker -Arguments @('run','--rm','--mount',"type=volume,source=$RestoreVolume,target=/data/studio",'--mount',"type=bind,source=$BackupRoot,target=/backup,readonly",'--entrypoint','sh',$gateway.ImageId,'-c','tar -xf /backup/studio-files.tar -C /data/studio && cp /backup/studio.sqlite /data/studio/studio.sqlite') -Label 'restore-v3-into-isolated-volume'
    $verifyCode=@'
import {DatabaseSync} from 'node:sqlite';import {existsSync,readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
const d=new DatabaseSync('/data/studio/studio.sqlite',{readOnly:true}),r={quickCheck:d.prepare('PRAGMA quick_check').get().quick_check,schemaVersion:d.prepare('PRAGMA user_version').get().user_version,projects:d.prepare('SELECT COUNT(*) AS n FROM projects').get().n,assets:d.prepare('SELECT COUNT(*) AS n FROM assets').get().n,verifiedAssets:0,missingAssets:0,hashMismatches:0};
for(const a of d.prepare('SELECT path,json FROM assets').all()){const j=JSON.parse(a.json);if(!a.path.startsWith('/data/studio/assets/')||!existsSync(a.path)){r.missingAssets++;continue;}if(createHash('sha256').update(readFileSync(a.path)).digest('hex')!==j.hash)r.hashMismatches++;else r.verifiedAssets++;}
d.close();console.log(JSON.stringify(r));
'@
    # The isolated directory is writable so SQLite may create WAL/shm; the DB handle itself is read-only.
    $restoreText=Invoke-Docker -Arguments @('run','--rm','-i','--mount',"type=volume,source=$RestoreVolume,target=/data/studio",'--entrypoint','node',$gateway.ImageId,'--no-warnings','--input-type=module') -Label 'verify-isolated-sqlite-and-assets' -InputText $verifyCode
    $restore=$restoreText|ConvertFrom-Json
    Require ($restore.quickCheck -eq 'ok' -and $restore.missingAssets -eq 0 -and $restore.hashMismatches -eq 0 -and $restore.verifiedAssets -eq $restore.assets) 'restore_invalid' 'Isolated V3 backup verification failed.'
    $null=Invoke-Docker -Arguments @('run','--rm','--mount',"type=volume,source=$CanaryVolume,target=/target",'--mount',"type=bind,source=$BackupRoot,target=/backup,readonly",'--entrypoint','tar',$web.ImageId,'-xf','/backup/legacy-web-data.tar','-C','/target') -Label 'restore-legacy-into-canary-volume'
    $null=[IO.Directory]::CreateDirectory($SourceRoot)
    $local:ErrorActionPreference='Continue';$raw=@(& tar -xzf $SourceArchive -C $SourceRoot 2>&1);$exit=$LASTEXITCODE;$local:ErrorActionPreference='Stop';Require ($exit -eq 0) 'extract_failed' 'Source extraction failed; raw output was suppressed.'
    foreach($path in @('Dockerfile','package-lock.json','services\image2\Dockerfile','services\image2\package-lock.json')){Require (Test-Path -LiteralPath (Join-Path $SourceRoot $path) -PathType Leaf) 'source_layout_invalid' 'Source archive must contain the web repository at its root.'}
    $null=Invoke-Docker -Arguments @('build','--label',"weiai.image2.release=$ReleaseId",'--label',"weiai.image2.source-sha=$ExpectedSha",'-t',$NewCoreTag,'-f',(Join-Path $SourceRoot 'services\image2\Dockerfile'),(Join-Path $SourceRoot 'services\image2')) -Label 'build-core-release'
    $null=Invoke-Docker -Arguments @('build','--label',"weiai.image2.release=$ReleaseId",'--label',"weiai.image2.source-sha=$ExpectedSha",'-t',$NewWebTag,'-f',(Join-Path $SourceRoot 'Dockerfile'),$SourceRoot) -Label 'build-web-release'
    $script:State.NewCoreImageId=(Docker-Object 'image' $NewCoreTag).Id;$script:State.NewWebImageId=(Docker-Object 'image' $NewWebTag).Id
    $script:State.Backup=[ordered]@{RestoreVerified=$true;Restore=$restore;SqliteSha256=(Get-FileHash -LiteralPath $dbFile -Algorithm SHA256).Hash.ToLowerInvariant();StudioArchiveSha256=(Get-FileHash -LiteralPath (Join-Path $BackupRoot 'studio-files.tar') -Algorithm SHA256).Hash.ToLowerInvariant();LegacyArchiveSha256=(Get-FileHash -LiteralPath (Join-Path $BackupRoot 'legacy-web-data.tar') -Algorithm SHA256).Hash.ToLowerInvariant();RestoreVolume=$RestoreVolume;CanaryVolume=$CanaryVolume}
    $script:State.Prepared=$true;Save-State
}
function Start-Canary {
    Require-State;$null=Assert-OriginalWeb;$null=Assert-PrivateConfig $WebName $OriginalWebEnv
    $null=Verify-Image $NewCoreTag $script:State.NewCoreImageId;$null=Verify-Image $NewWebTag $script:State.NewWebImageId
    Write-CanaryConfig;Ensure-Volume $CoreVolume
    if(Container-Exists $CoreName){Assert-OwnedContainer $CoreName $script:State.NewCoreImageId $CoreCanaryEnv}else{Start-Core $CoreCanaryEnv}
    Wait-Core
    if(Container-Exists $CanaryName){Assert-OwnedContainer $CanaryName $script:State.NewWebImageId $WebCanaryEnv}else{
        $null=Invoke-Docker -Arguments @('run','-d','--name',$CanaryName,'--restart','unless-stopped','--network',$AppNetwork,'--label',"weiai.image2.release=$ReleaseId",'--label',"weiai.image2.source-sha=$ExpectedSha",'--env-file',$WebCanaryEnv,'--env','PORT=18084','--env','HOSTNAME=0.0.0.0','--publish','127.0.0.1:18196:18084','--mount',"type=volume,source=$CanaryVolume,target=/data",$script:State.NewWebImageId) -Label 'start-localhost-web-canary'
    }
    Assert-CoreMountAndPorts;Assert-CanaryBinding;Assert-ModelBlank $CoreName;Assert-ModelBlank $CanaryName
    $script:State.CanaryBuildId=Wait-Web 18196 $CanaryName -Image2
    $null=Assert-CoreIdle -ZeroModels
    $script:State.CanaryRuntimeReady=$true;Save-State
    # This is not a browser acceptance receipt. The script never sets GateBPassed or CanaryPassed.
}
function Write-ProductionConfig {
    $original=Read-EnvMap $OriginalWebEnv;$core=Read-EnvMap $CoreCanaryEnv;$web=@{};foreach($key in $original.Keys){if($key -notmatch '^IMAGE2_'){$web[$key]=$original[$key]}}
    $web.IMAGE2_API_URL='http://image2:18088';$web.IMAGE2_API_TOKEN=$core.IMAGE2_API_TOKEN
    foreach($key in $original.Keys){if($key -match '^(IMAGE_OPENAI_(BASE_URL|API_KEY|MODEL|QUALITY|TIMEOUT_SECONDS)|OPENAI_API_KEY|AGENT_LLM_(BASE_URL|API_KEY|MODEL|MODELS)|GPU_COMFY_(BASE_URL|TOKEN|TIMEOUT_SECONDS|POLL_INTERVAL_MS|POLL_ATTEMPTS))$'){$core[$key]=$original[$key]}}
    Require ((Guest-Secret $web) -ceq (Guest-Secret $original)) 'visitor_secret_changed' 'Production visitor signing configuration changed.'
    Write-Env $WebProductionEnv $web;Write-Env $CoreProductionEnv $core
}
function Restore-OldWeb([string]$Suffix) {
    Require (Container-Exists $OldWebName) 'rollback_missing' 'The original retained web container is missing.'
    $old=Safe-Container $OldWebName;Require ($old.ImageId -ceq $script:State.OriginalWeb.ImageId) 'rollback_digest_mismatch' 'Retained original container does not match the saved digest.'
    if(Container-Exists $WebName){$candidate=Safe-Container $WebName;Require ($candidate.ImageId -ceq $script:State.NewWebImageId -and $candidate.ReleaseLabel -ceq $ReleaseId) 'rollback_superseded' 'Refusing to replace a different production release.'
        $null=Invoke-Docker -Arguments @('stop',$WebName) -Label 'stop-candidate-web';$null=Invoke-Docker -Arguments @('rename',$WebName,"$WebName-image2-$Suffix-$ReleaseId") -Label 'retain-candidate-web'
    }
    $null=Invoke-Docker -Arguments @('rename',$OldWebName,$WebName) -Label 'restore-original-web-name';$null=Invoke-Docker -Arguments @('start',$WebName) -Label 'start-original-web'
    $build=Wait-Web 18194 $WebName
    Require ($build -ceq $script:State.OriginalWebBuildId) 'rollback_build_mismatch' 'Restored web BUILD_ID differs from the saved original.'
}
function Cutover-Release {
    Require-State
    Require-True $script:State.Backup 'RestoreVerified';Require-True $script:State 'CanaryRuntimeReady'
    Require ((Field $gate 'WebImageId') -ceq $script:State.NewWebImageId -and (Field $gate 'CoreImageId') -ceq $script:State.NewCoreImageId -and (Field $gate 'CanaryBuildId') -ceq $script:State.CanaryBuildId) 'gate_image_mismatch' 'Gate receipt does not bind the tested image digests and BUILD_ID.'
    $deployFirst = (Field $gate 'DeployBeforeUiTesting') -eq $true
    $acceptance = [ordered]@{ DeployBeforeUiTesting=$deployFirst; PostDeploymentTestingRequired=$deployFirst; GateBPassed=(Field $gate 'GateBPassed'); OriginalPagePassed=(Field $gate 'OriginalPagePassed'); CanaryPassed=(Field $gate 'CanaryPassed'); AuthorizationSource=(Field $gate 'AuthorizationSource'); AuthorizationInstruction=(Field $gate 'AuthorizationInstruction') }
    $script:State | Add-Member -MemberType NoteProperty -Name Acceptance -Value $acceptance -Force
    Save-State
    $null=Verify-Image $NewWebTag $script:State.NewWebImageId;$null=Verify-Image $NewCoreTag $script:State.NewCoreImageId
    $null=Assert-OriginalWeb;$null=Assert-PrivateConfig $WebName $OriginalWebEnv;$null=Assert-PrivateConfig $GatewayName $OriginalGatewayEnv;$null=Assert-NoActivity
    Assert-OwnedContainer $CanaryName $script:State.NewWebImageId $WebCanaryEnv;Assert-OwnedContainer $CoreName $script:State.NewCoreImageId $CoreCanaryEnv;Assert-CoreMountAndPorts;Assert-CanaryBinding;Assert-ModelBlank $CoreName;Assert-ModelBlank $CanaryName;$null=Assert-CoreIdle -ZeroModels
    Require (!(Container-Exists $OldWebName) -and !(Container-Exists $OldCoreName)) 'retained_name_exists' 'Retained-container name already exists; do not overwrite a rollback artifact.'
    Write-ProductionConfig
    $null=Invoke-Docker -Arguments @('stop',$CoreName) -Label 'stop-idle-canary-core';$null=Invoke-Docker -Arguments @('rename',$CoreName,$OldCoreName) -Label 'retain-canary-core'
    try{Start-Core $CoreProductionEnv;Wait-Core}catch{
        if(Container-Exists $CoreName){$null=Invoke-Docker -Arguments @('stop',$CoreName) -Label 'stop-failed-core';$null=Invoke-Docker -Arguments @('rename',$CoreName,"$CoreName-failed-$ReleaseId") -Label 'retain-failed-core'}
        $null=Invoke-Docker -Arguments @('rename',$OldCoreName,$CoreName) -Label 'restore-core-name';$null=Invoke-Docker -Arguments @('start',$CoreName) -Label 'restore-canary-core';throw
    }
    # WEB_ONLY_CUTOVER: gateway, native workers, old ports and Cloudflare config are never replaced.
    $null=Invoke-Docker -Arguments @('stop',$WebName) -Label 'stop-original-web'
    try{$null=Invoke-Docker -Arguments @('rename',$WebName,$OldWebName) -Label 'retain-original-web'}catch{$null=Invoke-Docker -Arguments @('start',$WebName) -Label 'resume-original-web';throw}
    try {
        $null=Invoke-Docker -Arguments @('run','-d','--name',$WebName,'--restart','unless-stopped','--network',$AppNetwork,'--label',"weiai.image2.release=$ReleaseId",'--label',"weiai.image2.source-sha=$ExpectedSha",'--env-file',$WebProductionEnv,'--env','PORT=18084','--env','HOSTNAME=0.0.0.0','--publish','18194:18084','--mount',"type=volume,source=$LegacyVolume,target=/data",$script:State.NewWebImageId) -Label 'start-production-web-18194'
        $build=Wait-Web 18194 $WebName -Image2;Require ($build -ceq $script:State.CanaryBuildId) 'production_build_mismatch' 'Production BUILD_ID differs from the accepted canary.'
        $script:State | Add-Member -MemberType NoteProperty -Name PublicReadback -Value (Read-PublicRoutes) -Force
    } catch { Restore-OldWeb 'failed';throw }
    $script:State.CutoverComplete=$true;Save-State
}
function Rollback-Release {
    Require-State
    Restore-OldWeb 'rollback'
    # No database restore and no core stop: accepted jobs, assets and receipts remain durable.
    $script:State.RollbackComplete=$true;$script:State.CutoverComplete=$false;Save-State
}

try {
    $script:Step='host-identity'
    Require (($env:COMPUTERNAME -ieq 'AI') -and ($env:USERNAME -ieq 'qrrwi')) 'host_mismatch' 'This script is restricted to the inspected Windows AI/qrrwi target.'
    Require (!$env:SSH_CONNECTION -and !$env:SSH_CLIENT) 'detached_execution_required' 'Use a Scheduled Task or a persistent local session; an SSH-owned process may die before finally can resume paused webs.'
    foreach($tool in @('docker','tar')){Require ($null -ne (Get-Command $tool -ErrorAction SilentlyContinue)) 'tool_missing' 'Required local Windows tooling is unavailable.'}
    Protect-PrivateDirectory $PrivateBase;Protect-PrivateDirectory $PrivateRoot
    try{$script:Lock=[IO.File]::Open((Join-Path $PrivateBase 'deploy.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}catch{Fail 'deployment_locked' 'Another Image2 deployment phase already owns the release lock.'}
    switch($Phase){Prepare{Prepare-Release};Canary{Start-Canary};Cutover{Cutover-Release};Rollback{Rollback-Release}}
    [ordered]@{DeploymentExecuted=$true;Phase=$Phase;ReleaseId=$ReleaseId;SourceSha256=$ExpectedSha;Prepared=$script:State.Prepared;CanaryRuntimeReady=$script:State.CanaryRuntimeReady;CutoverComplete=$script:State.CutoverComplete;RollbackComplete=$script:State.RollbackComplete;Acceptance=(Field $script:State 'Acceptance');NewWebImageId=$script:State.NewWebImageId;NewCoreImageId=$script:State.NewCoreImageId;CanaryBuildId=$script:State.CanaryBuildId;ReceiptPath=$StatePath} | ConvertTo-Json -Depth 5 -Compress
} catch {
    if($null -ne $script:State){$script:State.LastFailure=@{Phase=$Phase;Step=$script:Step;Code=$script:FailureCode;At=(Get-Date).ToUniversalTime().ToString('o')};try{Save-State}catch{}}
    Write-Error "Image2 release $ReleaseId phase $Phase failed at $($script:Step): $($script:FailureCode). Raw command output and private values were suppressed."
    exit 1
} finally {
    if($script:PausedWebs.Count){Unpause-Webs}
    if($null -ne $script:Lock){$script:Lock.Dispose()}
}
