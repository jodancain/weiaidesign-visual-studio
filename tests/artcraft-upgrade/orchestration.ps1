# No Docker or production calls. AST-load ONLY function definitions, then mock I/O.
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$path=Join-Path $repo 'scripts/artcraft-upgrade/upgrade.ps1'
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
if($errors.Count){throw ($errors|ForEach-Object {$_.ToString()}|Out-String)}
foreach($f in $ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$false)){Invoke-Expression $f.Extent.Text}
$taskAst=[Management.Automation.Language.Parser]::ParseFile((Join-Path $repo 'scripts/artcraft-upgrade/task.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'task wrapper parse failed'}
$null=[Management.Automation.Language.Parser]::ParseFile((Join-Path $repo 'scripts/artcraft-sandbox-policy/collect-review-facts.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'policy collector parse failed'}
$script:checks=0
function Check($Condition,$Name){if(!$Condition){throw "test failed: $Name"};$script:checks++}
function Reject([scriptblock]$Action,[string]$Code){try{& $Action;throw 'did not reject'}catch{Check ($_.Exception.Message -eq $Code) $Code}}
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
$script:containers=@{other=@{Id='other';State=@{Running=$false;Restarting=$false};HostConfig=@{RestartPolicy=@{Name='always'}};Mounts=@(@{Name='prod';RW=$true})}}
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
function SetRestart($Name,$Policy){$script:events+="restart:$Name=$($Policy.Name)"}
function Stop($Name,[switch]$IsWeb){$script:events+="stop:$Name"}
function Start($Name){$script:events+="start:$Name"}
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
