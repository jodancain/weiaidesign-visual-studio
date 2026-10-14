# No Docker or production calls. AST-load ONLY function definitions, then mock I/O.
param([ValidateSet('suite','state-inspect','state-prepare')][string]$Mode='suite',[string]$StateDirectory)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
# Windows Start alias takes precedence over functions. Reproduce that resolution
# in this disposable test process on other platforms; no profile/system change.
if(!(Get-Alias -Name Start -ErrorAction SilentlyContinue)){Set-Alias -Name Start -Value Start-Process -Scope Script}
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$path=Join-Path $repo 'scripts/artcraft-upgrade/upgrade.ps1'
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
if($errors.Count){throw ($errors|ForEach-Object {$_.ToString()}|Out-String)}
foreach($f in $ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$false)){Invoke-Expression $f.Extent.Text}
# Separate processes exercise the real persisted-state functions before any mocks.
# The parent owns this unique temporary directory; these branches never run stages.
if($Mode -ne 'suite'){
    Need ((Split-Path $StateDirectory -Leaf) -match '^artcraft-state-roundtrip-[a-f0-9]{32}$' -and [IO.Path]::GetFullPath((Split-Path $StateDirectory)) -eq [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)) 'synthetic_state_directory_required'
    $script:StatePath=Join-Path $StateDirectory 'state.json'
    if($Mode -eq 'state-inspect'){
        Need (!(Test-Path -LiteralPath $script:StatePath)) 'synthetic_state_already_exists'
        $script:State=@{Inspected=$true;Prepared=$false;Sequence=1;PendingOperation=$null;PlanSha256='synthetic-plan';Empty=@();Singleton=@(@{Id='synthetic-id'})}
        SaveState
    } else {
        $script:State=ReadJson $script:StatePath
        Need ($State.Inspected -and $State.Sequence -eq 1 -and $State.PlanSha256 -ceq 'synthetic-plan') 'synthetic_inspect_state_required'
        $State.Sequence=2;BeginOp 'synthetic-prepare'
        $State.Prepared=$true;$State.Sequence=3;DoneOp
    }
    Write-Output "$Mode-passed";exit 0
}
$taskAst=[Management.Automation.Language.Parser]::ParseFile((Join-Path $repo 'scripts/artcraft-upgrade/task.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'task wrapper parse failed'}
$collectorAst=[Management.Automation.Language.Parser]::ParseFile((Join-Path $repo 'scripts/artcraft-sandbox-policy/collect-review-facts.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'policy collector parse failed'}
$script:checks=0
function Check($Condition,$Name){if(!$Condition){throw "test failed: $Name"};$script:checks++}
function Reject([scriptblock]$Action,[string]$Code){try{& $Action;throw 'did not reject'}catch{Check ($_.Exception.Message -eq $Code) $Code}}
Check ($taskAst.Extent.Text.Contains('-ExecutionPolicy RemoteSigned -NoProfile -NonInteractive -File')) 'ScheduledTask action explicitly sets child process RemoteSigned on default Restricted host'
Check (!$taskAst.Extent.Text.Contains('Set-ExecutionPolicy') -and !$taskAst.Extent.Text.Contains('-ExecutionPolicy Bypass') -and !$taskAst.Extent.Text.Contains('-ExecutionPolicy Unrestricted')) 'no persistent or broader script policy mutation'
Check ((Get-Alias -Name Start).Definition -eq 'Start-Process') 'system Start alias remains present throughout orchestration tests'
Check (@($ast.FindAll({param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Start'},$true)).Count -eq 0) 'executor never invokes ambiguous Start command'
$m=Map ('{"a":[],"b":[{"c":true}],"nested":{"id":"x"}}'|ConvertFrom-Json)
Check ($m.a.Count -eq 0 -and $m.b.Count -eq 1 -and $m.b[0].c) 'JSON preserves empty and singleton arrays'
Reject {Idle @{integrity='ok';active=1}} 'drain_required_no_automatic_retries'
Idle @{integrity='ok';active=0}
Idle @{integrity='ok';active=0;uncertain=1;uncertainRecords=@('old:stable')}
Check (SameUncertain @{uncertainRecords=@('old:stable')} @{uncertainRecords=@('old:stable')}) 'stable historical uncertain permits deployment'
Check (!(SameUncertain @{uncertainRecords=@('old:stable')} @{uncertainRecords=@('old:stable','new:unknown')})) 'new uncertainty during stop is detected'
$before=@{verifiedAssets=1;fingerprints=@{craft_receipts=@{count=1;schema='s';rows='a'}}}
EqualAudit $before $before
Reject {EqualAudit $before @{verifiedAssets=1;fingerprints=@{craft_receipts=@{count=0;schema='s';rows='b'}}}} 'ledger_changed'
Check ((QuoteArg 'a b\') -eq '"a b\\"') 'Windows trailing slash quoting'
# Secret value goes into ProcessStartInfo environment, never command arguments.
$out=Exec (Get-Process -Id $PID).Path @('-NoProfile','-Command','[Console]::Write($env:ARTCRAFT_SYNTHETIC_PROBE)') '' @{ARTCRAFT_SYNTHETIC_PROBE='local-value'}
Check ($out -eq 'local-value') 'child-only environment injection'
Check (!$env:ARTCRAFT_SYNTHETIC_PROBE) 'parent environment unchanged'
# Exercise the actual allowlisted collector parser without running Docker. Actual
# Windows Docker proofs separately verify Go index on omitted optional map keys.
$collectorFunction=$collectorAst.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$false)|Where-Object Name -eq 'Read-DockerFields'
Invoke-Expression $collectorFunction.Extent.Text
foreach($statement in $collectorAst.EndBlock.Statements){if($statement -is [Management.Automation.Language.AssignmentStatementAst] -and $statement.Left.VariablePath.UserPath -ceq 'containerFields'){Invoke-Expression $statement.Extent.Text}}
Check ($containerFields.Tmpfs -ceq '(index .HostConfig `Tmpfs`)' -and $containerFields.Sysctls -ceq '(index .HostConfig `Sysctls`)') 'only optional missing HostConfig members use safe index'
Check ($containerFields.Id -ceq '.Id' -and $containerFields.Image -ceq '.Image' -and $containerFields.Memory -ceq '.HostConfig.Memory') 'required identity and resource fields retain strict queries'
$script:collectorExit=0;$script:collectorLines=@('"synthetic-id"','null','null','2147483648','["no-new-privileges=true","seccomp={\"mask\":18446744073707453426}"]','"bind"','"/policy"','false','"C:/synthetic-policy"','null')
function docker {$script:collectorArguments=@($args);$global:LASTEXITCODE=$script:collectorExit;return $script:collectorLines}
try {
    $fields=[ordered]@{Id='.Id';Tmpfs=$containerFields.Tmpfs;Sysctls=$containerFields.Sysctls;Memory='.HostConfig.Memory';SecurityOpt='.HostConfig.SecurityOpt'}
    $facts=Read-DockerFields @('inspect','synthetic') $fields -WithMounts
    Check ($null -eq $facts.Tmpfs -and $null -eq $facts.Sysctls -and $facts.Memory -eq 2147483648) 'omitted optionals stay null without masking required resource values'
    Check ($facts.Mounts.Count -eq 1 -and $facts.Mounts[0].Type -ceq 'bind' -and $null -eq $facts.Mounts[0].Name -and !$facts.Mounts[0].RW) 'bind mount with omitted Name retains exact source and readonly flag'
    Check ($facts.SecurityOpt[1] -ceq 'seccomp={"mask":18446744073707453426}') 'embedded seccomp uint64 remains an unparsed string'
    Check ($script:collectorArguments[-1].Contains('{{json (index . `Name`)}}') -and !$script:collectorArguments[-1].Contains('"')) 'native template uses raw Go keys without embedded double quotes'
    $arrayFields=[ordered]@{Devices='.HostConfig.Devices';Binds='.HostConfig.Binds'}
    foreach($case in @(@{Devices='null';Binds='null';Count=0},@{Devices='[]';Binds='[]';Count=0},@{Devices='[{"PathOnHost":"/synthetic/a","PathInContainer":"/dev/a","CgroupPermissions":"r"}]';Binds='["synthetic-a:/data/a"]';Count=1},@{Devices='[{"PathOnHost":"/synthetic/a"},{"PathOnHost":"/synthetic/b"}]';Binds='["synthetic-a:/data/a","synthetic-b:/data/b"]';Count=2})){
        $script:collectorLines=@($case.Devices,$case.Binds);$arrays=Read-DockerFields @('inspect','synthetic') $arrayFields
        $json=$arrays|ConvertTo-Json -Depth 8 -Compress
        Check ($arrays.Devices -is [array] -and $arrays.Binds -is [array] -and $arrays.Devices.Count -eq $case.Count -and $arrays.Binds.Count -eq $case.Count -and $json -notmatch '"value"|"Count"') 'null/empty/single/multiple device and bind arrays retain JSON array shape'
        if($case.Count){Check ($arrays.Devices[0].PathOnHost -ceq '/synthetic/a' -and $arrays.Binds[0] -ceq 'synthetic-a:/data/a') 'nonempty forbidden device and bind details are never discarded'}
    }
    $script:collectorLines=@('[]');Reject {Read-DockerFields @('inspect','synthetic') $arrayFields} 'Incomplete Docker field output'
    $script:collectorExit=1;$script:collectorLines=@();Reject {Read-DockerFields @('inspect','synthetic') $fields} 'Read-only Docker query failed'
    $script:collectorExit=0;$script:collectorLines=@('"synthetic-id"');Reject {Read-DockerFields @('inspect','synthetic') $fields} 'Incomplete Docker field output'
} finally {Remove-Item Function:docker}
# First-create then two atomic replacements survive process boundaries. This
# reproduces Inspect -> saved state -> Prepare rather than mocking SaveState.
$roundtrip=Join-Path ([IO.Path]::GetTempPath()) ('artcraft-state-roundtrip-'+[Guid]::NewGuid().ToString('N'));$null=[IO.Directory]::CreateDirectory($roundtrip)
try {
    $child=(Get-Process -Id $PID).Path;$stateFile=Join-Path $roundtrip 'state.json'
    Check ((Exec $child @('-NoProfile','-File',$PSCommandPath,'-Mode','state-inspect','-StateDirectory',$roundtrip)) -ceq 'state-inspect-passed') 'Inspect child creates its first state receipt'
    $first=ReadJson $stateFile;Check ($first.Sequence -eq 1 -and !$first.Prepared) 'first state is readable before Prepare starts'
    Check ((Exec $child @('-NoProfile','-File',$PSCommandPath,'-Mode','state-prepare','-StateDirectory',$roundtrip)) -ceq 'state-prepare-passed') 'new Prepare process atomically replaces persisted state twice'
    $third=ReadJson $stateFile
    Check ($third.Sequence -eq 3 -and $third.Prepared -and $null -eq $third.PendingOperation) 'third write contains complete Prepare state'
    Check ($third.Empty.Count -eq 0 -and $third.Singleton.Count -eq 1 -and $third.Singleton[0].Id -ceq 'synthetic-id') 'empty and singleton arrays survive saved-state round trip'
    $prior=Hash $stateFile;$held=$null;$fault=$null
    if($env:OS -eq 'Windows_NT'){$held=[IO.File]::Open($stateFile,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)}
    else {& /bin/chmod 500 $roundtrip;if($LASTEXITCODE -ne 0){throw 'synthetic_directory_permission_setup_failed'}}
    try {try{SaveJson $stateFile @{Sequence=4;ShouldNotCommit=$true}}catch{$fault=FailureDetails $_}}
    finally {if($held){$held.Dispose()}else{& /bin/chmod 700 $roundtrip;if($LASTEXITCODE -ne 0){throw 'synthetic_directory_permission_restore_failed'}}}
    Check ($null -ne $fault) 'filesystem write or replacement failure is surfaced'
    Check ((Hash $stateFile) -ceq $prior -and (ReadJson $stateFile).Sequence -eq 3) 'failed update preserves previous state bytes and readability'
    Check ($fault.ErrorId -in @('IOException','UnauthorizedAccessException')) 'known filesystem failure retains safe runtime diagnostic'
    try{throw 'synthetic_private_exception_text'}catch{$redacted=FailureDetails $_}
    Check ($redacted.ErrorId -ceq 'redacted' -and ($redacted|ConvertTo-Json -Compress) -notmatch 'synthetic_private_exception_text') 'throw text is never persisted as an ErrorId'
    Check ($redacted.Keys.Count -eq 3 -and $redacted.Line -gt 0 -and $redacted.ExceptionType) 'diagnostic contains only type, allowed identifier and line'
} finally {[IO.Directory]::Delete($roundtrip,$true)}
# Actual Docker omits Sysctls and bind Name, rather than emitting prefilled nulls.
# Mandatory volume names, resource limits and the delegated policy check remain required.
$runtimeDir=Join-Path ([IO.Path]::GetTempPath()) ('artcraft-runtime-fixture-'+[Guid]::NewGuid().ToString('N'));$null=[IO.Directory]::CreateDirectory($runtimeDir)
$script:ReleaseRoot=$runtimeDir;$script:Release='fixture';$script:CanaryNetwork='canary';$script:Network='production';$script:CoreVolume='production-data';$script:WebVolume='production-web';$script:NativeVolume='native'
$script:State=@{PolicyMountSource='/synthetic-policy'};$script:Plan=@{PolicyMode='builtin';PolicySha256='builtin'};$script:runtimePolicyCalls=0
$script:runtimeFixture=@{Id='fixture-id';Image='fixture-image';Config=@{User='node';Labels=@{'artcraft.release'='fixture'}};HostConfig=@{Privileged=$false;CapAdd=$null;Devices=@();NanoCpus=2000000000;Memory=2147483648;PidsLimit=256;RestartPolicy=@{Name='unless-stopped'}};State=@{Running=$true;Restarting=$false};NetworkSettings=@{Networks=@{canary=@{}}};Mounts=@(@{Type='volume';Name='scratch';Destination='/data/image2';RW=$true},@{Type='volume';Name='native';Destination='/opt/artcraft';RW=$false},@{Type='bind';Destination='/policy';Source='/synthetic-policy';RW=$false})}
function Container($Name){return $script:runtimeFixture}
function Object($Kind,$Name){return @{Internal=$true}}
function CollectFacts($Name,$Path){}
function PolicyValidate($Arguments){Check ($Arguments[0] -ceq 'service-check') 'runtime still invokes exact service policy validator';$script:runtimePolicyCalls++}
function Docker($A,$InputText='', $Environment=@{}){return 'fixture-id'}
try {
    Check (!$script:runtimeFixture.HostConfig.ContainsKey('Sysctls') -and !$script:runtimeFixture.Mounts[2].ContainsKey('Name')) 'runtime fixture uses genuinely omitted optional keys'
    AssertRuntime 'builtin' 'fixture-image' 'scratch';Check ($script:runtimePolicyCalls -eq 1) 'omitted Sysctls and bind Name pass only through policy validation'
    $script:runtimeFixture.HostConfig.Sysctls=$null;AssertRuntime 'builtin' 'fixture-image' 'scratch';Check ($script:runtimePolicyCalls -eq 2) 'explicit null Sysctls also passes through policy validation';$script:runtimeFixture.HostConfig.Remove('Sysctls')
    $script:runtimeFixture.Remove('Image');try{AssertRuntime 'builtin' 'fixture-image' 'scratch';throw 'missing image accepted'}catch{Check ($_.FullyQualifiedErrorId -eq 'PropertyNotFoundStrict') 'missing mandatory image identity fails closed'};$script:runtimeFixture.Image='fixture-image'
    $script:runtimeFixture.Mounts[2].Remove('Type');try{AssertRuntime 'builtin' 'fixture-image' 'scratch';throw 'missing mount type accepted'}catch{Check ($_.FullyQualifiedErrorId -match '^PropertyNotFoundStrict(,|$)') 'runtime mount Type remains mandatory'};$script:runtimeFixture.Mounts[2].Type='bind'
    $script:runtimeFixture.HostConfig.Sysctls=@{'net.ipv4.ip_forward'='1'};Reject {AssertRuntime 'builtin' 'fixture-image' 'scratch'} 'runtime_limits_mismatch';$script:runtimeFixture.HostConfig.Remove('Sysctls')
    $script:runtimeFixture.HostConfig.Memory=1;Reject {AssertRuntime 'builtin' 'fixture-image' 'scratch'} 'runtime_limits_mismatch';$script:runtimeFixture.HostConfig.Remove('Memory')
    try{AssertRuntime 'builtin' 'fixture-image' 'scratch';throw 'missing memory accepted'}catch{Check ($_.FullyQualifiedErrorId -eq 'PropertyNotFoundStrict') 'missing mandatory memory is never defaulted'};$script:runtimeFixture.HostConfig.Memory=2147483648
    $script:runtimeFixture.Mounts[2].Type='volume';try{AssertRuntime 'builtin' 'fixture-image' 'scratch';throw 'missing volume name accepted'}catch{Check ($_.FullyQualifiedErrorId -match '^PropertyNotFoundStrict(,|$)') 'only bind Name is optional; volume Name remains mandatory'};$script:runtimeFixture.Mounts[2].Type='bind'
    $script:runtimeFixture.Mounts[0].Name=$CoreVolume;Reject {AssertRuntime 'builtin' 'fixture-image' 'scratch'} 'canary_has_production_volume';$script:runtimeFixture.Mounts[0].Name='scratch'
    AssertExclusive 'scratch' @('fixture-id');AssertExclusive 'native' @();Check ($true) 'volume audit skips unnamed bind mounts and retains readonly native volume semantics'
    Reject {AssertExclusive 'scratch' @()} 'another_running_volume_writer_requires_review'
    $script:runtimeFixture.Mounts[2].Remove('Type');try{AssertExclusive 'scratch' @('fixture-id');throw 'exclusive missing type accepted'}catch{Check ($_.FullyQualifiedErrorId -eq 'PropertyNotFoundStrict') 'exclusive audit requires mount Type'};$script:runtimeFixture.Mounts[2].Type='bind'
    $script:runtimeFixture.Mounts[0].Remove('Name');try{AssertExclusive 'scratch' @('fixture-id');throw 'exclusive missing volume name accepted'}catch{Check ($_.FullyQualifiedErrorId -eq 'PropertyNotFoundStrict') 'exclusive audit requires volume Name'};$script:runtimeFixture.Mounts[0].Name='scratch'
} finally {
    [IO.Directory]::Delete($runtimeDir,$true)
    foreach($name in @('Container','Object','CollectFacts','PolicyValidate','Docker')){$f=$ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst]},$false)|Where-Object Name -eq $name;Invoke-Expression $f.Extent.Text}
}
# Independently created policy helper records the Windows request before Docker
# supplies a resolved source. No service/container start belongs in this path.
$script:Release='fixture';$script:CanaryNetwork='canary';$script:NativeVolume='native';$script:PolicyDir='C:\reviewed\policy';$script:CoreVolume='production-data';$script:WebVolume='production-web'
$script:Plan=@{SourceArchiveSha256='frozen-source'};$script:State=@{NewCore='fixture-image';PolicyMountSource='previous-source'}
$script:sourceId=('a'*64);$script:sourceName='artcraft-fixture-policy-source';$script:sourceVolume="$sourceName-data";$script:sourceEvents=@();$script:sourceExists=$false;$script:volumeListing=''
$script:sourceHelper=@{Id=$sourceId;Name="/$sourceName";Image='fixture-image';Config=@{User='node';Labels=@{'artcraft.release'='fixture'};Entrypoint=@('true');Cmd=$null};State=@{Running=$false;Restarting=$false;StartedAt='0001-01-01T00:00:00Z'};HostConfig=@{Privileged=$false;CapAdd=$null;Devices=@();CapDrop=@('ALL');SecurityOpt=@('no-new-privileges=true');ReadonlyRootfs=$true;Memory=2147483648;NanoCpus=2000000000;PidsLimit=256;RestartPolicy=@{Name='unless-stopped'};NetworkMode='canary';PortBindings=@{};Tmpfs=@{'/tmp'='rw,nosuid,nodev,size=1073741824,mode=1777'};Mounts=@(@{Type='volume';Target='/data/image2';Source=$sourceVolume},@{Type='volume';Target='/opt/artcraft';Source='native';ReadOnly=$true},@{Type='bind';Target='/policy';Source='/independently-resolved-policy';ReadOnly=$true})};NetworkSettings=@{Networks=@{canary=@{}}};Mounts=@(@{Type='volume';Name=$sourceVolume;Destination='/data/image2';RW=$true},@{Type='volume';Name='native';Destination='/opt/artcraft';RW=$false},@{Type='bind';Destination='/policy';Source='/independently-resolved-policy';RW=$false})}
function Container($Name){return $script:sourceHelper}
function Object($Kind,$Name){return @{Internal=$true}}
function Exists($Kind,$Name){return $script:sourceExists}
function Resource($Kind,$Name){}
function SaveState {}
function StartContainer($Name){throw 'source helper must never start'}
function Docker($A,$InputText='', $Environment=@{}){
    $script:sourceEvents+=$A[0]
    if($A[0] -ceq 'volume'){return $script:volumeListing}
    Check ($A[0] -ceq 'create' -and $A[-2] -ceq 'true' -and $A[-1] -ceq 'fixture-image') 'source helper only creates true entrypoint with frozen image'
    Check ($State.PolicySourceRequest.RequestedSource -ceq $PolicyDir -and !$State.PolicySourceRequest.ContainerId -and $A -contains "type=bind,source=$PolicyDir,target=/policy,readonly") 'exact Windows bind request is saved before Docker normalization'
    Check ($Environment.ARTCRAFT_CANARY -ceq '1' -and $Environment.Keys.Count -eq 8 -and !$Environment.ContainsKey('OPENAI_API_KEY')) 'source helper uses same limited synthetic Core environment'
    return $script:sourceId
}
try {
    InitializePolicySource
    Check ($State.PolicyMountSource -ceq '/independently-resolved-policy' -and $State.PolicySourceProof.ContainerId -ceq $sourceId -and $State.PolicySourceProof.RequestedSource -ceq $PolicyDir -and $State.PolicySourceProof.NeverStarted) 'source provenance binds exact independent helper and original request'
    InitializePolicySource;Check (@($sourceEvents|Where-Object {$_ -ceq 'create'}).Count -eq 1 -and $sourceEvents -notcontains 'start') 'verified helper is rechecked without replay or start'
    $request=$State.PolicySourceRequest
    $sourceHelper.Id='wrong';Reject {AssertPolicySourceHelper $sourceHelper $request} 'policy_helper_identity';$sourceHelper.Id=$sourceId
    $sourceHelper.Image='wrong';Reject {AssertPolicySourceHelper $sourceHelper $request} 'policy_helper_identity';$sourceHelper.Image='fixture-image'
    $sourceHelper.Config.Labels['artcraft.release']='wrong';Reject {AssertPolicySourceHelper $sourceHelper $request} 'policy_helper_identity';$sourceHelper.Config.Labels['artcraft.release']='fixture'
    $sourceHelper.State.StartedAt='2026-10-15T00:00:00Z';Reject {AssertPolicySourceHelper $sourceHelper $request} 'policy_helper_must_remain_unstarted';$sourceHelper.State.StartedAt='0001-01-01T00:00:00Z'
    $sourceHelper.HostConfig.CapAdd=@('SYS_ADMIN');Reject {AssertPolicySourceHelper $sourceHelper $request} 'policy_helper_limits';$sourceHelper.HostConfig.CapAdd=$null
    $sourceHelper.HostConfig.PortBindings=@{'80/tcp'=@(@{HostPort='12345'})};Reject {AssertPolicySourceHelper $sourceHelper $request} 'policy_helper_network_or_tmpfs';$sourceHelper.HostConfig.PortBindings=@{}
    $request.RequestedSource='C:\unreviewed';Reject {AssertPolicySourceHelper $sourceHelper $request} 'policy_helper_request_changed';$request.RequestedSource=$PolicyDir
    $request.DataVolume=$CoreVolume;Reject {AssertPolicySourceHelper $sourceHelper $request} 'policy_helper_mount_roles';$request.DataVolume=$sourceVolume
    $sourceHelper.Mounts[1].RW=$true;Reject {AssertPolicySourceHelper $sourceHelper $request} 'policy_helper_mount_roles';$sourceHelper.Mounts[1].RW=$false
    $sourceHelper.Mounts[2].RW=$true;Reject {AssertPolicySourceHelper $sourceHelper $request} 'policy_helper_bind';$sourceHelper.Mounts[2].RW=$false
    $sourceHelper.HostConfig.Mounts[2].Source='/different';Reject {AssertPolicySourceHelper $sourceHelper $request} 'policy_helper_resolved_source_mismatch';$sourceHelper.HostConfig.Mounts[2].Source='/independently-resolved-policy'
    $State.Remove('PolicySourceProof');$script:sourceExists=$true;Reject {InitializePolicySource} 'policy_helper_unreceipted_container';$script:sourceExists=$false
    $script:volumeListing=$sourceVolume;Reject {InitializePolicySource} 'policy_helper_requires_fresh_volume';$script:volumeListing=''
    $State.PolicyMountSource='previous-source';$sourceHelper.Mounts[2].RW=$true;Reject {InitializePolicySource} 'policy_helper_bind'
    Check ($State.PolicyMountSource -ceq 'previous-source' -and !$State.ContainsKey('PolicySourceProof') -and $sourceEvents -notcontains 'start') 'rejected helper preserves prior expected source and never starts'
} finally {
    foreach($name in @('Container','Object','Exists','Resource','SaveState','StartContainer','Docker')){$f=$ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst]},$false)|Where-Object Name -eq $name;Invoke-Expression $f.Extent.Text}
}
# Exact queued bytes must be checked before any side effect.
$tmp=Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString('N'));$null=[IO.Directory]::CreateDirectory($tmp)
try {
    $paths=@{};foreach($key in @('Runner','Ledger','Bff','Gate','Policy','Probe')){$paths[$key]=Join-Path $tmp $key;[IO.File]::WriteAllText($paths[$key],'original')}
    $script:Request=@{BootstrapRoot=$tmp;FrozenFiles=@{Policy=(Hash $paths.Policy);Probe=(Hash $paths.Probe)};RunnerSha256=(Hash $paths.Runner);LedgerSha256=(Hash $paths.Ledger);BffSha256=(Hash $paths.Bff);GateReceipt=$paths.Gate;GateSha256=(Hash $paths.Gate)}
    SaveJson (Join-Path $tmp 'UPGRADE-SOURCE.json') @{head='head';files=$script:Request.FrozenFiles}
    $script:Plan=@{SourceManifestSha256=(Hash (Join-Path $tmp 'UPGRADE-SOURCE.json'));SourceCommit='head'}
    function CheckInputs {}
    VerifyQueuedBytes $paths.Runner $paths.Ledger $paths.Bff
    foreach($key in @('Runner','Ledger','Bff','Gate','Policy','Probe')){
        [IO.File]::WriteAllText($paths[$key],'changed')
        $code=@{Runner='queued_runner_changed';Ledger='queued_ledger_helper_changed';Bff='queued_bff_helper_changed';Gate='queued_gate_changed';Policy='queued_source_changed';Probe='queued_source_changed'}[$key]
        Reject {VerifyQueuedBytes $paths.Runner $paths.Ledger $paths.Bff} $code
        [IO.File]::WriteAllText($paths[$key],'original')
    }
} finally {[IO.Directory]::Delete($tmp,$true)}
$script:State=@{PlanSha256='plan';NewCore='core';NewWeb='web';CanaryBuildId='build';PolicyCanary=@{Directory='evidence';ReceiptSha256='hash';BwrapSha256='bwrap'};NativeCanary=@{ReceiptSha256='hash';Directory='evidence'};CanaryPassed=$true}
$script:Request=@{GateReceipt='gate';GateSha256='hash'};$script:Release='release'
$script:Plan=@{PolicyMode='candidate';PolicySha256='policy'}
function Hash($Path){return 'hash'}
function SaveState {}
$script:gate=@{ReleaseId='release';PlanSha256='plan';NewCoreImage='core';NewWebImage='web';CanaryBuildId='build';NativeReceiptSha256='hash';OriginalHomepagePassed=$false;CanaryEvidenceReviewed=$true;CompatibilityLimitationsAccepted=$true;TargetPolicyEvidenceReviewed=$true;PolicyReceiptSha256='hash';PolicyMode='candidate';PolicySha256='policy';BwrapSha256='bwrap';CutoverApproved=$true;Reviewer='reviewer';OriginalHomepageEvidence='evidence';ApprovalReference='approval'}
function ReadJson($Path){return $script:gate}
Reject {Gate} 'supervisor_gate_not_passed'
$script:gate.OriginalHomepagePassed=$true;Gate
$script:gate.NewCoreImage='different';Reject {Gate} 'review_gate_wrong_release'
# Replay-safe rename reconciles the retained ID; unrelated containers cannot be adopted.
$script:containers=@{retained=@{Id='old'}}
function Exists($Kind,$Name){return $script:containers.ContainsKey($Name)}
function Container($Name){return $script:containers[$Name]}
Rename 'live' 'retained' 'old'
Reject {Rename 'live' 'retained' 'other'} 'retained_name_collision'
# Stopped unrelated always-restart writers are unsafe even before a daemon restart.
$script:containers=@{other=@{Id='other';State=@{Running=$false;Restarting=$false};HostConfig=@{RestartPolicy=@{Name='always'}};Mounts=@(@{Type='volume';Name='prod';RW=$true})}}
function Docker($A,$InputText='', $Environment=@{}) {return 'other'}
Reject {AssertExclusive 'prod' @()} 'another_running_volume_writer_requires_review'
$script:containers.other.HostConfig.RestartPolicy.Name='no';AssertExclusive 'prod' @()
function InventorySubmitters {}
function AssertExclusive($Volume,$Allowed){}
# Rollback after accepted new records keeps new core; never restore a DB archive.
$script:WebVolume='shared-web';$script:Web='web';$script:Core='core';$script:OldWeb='oldweb';$script:OldCore='oldcore';$script:CoreVolume='prod';$script:Invocation='attempt';$script:Release='rel'
$script:State=@{OriginalWeb=@{Id='old-web-id';Image='old-web-image';RestartPolicy=@{Name='always';MaximumRetryCount=0}};OriginalCore=@{Id='old-core-id';Image='old-core-image'};NewWeb='new-web-image';NewCore='new-core-image';FreshBackup=@{Ledger=@{verifiedAssets=0;fingerprints=@{}}};OldWebNewCore=@{passed=$true}}
$script:containers=@{web=@{Id='new-web-id';State=@{Running=$true};Image='new-web-image';Config=@{Labels=@{'artcraft.release'='rel'}}};core=@{Id='new-core-id';State=@{Running=$true};Image='new-core-image';Config=@{Labels=@{'artcraft.release'='rel'}}};oldweb=@{Id='old-web-id'};oldcore=@{Id='old-core-id'}}
$script:events=@()
$script:rejectRecoveryRuntime=$false
function AssertRuntime($Name,$Image,$Volume,[switch]$Production,[switch]$IsWeb){Check ($Name -eq $Core -and $Image -eq $State.NewCore -and $Volume -eq $CoreVolume -and $Production -and !$IsWeb) 'recovery requires exact production Core runtime validation';$script:events+="validate:$Name";if($script:rejectRecoveryRuntime){throw 'runtime-rejected'}}
function Restore($Volume,$Image,$Dir,$File){$script:events+='restore:data'}
function SetRestart($Name,$Policy){$script:events+="restart:$Name=$($Policy.Name)"}
function Stop($Name,[switch]$IsWeb){$script:events+="stop:$Name"}
function StartContainer($Name){$script:events+="start:$Name"}
function Ready($Name,[switch]$IsWeb){}
function Rename($From,$To,$Id){Check ($script:containers[$From].Id -eq $Id) 'rename identity';$script:containers[$To]=$script:containers[$From];$script:containers.Remove($From);$script:events+="rename:$From->$To"}
function Ledger($Name,$Command){if($Command -eq 'witness'){return @{id='id';owner='owner'}};return @{integrity='ok';active=3}}
function LegacyAudit($Name){return @{integrity='ok';active=0}}
function Offline($Image,$Volume,$Command){return @{integrity='ok';active=0;verifiedAssets=1;fingerprints=@{craft_jobs=@{count=1}}}}
function Probe($Name,$Witness,[switch]$Public,[switch]$Ordinary){return @{passed=$true}}
RestorePair
Check ($script:State.RollbackMode -eq 'old-web-new-core') 'new records force hybrid rollback'
Check ($script:containers.core.Id -eq 'new-core-id') 'new core retained'
Check ($script:containers.web.Id -eq 'old-web-id') 'old web restored'
Check (!($script:events -contains 'start:oldcore')) 'old worker never started after acceptance'
Check (!($script:events -contains 'stop:core')) 'active new Core never stopped for rollback'
Check ($script:events.IndexOf('validate:core') -lt $script:events.IndexOf('start:core')) 'successful hybrid recovery validates before any Core start'
# A just-created invalid candidate and a running rejected candidate both remain
# intact. Validation failure never starts either worker or restores old data.
foreach($running in @($false,$true)){
    $script:containers=@{core=@{Id='new-core-id';State=@{Running=$running};Image='new-core-image';Config=@{Labels=@{'artcraft.release'='rel'}}};oldweb=@{Id='old-web-id'};oldcore=@{Id='old-core-id'}}
    $script:events=@();$script:rejectRecoveryRuntime=$true
    Reject {RestorePair} 'runtime-rejected'
    Check (@($script:events|Where-Object {$_ -match '^(start|stop|restore|rename):'}).Count -eq 0) 'rejected recovery causes zero starts/stops/data restores/renames'
    Check ($script:containers.core.Id -eq 'new-core-id' -and $script:containers.core.State.Running -eq $running -and $State.RecoveryInProgress) 'rejected new worker and recovery evidence remain intact'
}
$script:rejectRecoveryRuntime=$false
# Create succeeded/start failed, exited worker, and stop-interrupted recovery all
# reach the same stopped-candidate state. No docker exec is legal in this branch.
foreach($failure in @('start-failed','exited-worker','interrupted-after-stop')){
    $script:State=@{OriginalWeb=@{Id='old-web-id';Image='old-web-image';RestartPolicy=@{Name='always';MaximumRetryCount=0}};OriginalCore=@{Id='old-core-id';Image='old-core-image';RestartPolicy=@{Name='always';MaximumRetryCount=0}};NewWeb='new-web-image';NewCore='new-core-image';FreshBackup=@{Ledger=@{verifiedAssets=0;fingerprints=@{}}};OldWebNewCore=@{passed=$true}}
    $script:containers=@{core=@{Id='new-core-id';State=@{Running=$false};Image='new-core-image';Config=@{Labels=@{'artcraft.release'='rel'}}};oldweb=@{Id='old-web-id'};oldcore=@{Id='old-core-id'}}
    $script:events=@()
    function Offline($Image,$Volume,$Command){return @{integrity='ok';active=0;verifiedAssets=0;fingerprints=@{craft_projects=@{count=0}}}}
    function Ledger($Name,$Command){if($Command -eq 'witness'){return @{id='id';owner='owner'}};throw 'exec against stopped candidate forbidden'}
    RestorePair
    Check ($script:containers.core.Id -eq 'new-core-id' -and $script:containers.web.Id -eq 'old-web-id') $failure
    Check ($script:events -contains 'start:core' -and !($script:events -contains 'stop:core')) 'stopped candidate resumes its own new ledger without old worker'
    Check ($script:events.IndexOf('validate:core') -lt $script:events.IndexOf('start:core')) 'stopped recovery validates before start'
}
$script:events=@()
function Probe($Name,$Witness,[switch]$Public,[switch]$Ordinary){throw 'readback failure'}
try{RestoredWebCheck @{id='id';owner='owner'};throw 'should fail'}catch{Check ($_.Exception.Message -eq 'readback failure') 'restore readback failure preserved'}
Check (!($script:events -contains 'stop:web')) 'failed readback preserves healthy recovered entry'
# No hypothetical external receipt and no rejection of retained submitters.
Check (!($ast.Extent.Text -match 'function AdmissionGate|function AssertOnlySubmitter|AdmissionReceipt')) 'no external admission dependency'
foreach($name in @('TargetsCore','CheckCanaryPort')){
    $f=$ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$false)|Where-Object Name -eq $name
    Invoke-Expression $f.Extent.Text
}
$script:Plan=@{PolicyMode='candidate'};$script:Invocation='cutover01';$script:Release='rel';$script:Network='production';$script:CanaryWeb='newcanary'
$target=@{Id=('a'*64);Config=@{Env=@('IMAGE2_API_TOKEN=synthetic')};NetworkSettings=@{Networks=@{production=@{IPAddress='192.0.2.2';Aliases=@('image2')}}}}
$other=@{Id=('b'*64);Name='/independent-core';NetworkSettings=@{Networks=@{production=@{IPAddress='192.0.2.3';Aliases=@('independent')}}}}
$client=@{Config=@{Env=@('IMAGE2_API_TOKEN=synthetic','IMAGE2_API_URL=http://independent:18088')};NetworkSettings=@{Networks=@{production=@{}}}}
$script:containers=@{other=$other}
function Docker($A,$InputText='', $Environment=@{}) {return 'other'}
Check (!(TargetsCore $client $target)) 'same token resolved to independent API is not target'
$client.Config.Env=@('IMAGE2_API_TOKEN=different','IMAGE2_API_URL=http://image2:18088')
Check (TargetsCore $client $target) 'actual target destination inventoried even token differs'
$target.NetworkSettings.Networks.production.Remove('Aliases');Check (TargetsCore $client $target) 'target endpoint may omit optional Aliases'
$other.NetworkSettings.Networks.production.Remove('Aliases');$client.Config.Env=@('IMAGE2_API_TOKEN=synthetic','IMAGE2_API_URL=http://independent-core:18088');Check (!(TargetsCore $client $target)) 'resolved independent endpoint may omit optional Aliases'
$client.Config.Env=@('IMAGE2_API_TOKEN=synthetic','IMAGE2_API_URL=http://unknown.invalid:18088')
Reject {TargetsCore $client $target} 'submitter_destination_unresolved'
# All Docker bindings, including a stopped/unrelated IPv6 publication, participate.
$script:containers=@{other=@{Id='other';HostConfig=@{PortBindings=@{'80/tcp'=@(@{HostPort='18199';HostIp='::'})}}}}
function Get-NetTCPConnection {return @()}
Reject {CheckCanaryPort} 'docker_18199_in_use'
$script:containers.other.HostConfig.PortBindings['80/tcp'][0].HostPort='18198';CheckCanaryPort
function Get-NetTCPConnection {return @(@{LocalPort=18199})}
Reject {CheckCanaryPort} 'windows_18199_in_use'
# Full stopped-Core snapshot leaves every Web running and audits after real closure.
foreach($name in @('Snapshot')){$f=$ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$false)|Where-Object Name -eq $name;Invoke-Expression $f.Extent.Text}
$script:ReleaseRoot='/tmp/release';$script:WebVolume='shared-web';$script:events=@()
$script:State=@{OriginalWeb=@{Id='old-web-id';Image='old-web-image'};OriginalCore=@{Id='old-core-id';Image='old-core-image'};NewCore='new-core';Backups=@();GracefulStops=@{};OldShutdownSource=@{Hashes='verified'}}
function AssertOriginal {}
function VerifyOldShutdown {$script:events+='shutdown-source-verified'}
function Stop($Name,[switch]$IsWeb){Check ($Name -eq $Core) 'snapshot never stops Web';$script:events+="stop:$Name";$script:State.GracefulStops['old-core-id']=@{Status='normal-exit';ExitCode=0}}
$script:containers=@{core=@{Id='old-core-id';State=@{Running=$false}}}
function AssertExclusive($Volume,$Allowed){Check ($Volume -eq $CoreVolume) 'exclusive only image2'}
function ReconcileGracefulStop($Name,$ExpectedId,[int]$WaitSeconds=180){}
function ResumeOriginalCore {OriginalStart $Core $State.OriginalCore;Ready $Core}
function PrivateDirectory($Path){}
function SaveJson($Path,$Value){}
function Ledger($Name,$Command){if($Command -eq 'witness'){return @{id='id';owner='owner';assets=@()}};Check ($Name -eq $Core -and $Command -eq 'audit') 'never drain shared Web job ledger';return @{integrity='ok';active=0}}
function Probe($Name,$Witness,[switch]$Public,[switch]$Ordinary){return @{passed=$true}}
function Offline($Image,$Volume,$Command){if($Command -eq 'tree'){return @{sha256='same'}};return @{integrity='ok';active=0;verifiedAssets=0;fingerprints=@{}}}
function Archive($Volume,$Image,$Dir,$File){$script:events+="archive:$Volume";Check ($Volume -eq $CoreVolume -and $File -eq 'image2.tar') 'only full image2 backup'}
function Restore($Volume,$Image,$Dir,$File){Check ($Volume -ne $WebVolume -and $Volume -ne $CoreVolume -and $File -eq 'image2.tar') 'only independent image2 restore'}
function OriginalStart($Name,$Original){$script:events+="resume:$Name"}
$snapshot=Snapshot 'prepare'
Check (!$snapshot.ContainsKey('WebVolume') -and $snapshot.RestoreVerified) 'snapshot receipt makes no shared Web consistency claim'
Check ($script:events[0] -eq 'shutdown-source-verified') 'verified actual shutdown source precedes stop'
Check ($script:events -contains 'resume:core' -and !($script:events -contains 'resume:web')) 'prepare resumes exact Core and never interrupts Web'
function Archive($Volume,$Image,$Dir,$File){throw 'backup failed'}
$script:events=@();try{Snapshot 'prepare';throw 'unexpected pass'}catch{Check ($_.Exception.Message -eq 'backup failed') 'backup failure retained'}
Check ($script:events -contains 'resume:core' -and !($script:events -contains 'resume:web')) 'backup failure resumes Core without restoring old data'
# An offline queued race restarts original IDs before failing; never reaches archive.
function Archive($Volume,$Image,$Dir,$File){throw 'queued race must not archive'}
function Offline($Image,$Volume,$Command){return @{integrity='ok';active=1;states=@{jobs=@{queued=1}}}}
$script:events=@();Reject {Snapshot 'cutover' -LeaveStopped} 'closed_core_queued_race_original_resumed_no_promotion'
Check ($script:events -contains 'resume:core') 'queued race resumes exact original Core'

# Zero active plus stable historical uncertainty passes; new uncertainty aborts.
function Ledger($Name,$Command){if($Command -eq 'witness'){return @{id='id';owner='owner';assets=@()}};return @{integrity='ok';active=0;uncertain=1;uncertainRecords=@('old:stable')}}
function Offline($Image,$Volume,$Command){return @{integrity='ok';active=0;uncertain=2;uncertainRecords=@('old:stable','new:unknown')}}
$script:events=@();Reject {Snapshot 'cutover' -LeaveStopped} 'closed_core_new_uncertain_original_resumed_no_promotion'
Check ($script:events -contains 'resume:core' -and $script:State.StopUncertain) 'new uncertainty preserves records and returns original Core'

# The actual BFF serialization keeps a singleton association as an array.
foreach($name in @('Probe','CutoverStage','ReadbackStage')){$f=$ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$false)|Where-Object Name -eq $name;Invoke-Expression $f.Extent.Text}
$script:BffCode='synthetic'
function NodeCode($Name,$Code,$Values){$decoded=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Values.ARTCRAFT_PROBE_INPUT));$script:capturedProbe=ConvertFrom-Json $decoded;return '{"passed":true}'}
$null=Probe 'web' @{id='id';owner='owner';assets=@(@{id='asset';bytes=3;sha256=('a'*64)})}
Check ($script:capturedProbe.assets -is [array] -and $script:capturedProbe.assets.Count -eq 1 -and $script:capturedProbe.assets[0].bytes -eq 3) 'singleton witness crosses PowerShell JSON intact'
# Cutover runs exactly one short native smoke before Web starts; Readback never runs native tests.
$script:State=@{RolledBack=$false;CutoverComplete=$false;EntryReady=$false;CutoverStarted=$false;NewCore='new-core';NewWeb='new-web';PreparedBackup=@{CoreVolume='copy'};OriginalCore=@{Id='old-core-id'};OriginalWeb=@{Id='old-web-id'};CanaryBuildId='build'}
$script:CanaryCore='canary-core';$script:CanaryWeb='canary-web';$script:CanaryWebVolume='empty-web';$script:NativeVolume='native-ro';$script:events=@()
function Gate {}
function InventorySubmitters {}
function AssertExclusive($Volume,$Allowed){Check ($Volume -in @($CoreVolume,$NativeVolume)) 'exclusive gates cover only image2/native'}
function CheckSource {}
function CheckNativeBundle {}
function VerifyNativeVolume {}
function AssertRuntime($Name,$Image,$Volume,[switch]$Production,[switch]$IsWeb){}
function Rename($From,$To,$Id){}
function StopLegacyWeb($Name){}
function Snapshot($Purpose,[switch]$LeaveStopped){$script:ProductionWitness=@{id='id';owner='owner'};return @{Ledger=@{}}}
function NativeTests($Name,$Label,[switch]$Smoke){Check $Smoke 'cutover permits short smoke only';$script:events+='smoke';return @{Passed=$true}}
function CreateService($Name,$Image,$Volume,[switch]$Production,[switch]$IsWeb){$script:events+="create:$Name"}
function NodeCode($Name,$Code,$Values){return 'build'}
function Probe($Name,$Witness,[switch]$Public,[switch]$Ordinary){$script:events+="probe:$Public";return @{passed=$true}}
CutoverStage
Check ($script:State.EntryReady -and !$script:State.CutoverComplete -and $script:State.CoreEntryMayReopenAt) 'Core startup records reopening before matching Web'
Check (($script:events -join ',') -eq 'create:core,smoke,create:web,probe:False') 'short smoke precedes Web then local BFF only'
$script:events=@();ReadbackStage
Check (($script:events -join ',') -eq 'probe:True' -and $script:State.CutoverComplete) 'public readback is concise and read-only'
function Probe($Name,$Witness,[switch]$Public,[switch]$Ordinary){throw 'public readback failed'}
function RestorePair {throw 'must not auto rollback after entry'}
try{ReadbackStage;throw 'unexpected pass'}catch{Check ($_.Exception.Message -eq 'public readback failed') 'post-entry readback failure retains accepted work without automatic rollback'}

$f=$ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$false)|Where-Object Name -eq 'StopOwned';Invoke-Expression $f.Extent.Text
$script:containers=@{collision=@{Config=@{Labels=@{'artcraft.release'='someone-else'}}}}
$script:events=@();Reject {StopOwned 'collision'} 'stop_resource_owned_elsewhere'
Check ($script:events.Count -eq 0) 'release-name collision never stops unrelated container'
# Real graceful-stop implementation: signal exact ID, validate normal exit, no force.
foreach($name in @('Stop','ReconcileGracefulStop','StopLegacyWeb','InventorySubmitters')){$f=$ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$false)|Where-Object Name -eq $name;Invoke-Expression $f.Extent.Text}
$script:State=@{OriginalWeb=@{Id='old-web-id'}};$script:events=@();$script:stopped=$false;$script:exitCode=0;$script:stayRunning=$false;$script:mockStarted='2026-10-14T16:00:00Z';$script:mockImage='old-core-image'
function Exists($Kind,$Name){return $true}
function Container($Name){return @{Id='exact-core-id';Image=$script:mockImage;State=@{Running=(!$script:stopped);Restarting=$false;StartedAt=$script:mockStarted;FinishedAt='2026-10-14T16:30:00Z';ExitCode=$script:exitCode;OOMKilled=$false}}}
function Docker($A,$InputText='', $Environment=@{}){
    Check (($A -join ',') -eq 'kill,--signal=TERM,exact-core-id') 'only exact-ID SIGTERM; never timeout SIGKILL'
    $script:events+=($A -join ',');$script:stopped=(!$script:stayRunning);return ''
}
function BeginOp($Name){}
function DoneOp {}
Stop 'core'
Check ($script:State.GracefulStops['exact-core-id'].Status -eq 'normal-exit') 'Core exit0 receipt accepted'
$script:stopped=$false;$script:exitCode=137;Reject {Stop 'core'} 'graceful_exit_not_proven'
$script:State.GracefulStops=@{};$script:stopped=$false;$script:exitCode=143;Reject {Stop 'core'} 'graceful_exit_not_proven'
$script:State.GracefulStops=@{};$script:stopped=$false;Stop 'web' -IsWeb
Check ($script:State.GracefulStops['exact-core-id'].ExitCode -eq 143) 'Next graceful signal exit143 recorded separately'
$script:State.GracefulStops=@{};$script:stopped=$false;$script:stayRunning=$true;$script:events=@();Reject {Stop 'core' -WaitSeconds 0} 'graceful_wait_timeout_no_force_no_promotion'
Check ($script:events.Count -eq 1 -and !$script:State.GracefulStops['exact-core-id'].Forced) 'timeout never forces a second signal or reports drain'
# Timeout is a pending receipt: a later same-process exit0 reconciles without any
# second signal; image/start/finished identity drift and abnormal exit are rejected.
$script:stopped=$true;$script:exitCode=0;ReconcileGracefulStop 'core' 'exact-core-id' -WaitSeconds 0
Check ($script:State.GracefulStops['exact-core-id'].Status -eq 'normal-exit' -and $script:events.Count -eq 1) 'timeout then late exit0 recovered without another signal'
$script:mockStarted='2026-10-14T16:01:00Z';Reject {ReconcileGracefulStop 'core' 'exact-core-id' -WaitSeconds 0} 'stop_identity_or_restart_changed';$script:mockStarted='2026-10-14T16:00:00Z'
$script:mockImage='different-image';Reject {ReconcileGracefulStop 'core' 'exact-core-id' -WaitSeconds 0} 'stop_identity_or_restart_changed';$script:mockImage='old-core-image'
$script:exitCode=137;Reject {ReconcileGracefulStop 'core' 'exact-core-id' -WaitSeconds 0} 'graceful_exit_not_proven'
# Legacy nonterminal precheck postpones without signal; late work restores service,
# preserves ledger bytes and records uncertain interruption, never paid replay.
$script:events=@();$script:legacyActive=1
function Container($Name){return @{Id='old-web-id';Image='old-web-image';State=@{Running=$true}}}
function LegacyAudit($Name){return @{integrity='ok';active=$script:legacyActive}}
function Stop($Name,[switch]$IsWeb){$script:events+='stop-web'}
function OriginalStart($Name,$Original){$script:events+='restore-web'}
Reject {StopLegacyWeb 'web'} 'drain_required_no_automatic_retries'
Check ($script:events.Count -eq 0) 'legacy activity postpones before stop'
$script:legacyActive=0
function Offline($Image,$Volume,$Command,$Destination){return @{integrity='ok';active=1}}
Reject {StopLegacyWeb 'web'} 'legacy_interruption_uncertain_no_paid_replay'
Check ($script:State.LegacyStop.UncertainInterruption -and $script:events -contains 'restore-web') 'late unfinished legacy receipt preserved and service restored'
# Known other callers are inventory, not deployment rejection.
$script:containers=@{core=@{Id='core-id'};canary=@{Id='canary-id';Name='/existing-canary';Image='old-web'}}
function Container($Name){return $script:containers[$Name]}
function Docker($A,$InputText='', $Environment=@{}){return "core`ncanary"}
function TargetsCore($Candidate,$Target){return $true}
InventorySubmitters
Check ($script:State.SubmitterInventory.Containers.Count -eq 1 -and $script:State.SubmitterInventory.Containers[0].Destination -eq 'target') 'retained canary accepted as evidence'
# Recovery entry reconciles the pending exact process, then records the intentional
# restart so a repeated recovery can distinguish it from an unrelated restart.
$f=$ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$false)|Where-Object Name -eq 'ResumeOriginalCore';Invoke-Expression $f.Extent.Text
$script:State=@{OriginalCore=@{Id='original-id';Image='original-image'};GracefulStops=@{'original-id'=@{ContainerId='original-id';Image='original-image';StartedAt='2026-10-14T16:00:00Z';Status='timeout-still-uncertain';IsWeb=$false}}}
$script:resumeRunning=$false;$script:resumeStarted='2026-10-14T16:00:00Z';$script:resumeExit=0;$script:resumeCalls=0
function Container($Name){return @{Id='original-id';Image='original-image';State=@{Running=$script:resumeRunning;Restarting=$false;StartedAt=$script:resumeStarted;FinishedAt='2026-10-14T16:30:00Z';ExitCode=$script:resumeExit;OOMKilled=$false}}}
function OriginalStart($Name,$Original){if(!$script:resumeRunning){$script:resumeCalls++;$script:resumeRunning=$true;$script:resumeStarted='2026-10-14T16:31:00Z'}}
ResumeOriginalCore;ResumeOriginalCore
Check ($script:resumeCalls -eq 1 -and $script:State.GracefulStops['original-id'].ResumedStartedAt -eq $script:resumeStarted) 'late normal exit restores original once and records verified intentional restart'
$script:resumeStarted='2026-10-14T16:32:00Z';Reject {ResumeOriginalCore} 'stop_identity_or_restart_changed'
$script:resumeRunning=$false;$script:resumeStarted='2026-10-14T16:00:00Z';$script:resumeExit=137
Reject {ResumeOriginalCore} 'graceful_exit_not_proven'
Check ($script:resumeCalls -eq 1) 'abnormal or externally restarted process never auto-started'
# Setup failure is retained on the host even when no container evidence leaf exists.
foreach($name in @('PolicyProof','SaveJson')){$f=$ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$false)|Where-Object Name -eq $name;Invoke-Expression $f.Extent.Text}
$script:ReleaseRoot=Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString('N'));$script:Invocation='empty-volume-case';$script:Plan=@{PolicyMode='builtin';PolicySha256='builtin'}
function Exec($File,$Arguments,$InputText,$Environment,$AcceptExitCodes){Check ($AcceptExitCodes -contains 1) 'failed probe JSON is captured before checking receipt';return '{"status":"failed","stage":"evidence-setup","evidence":null,"setupFailure":true,"errorCode":"EEXIST"}'}
function Docker($A,$InputText='', $Environment=@{}){throw 'no docker cp without a valid evidence leaf'}
try {
    Reject {PolicyProof 'builtin-control' -Control} 'policy_probe_setup_failed'
    $receipt=Get-Content -Raw (Join-Path $script:ReleaseRoot 'evidence/builtin-control-empty-volume-case/setup-failure.json')|ConvertFrom-Json
    Check ($receipt.Invocation.setupFailure -and $receipt.Invocation.errorCode -eq 'EEXIST') 'setup failure receipt retained instead of masking it with docker cp failure'
} finally {if(Test-Path -LiteralPath $script:ReleaseRoot){[IO.Directory]::Delete($script:ReleaseRoot,$true)}}
Write-Output "Passed $script:checks orchestration assertions (mocked Docker; no production access)."
