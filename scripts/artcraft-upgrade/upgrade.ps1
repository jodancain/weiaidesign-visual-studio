#requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$RequestFile)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $OutputEncoding=[Text.UTF8Encoding]::new($false)
$Root='C:\Users\qrrwi\studio-v3-production'
$Web='weiai-studio-v3-web'; $Core='weiai-image2'; $Network='weiai-studio-v3-production'
$CoreVolume='weiai-image2-data'; $WebVolume='weiaidesign-web_weiaidesign-data'
$script:State=$null; $script:Lock=$null; $script:Failure='unclassified'; $script:Step='load-request'; $script:ExitCode=1
function Need($Condition,[string]$Code) { if(!$Condition){$script:Failure=$Code;throw [InvalidOperationException]::new($Code)} }
function Map($Value) {
    if($null -eq $Value){return $null}
    if($Value -is [System.Management.Automation.PSCustomObject]){$m=@{};foreach($p in $Value.PSObject.Properties){$m[$p.Name]=Map $p.Value};return $m}
    if($Value -is [array]){return ,@($Value | ForEach-Object {Map $_})}
    return $Value
}
function ReadJson([string]$Path){return Map ([IO.File]::ReadAllText($Path)|ConvertFrom-Json)}
function Hash([string]$Path){return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()}
function VerifyQueuedBytes([string]$Runner,[string]$Ledger,[string]$Bff){
    Need ((Hash $Runner) -ceq $Request.RunnerSha256) 'queued_runner_changed'
    Need ((Hash $Ledger) -ceq $Request.LedgerSha256) 'queued_ledger_helper_changed'
    Need ((Hash $Bff) -ceq $Request.BffSha256) 'queued_bff_helper_changed'
    if($Request.GateReceipt){Need ((Hash $Request.GateReceipt) -ceq $Request.GateSha256) 'queued_gate_changed'}
    foreach($file in $Request.FrozenFiles.Keys){Need ($file -notmatch '(^|/)\.\.(/|$)|\\|:|^/|(^|/)\.env') 'unsafe_frozen_source_path';Need ((Hash (Join-Path $Request.BootstrapRoot $file)) -ceq $Request.FrozenFiles[$file]) 'queued_source_changed'}
    Need ((Hash (Join-Path $Request.BootstrapRoot 'UPGRADE-SOURCE.json')) -ceq $Plan.SourceManifestSha256) 'queued_manifest_changed'
    $manifest=ReadJson (Join-Path $Request.BootstrapRoot 'UPGRADE-SOURCE.json')
    Need ($manifest.files.Count -eq $Request.FrozenFiles.Count -and $manifest.head -ceq $Plan.SourceCommit) 'queued_source_inventory_changed'
    foreach($file in $manifest.files.Keys){Need ($Request.FrozenFiles[$file] -ceq $manifest.files[$file]) 'queued_source_inventory_changed'}
    CheckInputs

}
function SaveJson([string]$Path,$Value){
    $tmp="$Path.$([Guid]::NewGuid().ToString('N')).partial"; $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Depth 50))
    $f=[IO.File]::Open($tmp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$f.Write($bytes,0,$bytes.Length);$f.Flush($true)}finally{$f.Dispose()}
    if(Test-Path -LiteralPath $Path){[IO.File]::Replace($tmp,$Path,$null)}else{[IO.File]::Move($tmp,$Path)}
}
function SaveState { $script:State.UpdatedAt=[DateTime]::UtcNow.ToString('o'); SaveJson $StatePath $script:State }
function BeginOp([string]$Name){$script:Step=$Name;$script:State.PendingOperation=$Name;SaveState}
function DoneOp { $script:State.PendingOperation=$null;SaveState }
function PrivateDirectory([string]$Path){
    $null=[IO.Directory]::CreateDirectory($Path)
    $acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetAccessRuleProtection($true,$false)
    foreach($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'),[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}
    (Get-Item -LiteralPath $Path).SetAccessControl($acl)
}
# Arguments are nonsecret. Runtime values use the child process environment, never argv/env files.
function QuoteArg([string]$Value){'"'+[regex]::Replace([regex]::Replace($Value,'(\\*)"','$1$1\"'),'(\\+)$','$1$1')+'"'}
function Exec([string]$File,[string[]]$Arguments,[string]$InputText='',[hashtable]$Environment=@{},[int[]]$AcceptExitCodes=@(0)){
    $si=[Diagnostics.ProcessStartInfo]::new();$si.FileName=$File;$si.Arguments=($Arguments|ForEach-Object {QuoteArg $_}) -join ' '
    $si.UseShellExecute=$false;$si.CreateNoWindow=$true;$si.RedirectStandardInput=$true;$si.RedirectStandardOutput=$true;$si.RedirectStandardError=$true
    foreach($k in $Environment.Keys){$si.EnvironmentVariables[$k]=[string]$Environment[$k]}
    $p=[Diagnostics.Process]::new();$p.StartInfo=$si;$null=$p.Start()
    $stdout=$p.StandardOutput.ReadToEndAsync();$stderr=$p.StandardError.ReadToEndAsync()
    $p.StandardInput.Write($InputText);$p.StandardInput.Close();if(!$p.WaitForExit(5400000)){try{$p.Kill()}catch{};throw 'command_timeout_state_unknown_no_replay'}
    $out=$stdout.GetAwaiter().GetResult();$null=$stderr.GetAwaiter().GetResult();$code=$p.ExitCode;$p.Dispose()
    Need ($code -in $AcceptExitCodes) "command_exit_$code";return $out.Trim()
}
function Docker([string[]]$A,[string]$InputText='',[hashtable]$Environment=@{}) {Exec 'docker' $A $InputText $Environment}
function Object([string]$Kind,[string]$Name){return @(Map ((Docker @($Kind,'inspect',$Name))|ConvertFrom-Json))[0]}
function Exists([string]$Kind,[string]$Name){$list=Docker @($Kind,'ls','-a','--format','{{.Names}}');return (($list -split '\r?\n') -contains $Name)}
function Container([string]$Name){Object 'container' $Name}
function EnvMap($Container){$envs=@{};foreach($pair in $Container.Config.Env){$s=$pair -split '=',2;$envs[$s[0]]=$s[1]};return $envs}
function Safe($c){return @{Id=$c.Id;Image=$c.Image;Name=$c.Name;User=$c.Config.User;Running=$c.State.Running;Mounts=$c.Mounts;Ports=$c.HostConfig.PortBindings;Networks=$c.NetworkSettings.Networks.Keys;SecurityOpt=$c.HostConfig.SecurityOpt;RestartPolicy=$c.HostConfig.RestartPolicy;CapDrop=$c.HostConfig.CapDrop;ReadonlyRootfs=$c.HostConfig.ReadonlyRootfs;ImageTag=$c.Config.Image;SourceArchiveSha256=$c.Config.Labels['weiai.image2.source-sha'];ReleaseLabel=$c.Config.Labels['weiai.image2.release']}}
function AssertOriginal([switch]$Stopped){
    $w=Container $Web;$c=Container $Core
    foreach($pair in @(@($w,$State.OriginalWeb),@($c,$State.OriginalCore))){Need ($pair[0].Id -ceq $pair[1].Id -and $pair[0].Image -ceq $pair[1].Image) 'production_identity_drift';if(!$Stopped){Need $pair[0].State.Running 'original_not_running'}}
    foreach($pair in @(@($w,$State.OriginalWeb),@($c,$State.OriginalCore))){Need (($pair[0].HostConfig.RestartPolicy|ConvertTo-Json -Compress) -ceq ($pair[1].RestartPolicy|ConvertTo-Json -Compress)) 'original_restart_policy_drift'}
    AssertLayout $w $WebVolume '/data' -IsWeb;AssertLayout $c $CoreVolume '/data/image2'
    Need ((Object 'network' $Network).Id -ceq $Plan.ExpectedNetworkId) 'production_network_identity_drift'
    $we=EnvMap $w;$ce=EnvMap $c
    Need ($we.IMAGE2_API_TOKEN -and $we.IMAGE2_API_TOKEN -ceq $ce.IMAGE2_API_TOKEN) 'existing_internal_token_mismatch'
    Need ($we['STUDIO_VISITOR_SECRET'] -or $we['VIDEO_API_PROXY_TOKEN'] -or $we['VIDEO_API_TOKEN']) 'visitor_signing_missing'
    Need ($we.IMAGE2_API_URL -eq 'http://image2:18088') 'core_alias_requires_review'
}
function AssertLayout($c,[string]$Volume,[string]$Destination,[switch]$IsWeb){
    Need (@($c.Mounts).Count -eq 1 -and $c.Mounts[0].Name -eq $Volume -and $c.Mounts[0].Destination -eq $Destination -and $c.Mounts[0].RW) 'original_mount_layout_requires_review'
    Need (@($c.NetworkSettings.Networks.Keys).Count -eq 1 -and $c.NetworkSettings.Networks.ContainsKey($Network)) 'original_network_layout_requires_review'
    Need (!$c.HostConfig.Privileged -and !$c.HostConfig.CapAdd -and !$c.HostConfig.Devices) 'original_host_policy_requires_review'
    if($IsWeb){Need ($c.HostConfig.PortBindings.Keys.Count -eq 1 -and @($c.HostConfig.PortBindings['18084/tcp'] | Where-Object {$_.HostPort -ne '18194'}).Count -eq 0) 'original_web_port_mismatch'}
    else {Need (!$c.HostConfig.PortBindings -or $c.HostConfig.PortBindings.Keys.Count -eq 0) 'core_published_port'}
}
function AssertExclusive([string]$Volume,[string[]]$Allowed){
    $ids=(Docker @('ps','-aq','--filter',"volume=$Volume")) -split '\r?\n'
    foreach($id in $ids){if(!$id){continue};$c=Container $id;foreach($m in $c.Mounts){if($m.Name -eq $Volume -and $m.RW -and ($c.State.Running -or $c.State.Restarting -or $c.HostConfig.RestartPolicy.Name -eq 'always')){Need ($Allowed -contains $c.Id) 'another_running_volume_writer_requires_review'}}}
}
function TargetsCore($Candidate,$Target) {
    # Values never leave host memory. Token equality alone does not identify a destination.
    $values=EnvMap $Candidate;$raw=$values['IMAGE2_API_URL']
    if(!$raw){return ($values['IMAGE2_API_TOKEN'] -and $values['IMAGE2_API_TOKEN'] -ceq (EnvMap $Target)['IMAGE2_API_TOKEN'])}
    $uri=$null;Need ([Uri]::TryCreate($raw,[UriKind]::Absolute,[ref]$uri)) 'submitter_destination_unresolved'
    $hostName=$uri.DnsSafeHost;$shared=@($Candidate.NetworkSettings.Networks.Keys|Where-Object {$Target.NetworkSettings.Networks.ContainsKey($_)})
    foreach($net in $shared){$n=$Target.NetworkSettings.Networks[$net];if($hostName -in @('image2',$Core,$Target.Id,$Target.Id.Substring(0,12),$n.IPAddress)+@($n.Aliases)){return $true}}
    # An unresolved same-token destination may route back through an external proxy.
    # Exact reviewed non-target destinations are allowed only when topology resolves.
    foreach($net in $shared){
        $others=(Docker @('ps','-q','--filter',"network=$net")) -split '\r?\n'
        foreach($id in $others){if(!$id -or $id -eq $Target.Id){continue};$other=Container $id;$n=$other.NetworkSettings.Networks[$net]
            if($hostName -in @($other.Name.TrimStart('/'),$other.Id,$other.Id.Substring(0,12),$n.IPAddress)+@($n.Aliases)){return $false}}
    }
    Need (!$values['IMAGE2_API_TOKEN'] -or $values['IMAGE2_API_TOKEN'] -cne (EnvMap $Target)['IMAGE2_API_TOKEN']) 'submitter_destination_unresolved'
    return $false
}
function InventorySubmitters {
    # Discovery evidence only. Core listener closure covers every caller, including
    # the three retained canaries; no external ingress assertion is requested.
    $target=if(Exists 'container' $Core){Container $Core}else{Container $OldCore};$found=@()
    foreach($id in ((Docker @('ps','-q')) -split '\r?\n')){
        if(!$id){continue};$c=Container $id;if($c.Id -eq $target.Id){continue}
        $classification='not-target'
        $savedFailure=$script:Failure
        try {if(TargetsCore $c $target){$classification='target'}} catch {$classification='unresolved';$script:Failure=$savedFailure}
        $found+=@(@{Id=$c.Id;Name=$c.Name;Image=$c.Image;Destination=$classification})
    }
    $State.SubmitterInventory=@{At=[DateTime]::UtcNow.ToString('o');Containers=$found;NotAnAdmissionBarrier=$true};SaveState
}
function VerifyOldShutdown {
    $c=Container $Core;Need ($c.Id -ceq $State.OriginalCore.Id -and $c.Image -ceq $State.OriginalCore.Image -and $c.State.Running) 'shutdown_source_identity'
    $code="import fs from 'node:fs';import {createHash} from 'node:crypto';console.log(JSON.stringify(Object.fromEntries(['server.mjs','jobs.mjs'].map(f=>[f,createHash('sha256').update(fs.readFileSync('/app/'+f)).digest('hex')]))));"
    $hashes=Map ((NodeCode $Core $code)|ConvertFrom-Json)
    Need ($hashes['server.mjs'] -ceq 'c20f9d762ecdd7398b104ac5d79e25fa2bdb5a5e0d6d7ca9ec836bb776d72fc0' -and $hashes['jobs.mjs'] -ceq 'cdf7bfa9c3ca74e81c33d70d003fa5c69081bb9958030f98af44b056a7b7b24e') 'old_shutdown_source_changed'
    $State.OldShutdownSource=@{ContainerId=$c.Id;Image=$c.Image;Hashes=$hashes;At=[DateTime]::UtcNow.ToString('o');Contract='server.close -> runner.stop(activePromises) -> store.close -> exit0'};SaveState
}
function NodeCode([string]$Name,[string]$Code,[hashtable]$Values=@{}){
    $args=@('exec','-i');foreach($k in $Values.Keys){$args+=@('--env',$k)};$args+=@($Name,'node','--no-warnings','--input-type=module')
    return Docker $args $Code $Values
}
function Ledger([string]$Name,[string]$Command){$dest=if($Command -eq 'web-jobs'){'/data'}else{'/data/image2'};return Map ((NodeCode $Name $LedgerCode @{ARTCRAFT_UPGRADE_COMMAND=$Command;ARTCRAFT_UPGRADE_DATA=$dest})|ConvertFrom-Json)}
function Offline([string]$Image,[string]$Volume,[string]$Command,[string]$Destination='/data/image2'){
    $envs=@{ARTCRAFT_UPGRADE_COMMAND=$Command;ARTCRAFT_UPGRADE_DATA=$Destination}
    $user=if($Destination -eq '/data'){WebUser}else{'node'}
    $a=@('run','--rm','-i','--network','none','--user',$user,'--cpus','2','--memory','2g','--pids-limit','256','--cap-drop','ALL','--security-opt','no-new-privileges=true','--mount',"type=volume,source=$Volume,target=$Destination",'--entrypoint','node')
    if($Command -eq 'web-jobs'){$a[$a.IndexOf("type=volume,source=$Volume,target=$Destination")]="type=volume,source=$Volume,target=$Destination,readonly"}
    foreach($k in $envs.Keys){$a+=@('--env',$k)};$a+=@($Image,'--no-warnings','--input-type=module')
    return Map ((Docker $a $LedgerCode $envs)|ConvertFrom-Json)
}
function Idle($Audit){Need ($Audit.integrity -eq 'ok' -and $Audit.active -eq 0) 'drain_required_no_automatic_retries'}
function SameUncertain($Before,$After){return (($Before['uncertainRecords'] -join '|') -ceq ($After['uncertainRecords'] -join '|'))}
function EqualAudit($Before,$After){
    foreach($t in $Before.fingerprints.Keys){$a=$Before.fingerprints[$t];$b=$After.fingerprints[$t];Need ($a.count -eq $b.count -and $a.schema -ceq $b.schema -and $a.rows -ceq $b.rows) 'ledger_changed'}
    Need ($Before.verifiedAssets -eq $After.verifiedAssets) 'asset_count_changed'
}
function Resource([string]$Kind,[string]$Name){
    $all=Docker @($Kind,'ls','--format','{{.Name}}')
    if(($all -split '\r?\n') -contains $Name){$existing=Object $Kind $Name;Need ($existing.Labels.'artcraft.release' -ceq $Release) 'resource_owned_elsewhere';if($Kind -eq 'network'){Need $existing.Internal 'canary_network_not_internal'};return}
    BeginOp "create-$Kind-$Name"
    $a=@($Kind,'create','--label',"artcraft.release=$Release");if($Kind -eq 'network'){$a+='--internal'}
    $null=Docker ($a+@($Name));DoneOp
}
function WebUser {if($State.OriginalWeb.User){return $State.OriginalWeb.User};return '0'}
function SetRestart([string]$Name,$Policy){
    $value=$Policy.Name;if($value -eq 'on-failure' -and $Policy.MaximumRetryCount -gt 0){$value+=':'+$Policy.MaximumRetryCount}
    Need ($value -match '^(no|always|unless-stopped|on-failure(:[0-9]+)?)$') 'restart_policy_unknown'
    BeginOp "restart-policy-$Name";$null=Docker @('update',"--restart=$value",$Name);DoneOp
}
function OriginalStart([string]$Name,$Original){Need ((Container $Name).Id -ceq $Original.Id) 'original_start_identity';SetRestart $Name $Original.RestartPolicy;Start $Name}
function ReconcileGracefulStop([string]$Name,[string]$ExpectedId,[int]$WaitSeconds=180){
    Need ($State.GracefulStops.ContainsKey($ExpectedId)) 'graceful_receipt_missing'
    $receipt=$State.GracefulStops[$ExpectedId]
    for($i=0;$i -le $WaitSeconds;$i++){
        $c=Container $Name
        Need ($c.Id -ceq $ExpectedId -and $c.Id -ceq $receipt.ContainerId -and $c.Image -ceq $receipt.Image -and $c.State.StartedAt -ceq $receipt.StartedAt) 'stop_identity_or_restart_changed'
        if(!$c.State.Running -and !$c.State.Restarting){
            $valid=@(0);if($receipt['IsWeb']){$valid+=143}
            if($receipt.Status -eq 'normal-exit'){Need ($c.State.FinishedAt -ceq $receipt.FinishedAt) 'stop_finished_identity_changed'}
            $receipt.ExitCode=$c.State.ExitCode;$receipt.OOMKilled=$c.State.OOMKilled;$receipt.FinishedAt=$c.State.FinishedAt
            $finished=[DateTime]::MinValue
            $finishedValid=([DateTime]::TryParse([string]$c.State.FinishedAt,[ref]$finished) -and $finished.Year -gt 2000)
            $receipt.Status=if(!$c.State.OOMKilled -and $c.State.ExitCode -in $valid -and $finishedValid){'normal-exit'}else{'abnormal-exit'};SaveState
            Need ($receipt.Status -eq 'normal-exit') 'graceful_exit_not_proven';DoneOp;return
        }
        if($i -lt $WaitSeconds){Start-Sleep -Seconds 1}
    }
    $receipt.Status='timeout-still-uncertain';SaveState
    Need $false 'graceful_wait_timeout_no_force_no_promotion'
}
function Stop([string]$Name,[switch]$IsWeb,[int]$WaitSeconds=180){
    if(!(Exists 'container' $Name)){return};$c=Container $Name
    if(!$State.ContainsKey('GracefulStops')){$State.GracefulStops=@{}}
    if($State.GracefulStops.ContainsKey($c.Id)){
        $prior=$State.GracefulStops[$c.Id]
        if(!$c.State.Running -or $prior.Status -in @('waiting','timeout-still-uncertain')){ReconcileGracefulStop $Name $c.Id -WaitSeconds $WaitSeconds;return}
    }
    if(!$c.State.Running){return}
    $receipt=@{ContainerId=$c.Id;Image=$c.Image;StartedAt=$c.State.StartedAt;Signal='SIGTERM';SentAt=[DateTime]::UtcNow.ToString('o');Status='waiting';Forced=$false;IsWeb=[bool]$IsWeb}
    $State.GracefulStops[$c.Id]=$receipt;BeginOp "sigterm-$Name"
    # docker stop would SIGKILL when old StopTimeout=1 elapses. Never use it.
    $null=Docker @('kill','--signal=TERM',$c.Id)
    ReconcileGracefulStop $Name $c.Id -WaitSeconds $WaitSeconds
}
function ResumeOriginalCore {
    $c=Container $Core;Need ($c.Id -ceq $State.OriginalCore.Id -and $c.Image -ceq $State.OriginalCore.Image) 'original_start_identity'
    if($State.ContainsKey('GracefulStops') -and $State.GracefulStops.ContainsKey($c.Id)){
        $r=$State.GracefulStops[$c.Id]
        $alreadyResumed=($c.State.Running -and $r['ResumedStartedAt'] -and $c.State.StartedAt -ceq $r['ResumedStartedAt'])
        if(!$alreadyResumed){ReconcileGracefulStop $Core $State.OriginalCore.Id}
    } else {Need $c.State.Running 'original_stopped_without_shutdown_receipt'}
    OriginalStart $Core $State.OriginalCore;Ready $Core
    $c=Container $Core;Need ($c.Id -ceq $State.OriginalCore.Id -and $c.Image -ceq $State.OriginalCore.Image -and $c.State.Running) 'original_resume_not_verified'
    if($State.GracefulStops.ContainsKey($c.Id)){$State.GracefulStops[$c.Id].ResumedStartedAt=$c.State.StartedAt;SaveState}
}
function StopOwned([string]$Name){if(Exists 'container' $Name){Need ((Container $Name).Config.Labels.'artcraft.release' -ceq $Release) 'stop_resource_owned_elsewhere';Stop $Name -IsWeb:($Name -in @($CanaryWeb,$CompatWeb))}}
function LegacyAudit([string]$Name){
    $values=EnvMap (Container $Name);Need ($values['IMAGE_OUTPUT_DIR'] -eq '/data/generated_images') 'legacy_ledger_location_requires_review'
    return Ledger $Name 'web-jobs'
}
function StopLegacyWeb([string]$Name){
    $c=Container $Name
    $before=if($c.State.Running){LegacyAudit $Name}else{Offline $c.Image $WebVolume 'web-jobs' '/data'}
    $State.LegacyStop=@{ContainerId=$c.Id;Before=$before;Scope='bounded observed idle; shared ledger has no process attribution; not atomic admission'};SaveState
    Idle $before
    SetRestart $Name @{Name='no'};Stop $Name -IsWeb
    $after=Offline $c.Image $WebVolume 'web-jobs' '/data';$State.LegacyStop.After=$after;SaveState
    if($after.active -ne 0 -or !(SameUncertain $before $after)){
        $State.LegacyStop.UncertainInterruption=$true;SaveState
        # Preserve receipt bytes. Restoring a Web process does not resume void Promises.
        OriginalStart $Name $State.OriginalWeb
        Need $false 'legacy_interruption_uncertain_no_paid_replay'
    }
}
function Start([string]$Name){$c=Container $Name;if(!$c.State.Running){BeginOp "start-$Name";$null=Docker @('start',$Name);DoneOp}}
function Rename([string]$From,[string]$To,[string]$Id){
    if(Exists 'container' $To){Need ((Container $To).Id -ceq $Id) 'retained_name_collision';return}
    Need ((Container $From).Id -ceq $Id) 'rename_identity_mismatch';BeginOp "rename-$From";$null=Docker @('rename',$From,$To);DoneOp
}
function Archive([string]$Volume,[string]$Image,[string]$Directory,[string]$File){
    $path=Join-Path $Directory $File
    if(Test-Path -LiteralPath $path){return}
    BeginOp "archive-$Volume"
    $null=Docker @('run','--rm','--network','none','--mount',"type=volume,source=$Volume,target=/source,readonly",'--mount',"type=bind,source=$Directory,target=/backup",'--entrypoint','tar',$Image,'-cf',"/backup/$File.partial",'-C','/source','.')
    [IO.File]::Move("$path.partial",$path);DoneOp
}
function Restore([string]$Volume,[string]$Image,[string]$Directory,[string]$File){
    # Only release-owned copies; never restore to either production volume.
    Need ($Volume -ne $CoreVolume -and $Volume -ne $WebVolume -and $Volume.StartsWith("artcraft-$Release-")) 'restore_target_forbidden'
    Resource 'volume' $Volume
    BeginOp "restore-$Volume"
    $null=Docker @('run','--rm','--user','0','--network','none','--mount',"type=volume,source=$Volume,target=/target",'--mount',"type=bind,source=$Directory,target=/backup,readonly",'--entrypoint','sh',$Image,'-c',"test -z `"`$(ls -A /target)`" && tar -xf /backup/$File -C /target")
    DoneOp
}
function Snapshot([string]$Purpose,[switch]$LeaveStopped){
    AssertOriginal;VerifyOldShutdown;InventorySubmitters;AssertExclusive $CoreVolume @($State.OriginalCore.Id)
    $script:ProductionWitness=Ledger $Core 'witness';$State.PreStopBff=Probe $Web $script:ProductionWitness -Ordinary
    $State.PreStopLedger=Ledger $Core 'audit';Idle $State.PreStopLedger
    $stamp=[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff');$dir=Join-Path $ReleaseRoot "backups\$Purpose-$stamp";PrivateDirectory $dir
    $State.SnapshotInProgress=@{Directory=$dir;Purpose=$Purpose};SaveState;$complete=$false
    try {
        SetRestart $Core @{Name='no'};Stop $Core
        $exit=$State.GracefulStops[$State.OriginalCore.Id];Need ($exit.Status -eq 'normal-exit' -and $exit.ExitCode -eq 0) 'core_normal_exit_required'
        AssertExclusive $CoreVolume @()
        $before=Offline $State.OriginalCore.Image $CoreVolume 'audit'
        $State.ClosedCoreLedger=$before;SaveState
        if($before.active -ne 0){
            $State.QueuedRace=@{At=[DateTime]::UtcNow.ToString('o');Ledger=$before;Action='restart exact original Core; original IDs recover per verified jobs.mjs; no receipt edits or request replay'};SaveState
            ResumeOriginalCore
            Need $false 'closed_core_queued_race_original_resumed_no_promotion'
        }
        if(!(SameUncertain $State.PreStopLedger $before)){
            $State.StopUncertain=@{Before=$State.PreStopLedger['uncertainRecords'];After=$before['uncertainRecords'];Action='preserve new or changed uncertainty; original Core recovery only; no paid replay'};SaveState
            ResumeOriginalCore
            Need $false 'closed_core_new_uncertain_original_resumed_no_promotion'
        }
        Idle $before
        $coreTree=Offline $State.OriginalCore.Image $CoreVolume 'tree'
        Archive $CoreVolume $State.OriginalCore.Image $dir 'image2.tar'
        $cv="artcraft-$Release-$Purpose-$stamp-core"
        Restore $cv $State.OriginalCore.Image $dir 'image2.tar'
        $b=Offline $State.OriginalCore.Image $cv 'tree';Need ($coreTree.sha256 -eq $b.sha256) 'core_restore_tree_mismatch'
        $after=Offline $State.OriginalCore.Image $cv 'audit';EqualAudit $before $after
        $null=Offline $State.NewCore $cv 'writable'
        $receipt=@{Directory=$dir;At=[DateTime]::UtcNow.ToString('o');CoreVolume=$cv;Ledger=$after;CoreSha256=(Hash (Join-Path $dir 'image2.tar'));RestoreVerified=$true;Scope='weiai-image2-data only';GracefulExit=$exit;ShutdownSource=$State.OldShutdownSource;ClosedLedger=$before}
        SaveJson (Join-Path $dir 'receipt.json') $receipt;$State.Backups+=@($receipt);$State.SnapshotInProgress=$null;$complete=$true;SaveState
        return $receipt
    } finally {
        if(!$LeaveStopped -or !$complete){
            AssertExclusive $CoreVolume @($State.OriginalCore.Id)
            # Reconcile a late normal exit without ever auto-starting an abnormal
            # process. Still-closing timeouts remain pending for recovery entry.
            $current=Container $Core
            if(!$current.State.Running){
                ReconcileGracefulStop $Core $State.OriginalCore.Id -WaitSeconds 0
                ResumeOriginalCore
                if(!$complete){$State.InterruptedSnapshot=$State.SnapshotInProgress;$State.SnapshotInProgress=$null;SaveState}
            }
        }
    }
}

function CollectFacts([string]$Name,[string]$Path){
    $null=Exec 'powershell.exe' @('-NoProfile','-NonInteractive','-File',(Join-Path $PolicyDir 'collect-review-facts.ps1'),'-Container',$Name,'-OutFile',$Path)
}
function PolicyValidate([string[]]$Arguments){
    # Python preserves uint64; the policy is mounted/passed as RAW FILE BYTES.
    $null=Docker (@('run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges=true','--cpus','2','--memory','2g','--pids-limit','256','--mount',"type=bind,source=$PolicyDir,target=/policy,readonly",'--mount',"type=bind,source=$ReleaseRoot,target=/release",'--entrypoint','python3',$State.NewCore,'-B','/policy/policy.py')+$Arguments)
}
function ServiceLayout([string]$Image,[string]$Volume,[switch]$Production){
    # Docker Desktop normalizes Windows bind sources. Bind to the inspected
    # expected path via a read-only mount helper, never accept an arbitrary source.
    return @{role=$(if($Production){'production'}else{'canary'});policyMode=$Plan.PolicyMode;imageId=$Image;network=$(if($Production){$Network}else{$CanaryNetwork});dataVolume=$Volume;nativeVolume=$NativeVolume;policySource=$State.PolicyMountSource}
}
function AssertRuntime([string]$Name,[string]$Image,[string]$Volume,[switch]$IsWeb,[switch]$Production,[switch]$InternalWeb){
    $c=Container $Name;Need ($c.Image -ceq $Image -and $c.Config.Labels.'artcraft.release' -ceq $Release) 'candidate_identity_mismatch'
    $user=if($IsWeb){WebUser}else{'node'}
    Need ($c.Config.User -eq $user -and !$c.HostConfig.Privileged -and !$c.HostConfig.CapAdd -and !$c.HostConfig.Devices -and !$c.HostConfig.Sysctls -and $c.HostConfig.NanoCpus -eq 2000000000 -and $c.HostConfig.Memory -eq 2147483648 -and $c.HostConfig.PidsLimit -eq 256) 'runtime_limits_mismatch'
    $net=if($Production){$Network}else{$CanaryNetwork};Need ($c.NetworkSettings.Networks.Keys.Count -eq 1 -and $c.NetworkSettings.Networks.ContainsKey($net)) 'candidate_network_mismatch'
    if(!$Production){Need ((Object 'network' $net).Internal) 'canary_network_not_internal';Need (@($c.Mounts|Where-Object {$_.Name -in @($CoreVolume,$WebVolume)}).Count -eq 0) 'canary_has_production_volume'}
    if(!$IsWeb){
        $stamp=[Guid]::NewGuid().ToString('N');$facts="runtime-$stamp.json";$layout="layout-$stamp.json"
        CollectFacts $Name (Join-Path $ReleaseRoot $facts);SaveJson (Join-Path $ReleaseRoot $layout) (ServiceLayout $Image $Volume -Production:$Production)
        PolicyValidate @('service-check','--facts',"/release/$facts",'--layout',"/release/$layout")
    } else {
        Need (($c.HostConfig.SecurityOpt|ConvertTo-Json -Compress) -ceq ($State.OriginalWeb.SecurityOpt|ConvertTo-Json -Compress) -and ($c.HostConfig.CapDrop|ConvertTo-Json -Compress) -ceq ($State.OriginalWeb.CapDrop|ConvertTo-Json -Compress) -and $c.HostConfig.ReadonlyRootfs -eq $State.OriginalWeb.ReadonlyRootfs) 'web_original_security_profile_drift'
        Need ($c.Mounts.Count -eq 1 -and $c.Mounts[0].Name -eq $Volume -and $c.Mounts[0].Destination -eq '/data' -and $c.Mounts[0].RW) 'web_mount_mismatch'
        if($InternalWeb){Need (!$c.HostConfig.PortBindings -or $c.HostConfig.PortBindings.Count -eq 0) 'internal_web_published_port';return}
        $port=if($Production){'18194'}else{'18199'};$bindings=@($c.HostConfig.PortBindings['18084/tcp']);Need ($bindings.Count -ge 1 -and @($bindings|Where-Object {$_.HostPort -ne $port}).Count -eq 0) 'web_binding_mismatch'
        if(!$Production){Need ($bindings.Count -eq 1 -and $bindings[0].HostIp -eq '127.0.0.1') 'canary_public_binding'}
    }
}
function CreateService([string]$Name,[string]$Image,[string]$Volume,[switch]$IsWeb,[switch]$Production,[switch]$InternalWeb){
    if(Exists 'container' $Name){Need ((Container $Name).Image -ceq $Image -and (Container $Name).Config.Labels.'artcraft.release' -ceq $Release) 'existing_service_mismatch';AssertRuntime $Name $Image $Volume -IsWeb:$IsWeb -Production:$Production -InternalWeb:$InternalWeb;Start $Name;return}
    $net=if($Production){$Network}else{$CanaryNetwork}
    if($Production){$source=if($IsWeb){$OldWeb}else{$OldCore};$values=EnvMap (Container $source)}
    else {$values=@{NODE_ENV='production';HOSTNAME='0.0.0.0';IMAGE2_API_TOKEN=('artcraft-canary-'+$Release+'-synthetic-local-only');STUDIO_VISITOR_SECRET=('artcraft-visitor-'+$Release+'-synthetic-local-only');ARTCRAFT_CANARY='1'}}
    if($IsWeb){$values.PORT='18084';$values.IMAGE2_API_URL='http://image2:18088';$dest='/data'}else{$values.PORT='18088';$values.IMAGE2_DATA_DIR='/data/image2';$values.IMAGE2_CRAFT_BIN_DIR='/opt/artcraft';$dest='/data/image2'}
    $user=if($IsWeb){WebUser}else{'node'}
    $a=@('create','--name',$Name,'--user',$user,'--restart','unless-stopped','--network',$net,'--cpus','2','--memory','2g','--pids-limit','256','--label',"artcraft.release=$Release",'--label',"artcraft.source=$($Plan.SourceArchiveSha256)",'--mount',"type=volume,source=$Volume,target=$dest")
    if(!$IsWeb){
        $a+=@('--network-alias','image2','--read-only','--tmpfs','/tmp:rw,nosuid,nodev,size=1073741824,mode=1777','--cap-drop','ALL','--security-opt','no-new-privileges=true','--mount',"type=volume,source=$NativeVolume,target=/opt/artcraft,readonly",'--mount',"type=bind,source=$PolicyDir,target=/policy,readonly")
        if($Plan.PolicyMode -eq 'candidate'){$a+=@('--security-opt',"seccomp=$PolicyFile")}
    } else {
        foreach($option in $State.OriginalWeb.SecurityOpt){Need ($option -in @('no-new-privileges','no-new-privileges=true')) 'web_custom_policy_requires_review';$a+=@('--security-opt',$option)}
        foreach($cap in $State.OriginalWeb.CapDrop){$a+=@('--cap-drop',$cap)}
        if($State.OriginalWeb.ReadonlyRootfs){$a+='--read-only'}
        if(!$InternalWeb){if($Production){foreach($binding in $State.OriginalWeb.Ports['18084/tcp']){$ip=$binding.HostIp;if($ip -match ':'){$ip="[$ip]"};$a+=@('--publish',"${ip}:18194:18084")}}else{CheckCanaryPort;$a+=@('--publish','127.0.0.1:18199:18084')}}
    }
    foreach($key in $values.Keys){Need ($key -match '^[A-Za-z_][A-Za-z0-9_]*$') 'invalid_env_key';$a+=@('--env',$key)}
    BeginOp "create-$Name";$null=Docker ($a+@($Image)) '' $values;DoneOp
    if($Production){$actual=EnvMap (Container $Name);$prior=EnvMap (Container $source);foreach($key in $prior.Keys){if($key -notin @('IMAGE2_CRAFT_BIN_DIR')){Need ($actual[$key] -ceq $prior[$key]) 'preserved_environment_mismatch'}}}
    AssertRuntime $Name $Image $Volume -IsWeb:$IsWeb -Production:$Production -InternalWeb:$InternalWeb
    Start $Name
}
function Ready([string]$Name,[switch]$IsWeb){
    $port=if($IsWeb){18084}else{18088};$path=if($IsWeb){'/api/v1/health'}else{'/health'}
    $code="const r=await fetch('http://127.0.0.1:$port$path',{signal:AbortSignal.timeout(5000)});if(!r.ok)process.exit(1);console.log('ok');"
    for($i=0;$i -lt 45;$i++){try{if((NodeCode $Name $code) -eq 'ok'){return}}catch{};Start-Sleep -Seconds 2};throw 'health_timeout'
}
function Probe([string]$Name,$Witness,[switch]$Public,[switch]$Ordinary){
    $assets=@();if($Witness['assets']){$assets=@($Witness['assets'])}
    $probeRequest=@{id=$Witness.id;owner=$Witness.owner;native=(!$Ordinary);publicRoutes=[bool]$Public;assets=$assets;requireNativeAssets=($Witness['accepted'] -eq $true)}|ConvertTo-Json -Depth 8 -Compress
    $encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($probeRequest))
    return Map ((NodeCode $Name $BffCode @{ARTCRAFT_PROBE_INPUT=$encoded})|ConvertFrom-Json)
}
function NativeTests([string]$Name,[string]$Label,[switch]$Smoke){
    $path="/tmp/upgrade-$Invocation-$Label";$dir=Join-Path $ReleaseRoot "evidence\$Label-$Invocation";$null=[IO.Directory]::CreateDirectory($dir)
    BeginOp "native-target-tests-$Label"
    try{$args=@('exec',$Name,'node','/app/ops/upgrade-native.mjs',$path);if($Smoke){$args+='smoke'}else{$args+='supplement'};$null=Docker $args}finally{$null=Docker @('cp',"${Name}:$path/.",$dir)}
    $receipt=ReadJson (Join-Path $dir 'receipt.json');Need ($receipt.manifestSha256 -ceq $State.NativeManifestSha256) 'tested_native_manifest_drift';Need ($receipt.passed -eq $true -and $receipt.sandbox.capabilitiesZero -eq $true) 'native_gate_failed'
    if($Smoke){Need ($receipt.bwrapSha256 -ceq $State.PolicyCanary.BwrapSha256) 'production_bwrap_drift'}
    DoneOp;return @{Directory=$dir;ReceiptSha256=(Hash (Join-Path $dir 'receipt.json'));Passed=$true}
}
function CheckCanaryPort {
    $own=$null;if(Exists 'container' $CanaryWeb){$own=Container $CanaryWeb;Need ($own.Config.Labels.'artcraft.release' -ceq $Release) 'canary_name_owned_elsewhere'}
    # Inspect ALL bindings, including stopped containers that could reserve/reclaim it.
    foreach($id in ((Docker @('ps','-aq')) -split '\r?\n')){if(!$id){continue};$c=Container $id;if(!$c.HostConfig.PortBindings){continue}
        foreach($port in @($c.HostConfig.PortBindings.Keys)){foreach($b in $c.HostConfig.PortBindings[$port]){if($b.HostPort -eq '18199'){Need ($own -and $c.Id -ceq $own.Id -and $b.HostIp -eq '127.0.0.1') 'docker_18199_in_use'}}}
    }
    $listeners=@(Get-NetTCPConnection -State Listen -LocalPort 18199 -ErrorAction SilentlyContinue)
    Need ($listeners.Count -eq 0 -or ($own -and $own.State.Running -and @($listeners|Where-Object {$_.LocalAddress -ne '127.0.0.1'}).Count -eq 0)) 'windows_18199_in_use'
}
function InspectStage {
    $w=Container $Web;$c=Container $Core;AssertLayout $w $WebVolume '/data' -IsWeb;AssertLayout $c $CoreVolume '/data/image2'
    Need ($w.State.Running -and $c.State.Running) 'existing_pair_not_running'
    Need ((Docker @('info','--format','{{.OSType}}')) -eq 'linux') 'linux_engine_required'
    $State.OriginalWeb=Safe $w;$State.OriginalCore=Safe $c
    $State.OriginalImages=@();foreach($id in @($w.Image,$c.Image)){$im=Object 'image' $id;$State.OriginalImages+=@(@{Id=$im.Id;RepoTags=$im.RepoTags;RepoDigests=$im.RepoDigests;Created=$im.Created;Os=$im.Os;Architecture=$im.Architecture})}
    $State.WindowsFreeBytes=([IO.DriveInfo]::new('C:\')).AvailableFreeSpace
    $State.DockerStorage=Map ((NodeCode $Core "import fs from 'node:fs';const s=fs.statfsSync('/data/image2');console.log(JSON.stringify({availableBytes:s.bavail*s.bsize,totalBytes:s.blocks*s.bsize}));")|ConvertFrom-Json)
    $State.OriginalBuildId=NodeCode $Web "import fs from 'node:fs';console.log(fs.readFileSync('/app/.next/BUILD_ID','utf8').trim());"
    AssertOriginal;$State.InspectedLedger=Ledger $Core 'audit';$witness=Ledger $Core 'witness';$State.OriginalBff=Probe $Web $witness -Ordinary
    # Discovery snapshot is a comparison baseline only, never proof of current identity.
    $State.DiscoveryMatches=($Plan.ExpectedOldCoreImage -ceq $c.Image -and $Plan.ExpectedOldWebImage -ceq $w.Image -and $Plan.ExpectedOldCoreId -ceq $c.Id -and $Plan.ExpectedOldWebId -ceq $w.Id)
    Need $State.DiscoveryMatches 'discovery_image_drift';$State.Inspected=$true;SaveState;CheckCanaryPort
}
function CheckInputs {
    Need ((Hash $Plan.SourceArchive) -ceq $Plan.SourceArchiveSha256) 'source_archive_digest_mismatch'
    Need ((Get-Item -LiteralPath $Plan.NativeArchive).Length -eq 512742646 -and (Hash $Plan.NativeArchive) -ceq '2b3f7753d2a6eb4d0b80d2eb1bb105fd53c1862b6bdfcdacee31c7aa8b9a1a36') 'native_archive_digest_mismatch'
}
function Extract([string]$Archive,[string]$Directory){
    if(Test-Path -LiteralPath $Directory){return}
    $names=(Exec 'tar' @('-tzf',$Archive)) -split '\r?\n'
    foreach($n in $names){Need ($n -and !$n.StartsWith('/') -and $n -notmatch '(^|/)\.\.(/|$)|\\|:') 'unsafe_archive_path'}
    $staging="$Directory.partial-$Invocation";$null=[IO.Directory]::CreateDirectory($staging)
    $null=Exec 'tar' @('-xzf',$Archive,'-C',$staging);[IO.Directory]::Move($staging,$Directory)
}
function CheckSource {
    Need ((Hash (Join-Path $Source 'UPGRADE-SOURCE.json')) -ceq $Plan.SourceManifestSha256) 'source_manifest_digest_mismatch'
    $metadata=ReadJson (Join-Path $Source 'UPGRADE-SOURCE.json');Need ($metadata.head -ceq $Plan.SourceCommit) 'source_commit_mismatch'
    foreach($file in $metadata.files.Keys){Need ($file -notmatch '(^|/)\.\.(/|$)|\\|:|^/') 'unsafe_source_manifest';Need ((Hash (Join-Path $Source $file)) -ceq $metadata.files[$file]) 'frozen_source_modified'}
    $files=@(Get-ChildItem -LiteralPath $Source -Recurse -File -Force);Need ($files.Count -eq $metadata.files.Count+1) 'unexpected_source_files'
    Need (@(Get-ChildItem -LiteralPath $Source -Recurse -Force | Where-Object {$_.Attributes -band [IO.FileAttributes]::ReparsePoint}).Count -eq 0) 'source_reparse_point'
    $State.SourceManifestSha256=Hash (Join-Path $Source 'UPGRADE-SOURCE.json')
}
function CheckNativeBundle {Need ((Hash (Join-Path $NativeBin 'manifest.json')) -ceq '8e050bb717ab92246fec121a4e8bff45e328c1b9ff0994b015fc99c2dcc45509') 'native_manifest_digest_mismatch';$State.NativeManifestSha256='8e050bb717ab92246fec121a4e8bff45e328c1b9ff0994b015fc99c2dcc45509'}
function BuildImage([string]$Name,[string]$File,[string]$Context,[string[]]$Extra=@()){
    $tag="artcraft-$Release-$Name`:frozen"
    $ids=Docker @('image','ls','-q',$tag)
    if(!$ids){BeginOp "build-$Name";$null=Docker (@('build','--label',"artcraft.release=$Release",'--label',"artcraft.source=$($Plan.SourceArchiveSha256)",'--label',"org.opencontainers.image.revision=$($Plan.SourceCommit)",'--label',"artcraft.source-manifest=$($State.SourceManifestSha256)",'-t',$tag,'-f',$File)+$Extra+@($Context));DoneOp}
    $image=Object 'image' $tag;Need ($image.Config.Labels.'artcraft.source' -ceq $Plan.SourceArchiveSha256 -and $image.Config.Labels.'artcraft.release' -ceq $Release) 'image_provenance_mismatch'
    return $image.Id
}
function VerifyNativeVolume {
    $proof=Map ((Docker @('run','--rm','--user','node','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges=true','--cpus','2','--memory','2g','--pids-limit','256','--mount',"type=volume,source=$NativeVolume,target=/opt/artcraft,readonly",'--entrypoint','node',$State.NewCore,'/app/ops/upgrade-bundle.mjs'))|ConvertFrom-Json)
    Need ($proof.passed -and $proof.binaries.Count -eq 13 -and $proof.root -ceq '/opt/artcraft') 'native_final_root_not_verified'
    $State.NativeVolumeProof=$proof;SaveState
}
function InitializeNativePolicy {
    Resource 'volume' $NativeVolume
    if(!$State.NativeHydrated){
        BeginOp 'hydrate-native-volume'
        $parent=Split-Path $Plan.NativeArchive;$leaf=Split-Path $Plan.NativeArchive -Leaf
        Need ($leaf -match '^[a-zA-Z0-9_.-]+$') 'native_archive_filename'
        $null=Docker @('run','--rm','--user','0','--network','none','--mount',"type=volume,source=$NativeVolume,target=/native",'--mount',"type=bind,source=$parent,target=/input,readonly",'--entrypoint','sh',$State.NewCore,'-c',"test -z `"`$(ls -A /native)`" && tar -xzf /input/$leaf -C /native --strip-components=2 ./bin")
        $State.NativeTarVersion=Docker @('run','--rm','--network','none','--entrypoint','tar',$State.NewCore,'--version')
        Need ($State.NativeTarVersion -match 'GNU tar') 'native_gnu_tar_required'
        VerifyNativeVolume
        $State.NativeHydrated=$true;DoneOp
    } else {VerifyNativeVolume}
    # Resolve only our requested Windows bind; this helper has no data volume access.
    $helper="artcraft-$Release-mount-source"
    if(!(Exists 'container' $helper)){$null=Docker @('create','--name',$helper,'--network','none','--label',"artcraft.release=$Release",'--mount',"type=bind,source=$PolicyDir,target=/policy,readonly",'--entrypoint','true',$State.NewCore)}
    $h=Container $helper;Need ($h.Image -ceq $State.NewCore -and $h.Config.Labels.'artcraft.release' -ceq $Release) 'policy_helper_identity'
    $State.PolicyMountSource=(@($h.Mounts|Where-Object {$_.Destination -eq '/policy' -and !$_.RW}))[0].Source
    $before="policy-before-$Invocation.json";CollectFacts $Core (Join-Path $ReleaseRoot $before)
    PolicyValidate @('preflight','--facts',"/release/$before")
    $State.PolicyBeforeFile=$before;SaveState
}
function PolicyProof([string]$Name,[switch]$Control){
    $label=if($Control){'builtin-control'}else{'policy'};$relative="evidence/$label-$Invocation";$dir=Join-Path $ReleaseRoot $relative
    $null=[IO.Directory]::CreateDirectory($dir);$out="/data/image2/upgrade-evidence/$label-$Invocation"
    $mode=if($Control){'builtin'}else{$Plan.PolicyMode};$expected=if($mode -eq 'builtin'){'builtin'}else{$Plan.PolicySha256}
    $failed=$false;$invoke=$null
    try {
        $raw=Exec 'docker' @('exec',$Name,'node','/policy/target-probe.mjs','--run-reviewed-target','--mode',$mode,'--expected-policy-sha256',$expected,'--service-dir','/app','--output-dir',$out) '' @{} @(0,1)
        $invoke=Map ($raw|ConvertFrom-Json)
        SaveJson (Join-Path $dir 'invocation.json') $invoke
        $failed=($invoke.status -ne 'passed')
        if($invoke.evidence -ceq "$out/target.json"){$null=Docker @('cp',"${Name}:$out/.",$dir)}
        else {SaveJson (Join-Path $dir 'setup-failure.json') @{Status='failed';Stage='evidence-setup';Invocation=$invoke;Container=$Name;Output=$out};Need $false 'policy_probe_setup_failed'}
    } catch {
        if(!(Test-Path -LiteralPath (Join-Path $dir 'target.json'))){
            if(!(Test-Path -LiteralPath (Join-Path $dir 'setup-failure.json'))){SaveJson (Join-Path $dir 'setup-failure.json') @{Status='failed';Stage='probe-invocation-or-setup';Code=$script:Failure;Container=$Name;Output=$out}}
            throw
        };$failed=$true
    }
    CollectFacts $Name (Join-Path $dir 'after.json')
    $result=ReadJson (Join-Path $dir 'target.json')
    if($Control){return @{Directory=$dir;ReceiptSha256=(Hash (Join-Path $dir 'target.json'));Image=$State.NewCore;Passed=(!$failed -and $result.status -eq 'passed')}}
    Need (!$failed -and $result.status -eq 'passed') 'target_policy_probe_failed'
    $layout=ServiceLayout $State.NewCore $State.PreparedBackup.CoreVolume;SaveJson (Join-Path $dir 'layout.json') $layout
    PolicyValidate @('bind-service','--before',"/release/$($State.PolicyBeforeFile)",'--after',"/release/$relative/after.json",'--result',"/release/$relative/target.json",'--layout',"/release/$relative/layout.json",'--out',"/release/$relative/bound.json")
    return @{Directory=$dir;ReceiptSha256=(Hash (Join-Path $dir 'bound.json'));BwrapSha256=$result.bwrap.sha256;Passed=$true}
}
function CandidateTrialGate {
    if($Plan.PolicyMode -eq 'builtin'){return}
    if(!$State.BuiltinControl){
        $volume="artcraft-$Release-builtin-control";$name="artcraft-$Release-builtin-control";Resource 'volume' $volume
        $saved=$Plan.PolicyMode
        try{$Plan.PolicyMode='builtin';CreateService $name $State.NewCore $volume;AssertRuntime $name $State.NewCore $volume;Ready $name;$State.BuiltinControl=PolicyProof $name -Control;SaveState}finally{$Plan.PolicyMode=$saved;StopOwned $name}
    }
    Need (!$State.BuiltinControl.Passed) 'builtin_passed_use_builtin_reviewed_plan'
    Need $Request.GateReceipt 'candidate_trial_review_required'
    $g=ReadJson $Request.GateReceipt
    Need ($g.ReleaseId -ceq $Release -and $g.NewCoreImage -ceq $State.NewCore -and $g.PolicySha256 -ceq $Plan.PolicySha256 -and $g.ControlReceiptSha256 -ceq $State.BuiltinControl.ReceiptSha256) 'candidate_trial_wrong_binding'
    Need ((Hash (Join-Path $State.BuiltinControl.Directory 'target.json')) -ceq $g.ControlReceiptSha256) 'builtin_control_evidence_changed'
    foreach($flag in @('CandidateTrialApproved','PolicyFailureCauseReviewed','BwrapPackageSourceReviewed')){Need ($g[$flag] -is [bool] -and $g[$flag]) 'candidate_trial_not_reviewed'}
    Need ($g.Reviewer -and $g.ApprovalReference) 'candidate_trial_review_missing'
}
function ReadbackStage {
    Need $State.EntryReady 'cutover_entry_not_ready'
    AssertRuntime $Core $State.NewCore $CoreVolume -Production;AssertRuntime $Web $State.NewWeb $WebVolume -IsWeb -Production
    # Core startup already reopened every retained frontend. Read-only failure
    # preserves the running new Core and all accepted jobs; no external reopen stage.
    $State.PublicReadback=Probe $Web (Ledger $Core 'witness') -Public
    $State.CutoverComplete=$true;SaveState
}

function PrepareStage {
    Need $State.Inspected 'inspect_required';AssertOriginal;InventorySubmitters;CheckCanaryPort;AssertExclusive $CoreVolume @($State.OriginalCore.Id);CheckInputs
    Extract $Plan.SourceArchive $Source;CheckSource;Extract $Plan.NativeArchive (Join-Path $ReleaseRoot 'native')
    CheckNativeBundle
    $State.NewBase=BuildImage 'base' (Join-Path $Source 'services\image2\Dockerfile') (Join-Path $Source 'services\image2');SaveState
    $State.NewCore=BuildImage 'native' (Join-Path $Source 'services\image2\Dockerfile.native') (Join-Path $Source 'services\image2') @('--build-arg',"IMAGE2_BASE_IMAGE=artcraft-$Release-base`:frozen");SaveState
    $State.NewWeb=BuildImage 'web' (Join-Path $Source 'Dockerfile') $Source;SaveState
    InitializeNativePolicy
    if(!$State.PreparedBackup){$State.PreparedBackup=Snapshot 'prepare';SaveState}
    $State.Prepared=$true;SaveState
}
function CanaryStage {
    Need $State.Prepared 'prepare_required';AssertOriginal;CheckSource;CheckNativeBundle;StopOwned $CompatWeb
    AssertExclusive $NativeVolume @();Resource 'network' $CanaryNetwork;CandidateTrialGate
    $cv=$State.PreparedBackup.CoreVolume;$wv=$CanaryWebVolume;Resource 'volume' $wv
    CreateService $CanaryCore $State.NewCore $cv;CreateService $CanaryWeb $State.NewWeb $wv -IsWeb
    AssertRuntime $CanaryCore $State.NewCore $cv;AssertRuntime $CanaryWeb $State.NewWeb $wv -IsWeb
    foreach($name in @($CanaryCore,$CanaryWeb)){foreach($p in (EnvMap (Container $name)).GetEnumerator()){if($p.Key -match '^(IMAGE_OPENAI_|OPENAI_|AGENT_LLM_|GPU_COMFY_|IMAGE2_OCR_)'){Need (!$p.Value) 'canary_provider_configured'}}}
    Ready $CanaryCore;Ready $CanaryWeb -IsWeb
    $State.CanaryBuildId=NodeCode $CanaryWeb "import fs from 'node:fs';console.log(fs.readFileSync('/app/.next/BUILD_ID','utf8').trim());"
    $State.PolicyCanary=PolicyProof $CanaryCore
    SaveState;$State.NativeCanary=NativeTests $CanaryCore 'canary';SaveState
    $witness=Map ((Docker @('exec',$CanaryCore,'node','/app/ops/upgrade-seed.mjs'))|ConvertFrom-Json)
    $State.CanaryBff=Probe $CanaryWeb $witness
    # Freeze the canary and copy its new-format DB including a real accepted native checkpoint.
    Stop $CanaryWeb -IsWeb;Idle (Ledger $CanaryCore 'audit');Stop $CanaryCore
    $dir=Join-Path $ReleaseRoot "backups\compat-$Invocation";PrivateDirectory $dir
    Archive $cv $State.NewCore $dir 'new-format.tar'
    $copy="artcraft-$Release-compat-$Invocation";Restore $copy $State.NewCore $dir 'new-format.tar'
    $before=Offline $State.NewCore $copy 'audit';Need ($before.fingerprints.craft_revisions.count -gt 1 -and $before.fingerprints.craft_receipts.count -gt 0) 'native_witness_missing'
    $old=Offline $State.OriginalCore.Image $copy 'old-read';EqualAudit $before $old
    $new=Offline $State.NewCore $copy 'new-read';EqualAudit $before $new
    $State.Compatibility=@{OldCoreImage=$State.OriginalCore.Image;CopyVolume=$copy;OldStoreReadback=$true;NewReopenPreserved=$true;FullOldFeatures=$false;Audit=$new};SaveState
    Start $CanaryCore
    # The safer post-acceptance rollback keeps the new core with the old Web.
    CreateService $CompatWeb $State.OriginalWeb.Image $wv -IsWeb -InternalWeb
    Ready $CompatWeb -IsWeb;$State.OldWebNewCore=Probe $CompatWeb $witness;Stop $CompatWeb -IsWeb
    Start $CanaryWeb;Ready $CanaryWeb -IsWeb;$State.CanaryReopenBff=Probe $CanaryWeb $witness;$State.CanaryPassed=$true;SaveState
}
function Gate {
    Need $State.CanaryPassed 'canary_required';Need ((Hash (Join-Path $State.NativeCanary.Directory 'receipt.json')) -ceq $State.NativeCanary.ReceiptSha256) 'native_evidence_changed';Need $Request.GateReceipt 'review_gate_required'
    Need ((Hash $Request.GateReceipt) -ceq $Request.GateSha256) 'approval_receipt_changed'
    $g=ReadJson $Request.GateReceipt
    Need ($g.ReleaseId -ceq $Release -and $g.PlanSha256 -ceq $State.PlanSha256 -and $g.NewCoreImage -ceq $State.NewCore -and $g.NewWebImage -ceq $State.NewWeb -and $g.CanaryBuildId -ceq $State.CanaryBuildId -and $g.NativeReceiptSha256 -ceq $State.NativeCanary.ReceiptSha256) 'review_gate_wrong_release'
    foreach($flag in @('OriginalHomepagePassed','CanaryEvidenceReviewed','CompatibilityLimitationsAccepted','TargetPolicyEvidenceReviewed','CutoverApproved')){Need ($g[$flag] -is [bool] -and $g[$flag]) 'supervisor_gate_not_passed'}
    Need ($g.Reviewer -and $g.OriginalHomepageEvidence -and $g.ApprovalReference) 'review_evidence_required'
    Need ($g.PolicyReceiptSha256 -ceq $State.PolicyCanary.ReceiptSha256 -and $g.PolicyMode -ceq $Plan.PolicyMode -and $g.PolicySha256 -ceq $Plan.PolicySha256 -and $g.BwrapSha256 -ceq $State.PolicyCanary.BwrapSha256) 'review_policy_binding_mismatch'
    Need ((Hash (Join-Path $State.PolicyCanary.Directory 'bound.json')) -ceq $State.PolicyCanary.ReceiptSha256) 'policy_evidence_changed'
    $State.ReviewGateSha256=Hash $Request.GateReceipt;SaveState
}
function RetainCandidate([string]$Name,[string]$Image,[string]$Suffix){
    if(Exists 'container' $Name){$c=Container $Name;Need ($c.Image -ceq $Image -and $c.Config.Labels.'artcraft.release' -ceq $Release) 'rollback_superseded';SetRestart $Name @{Name='no'};Stop $Name -IsWeb:($Name -eq $Web);Rename $Name "$Name-$Suffix-$Release-$Invocation" $c.Id}
}
function RestoredWebCheck($Witness,[switch]$Ordinary){
    try {Ready $Web -IsWeb;return Probe $Web $Witness -Ordinary:$Ordinary}
    catch {throw} # Keep a healthy restored entry running; readback failure is evidence, not permission to discard work.
}
function RestorePair {
    # Once a new Core exists, even a start-command timeout may have opened ingress.
    # Always preserve it and its volume. Never stop an active new worker to compare
    # against a snapshot, and never run the old worker against its newer ledger.
    $State.RecoveryInProgress=$true;SaveState
    $newCore=(Exists 'container' $Core) -and (Container $Core).Id -ne $State.OriginalCore.Id
    if($newCore){
        $c=Container $Core;Need ($c.Image -ceq $State.NewCore -and $c.Config.Labels.'artcraft.release' -ceq $Release) 'rollback_superseded'
        Need $State.OldWebNewCore.passed 'hybrid_rollback_not_verified'
        AssertExclusive $CoreVolume @($c.Id)
        # Existing restart/recovery contract preserves original accepted IDs and
        # refuses uncertain submissions. A live Core is never stopped here.
        Start $Core;Ready $Core
    }
    if(Exists 'container' $Web){
        $w=Container $Web;Need ($w.Id -ceq $State.OriginalWeb.Id -or ($w.Image -ceq $State.NewWeb -and $w.Config.Labels.'artcraft.release' -ceq $Release)) 'rollback_superseded'
        if($w.Id -ne $State.OriginalWeb.Id){
            $legacy=if($w.State.Running){LegacyAudit $Web}else{Offline $w.Image $WebVolume 'web-jobs' '/data'};Idle $legacy
            RetainCandidate $Web $State.NewWeb 'failed'
            $after=Offline $w.Image $WebVolume 'web-jobs' '/data';$State.RollbackLegacyAfter=$after
            if($after.active -ne 0 -or !(SameUncertain $legacy $after)){$State.LegacyInterruptionUncertain=$true;SaveState}
        }
    }
    if(!$newCore){
        if(Exists 'container' $OldCore){Rename $OldCore $Core $State.OriginalCore.Id}
        Need ((Container $Core).Id -ceq $State.OriginalCore.Id) 'old_core_missing'
        AssertExclusive $CoreVolume @($State.OriginalCore.Id)
        # An original that is still closing has no valid recovery receipt yet.
        ResumeOriginalCore
    }
    if(Exists 'container' $OldWeb){Rename $OldWeb $Web $State.OriginalWeb.Id}
    Need ((Container $Web).Id -ceq $State.OriginalWeb.Id) 'old_web_missing';OriginalStart $Web $State.OriginalWeb
    $State.RollbackReadback=RestoredWebCheck (Ledger $Core 'witness') -Ordinary:(!$newCore)
    $State.RollbackMode=if($newCore){'old-web-new-core'}else{'old-pair-no-new-worker'}
    $State.RolledBack=$true;$State.RecoveryInProgress=$false;SaveState
}
function CutoverStage {
    Gate;CheckInputs;CheckSource;CheckNativeBundle;VerifyNativeVolume;AssertExclusive $NativeVolume @()
    Need (!$State.RolledBack) 'rolled_back_release_requires_new_release'
    if($State.CutoverComplete -or $State.EntryReady){AssertRuntime $Core $State.NewCore $CoreVolume -Production;AssertRuntime $Web $State.NewWeb $WebVolume -IsWeb -Production;return}
    if($State.CutoverStarted){RestorePair;throw 'interrupted_cutover_recovered_review_before_new_release'}
    AssertOriginal;AssertRuntime $CanaryCore $State.NewCore $State.PreparedBackup.CoreVolume;AssertRuntime $CanaryWeb $State.NewWeb $CanaryWebVolume -IsWeb
    InventorySubmitters
    $State.CutoverStarted=$true;SaveState
    try {
        # Fresh, stopped-WAL+assets snapshot immediately before migration. Prepare's is insufficient.
        $State.LegacyBeforeCutover=LegacyAudit $Web;Idle $State.LegacyBeforeCutover;SaveState
        $State.FreshBackup=Snapshot 'cutover' -LeaveStopped;SaveState
        StopLegacyWeb $Web
        Rename $Web $OldWeb $State.OriginalWeb.Id;Rename $Core $OldCore $State.OriginalCore.Id
        AssertExclusive $CoreVolume @()
        $State.CoreEntryMayReopenAt=[DateTime]::UtcNow.ToString('o');SaveState
        CreateService $Core $State.NewCore $CoreVolume -Production;AssertRuntime $Core $State.NewCore $CoreVolume -Production;Ready $Core
        # Same image/mount/limits/policy on the actual final worker; scratch DB only.
        $State.NativeProductionSmoke=NativeTests $Core 'final-smoke' -Smoke;SaveState
        CreateService $Web $State.NewWeb $WebVolume -IsWeb -Production;AssertRuntime $Web $State.NewWeb $WebVolume -IsWeb -Production;Ready $Web -IsWeb
        $build=NodeCode $Web "import fs from 'node:fs';console.log(fs.readFileSync('/app/.next/BUILD_ID','utf8').trim());";Need ($build -ceq $State.CanaryBuildId) 'web_build_id_mismatch'
        $State.LocalReadback=Probe $Web $script:ProductionWitness;SaveState
        $State.EntryReady=$true;SaveState
    } catch { $State.CutoverFailure=@{Step=$script:Step;At=[DateTime]::UtcNow.ToString('o')};SaveState;RestorePair;throw 'cutover_failed_recovery_receipt_retained' }
}
try {
    $Request=ReadJson $RequestFile;$Invocation=$Request.InvocationId
    Need ($Invocation -match '^[a-zA-Z0-9-]{8,64}$') 'invalid_invocation'
    Need ($Request.Phase -in @('Inspect','Prepare','Canary','Cutover','Rollback','Readback')) 'invalid_phase'
    Need ((Hash $Request.PlanPath) -ceq $Request.PlanSha256) 'plan_changed';$Plan=ReadJson $Request.PlanPath;$Release=$Plan.ReleaseId
    Need ($Release -match '^[a-z0-9][a-z0-9-]{3,36}$' -and $Plan.SourceCommit -match '^[a-f0-9]{40}$' -and $Plan.SourceArchiveSha256 -match '^[a-f0-9]{64}$' -and $Plan.SourceManifestSha256 -match '^[a-f0-9]{64}$') 'invalid_plan'
    Need ($env:USERNAME -ieq 'qrrwi' -and $env:COMPUTERNAME -ieq 'AI') 'wrong_target_host'
    Need (!$env:SSH_CONNECTION -and !$env:SSH_CLIENT) 'scheduled_task_required'
    Need ($Plan.PolicyMode -in @('builtin','candidate') -and $Plan.PolicySha256 -ceq $(if($Plan.PolicyMode -eq 'builtin'){'builtin'}else{'54445b51b34a5884dba65c7875995a0991402c5d46ca66df404690f968fb2ac4'})) 'invalid_policy_plan'
    VerifyQueuedBytes $PSCommandPath (Join-Path $PSScriptRoot '..\..\services\image2\ops\upgrade-ledger.mjs') (Join-Path $PSScriptRoot 'bff-probe.mjs')
    $ReleaseRoot=Join-Path $Root "releases\artcraft-$Release";PrivateDirectory $ReleaseRoot
    $StatePath=Join-Path $ReleaseRoot 'state.json';$CompletionPath=Join-Path $ReleaseRoot "completion-$Invocation.json"
    $Source=Join-Path $ReleaseRoot 'source';$NativeBin=Join-Path $ReleaseRoot 'native\bin'
    $PolicyDir=Join-Path $Request.BootstrapRoot 'scripts\artcraft-sandbox-policy';$PolicyFile=Join-Path $PolicyDir 'docker-29.4.1-bwrap.json'
    $NativeVolume="artcraft-$Release-nativebin";$CanaryWebVolume="artcraft-$Release-web-empty"

    $CanaryNetwork="artcraft-$Release-canary";$CanaryCore="artcraft-$Release-core";$CanaryWeb="artcraft-$Release-web";$CompatWeb="artcraft-$Release-oldweb"
    $OldCore="$Core-pre-artcraft-$Release";$OldWeb="$Web-pre-artcraft-$Release"
    $LedgerCode=[IO.File]::ReadAllText((Join-Path $PSScriptRoot '..\..\services\image2\ops\upgrade-ledger.mjs'))
    $BffCode=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'bff-probe.mjs'))
    $script:Lock=[IO.File]::Open((Join-Path $Root 'artcraft-upgrade.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    if(Test-Path -LiteralPath $StatePath){$script:State=ReadJson $StatePath;Need ($State.PlanSha256 -ceq $Request.PlanSha256) 'immutable_plan_changed'}
    else {$script:State=@{Version=1;ReleaseId=$Release;PlanSha256=$Request.PlanSha256;SourceCommit=$Plan.SourceCommit;SourceArchiveSha256=$Plan.SourceArchiveSha256;NativeArchiveSha256='2b3f7753d2a6eb4d0b80d2eb1bb105fd53c1862b6bdfcdacee31c7aa8b9a1a36';NativeArchiveBytes=512742646;Inspected=$false;Prepared=$false;PreparedBackup=$null;CanaryPassed=$false;CutoverStarted=$false;CutoverComplete=$false;RolledBack=$false;Backups=@();PendingOperation=$null;SnapshotInProgress=$null;FreshBackup=$null;RecoveryInProgress=$false;NativeHydrated=$false;BuiltinControl=$null;EntryReady=$false;GracefulStops=@{}}}
    # A completed invocation is immutable. Status never infers success from Scheduled Task Ready.
    Need (!(Test-Path -LiteralPath $CompletionPath)) 'invocation_already_completed'
    if($State.SnapshotInProgress){
        # Only originals may resume after a crashed backup; no blind candidate start.
        Need (!$State.CutoverStarted -or $Request.Phase -eq 'Rollback' -or $Request.Phase -eq 'Cutover') 'rollback_required_after_interrupted_cutover'
        if(!$State.CutoverStarted){Need ((Container $Web).Id -ceq $State.OriginalWeb.Id -and (Container $Core).Id -ceq $State.OriginalCore.Id) 'backup_recovery_identity';AssertExclusive $CoreVolume @($State.OriginalCore.Id);ResumeOriginalCore;$State.SnapshotInProgress=$null;SaveState;Need $false 'interrupted_backup_original_resumed_review_required'}
    }
    switch($Request.Phase){Inspect{InspectStage};Prepare{PrepareStage};Canary{CanaryStage};Cutover{CutoverStage};Rollback{Need $State.CutoverStarted 'no_cutover_to_rollback';RestorePair};Readback{ReadbackStage}}
    $script:ExitCode=0
} catch {
    # Never print ErrorRecord/command output/Config.Env, even during partial failure.
    if($script:State){$State.LastFailure=@{Step=$script:Step;At=[DateTime]::UtcNow.ToString('o');Line=$_.InvocationInfo.ScriptLineNumber;Code=$script:Failure};try{SaveState}catch{}}
} finally {
    if($script:Lock){$script:Lock.Dispose()}
    if(Get-Variable CompletionPath -ErrorAction SilentlyContinue){
        $completion=@{InvocationId=$Invocation;Phase=$Request.Phase;ReleaseId=$Release;ExitCode=$script:ExitCode;Step=$script:Step;Code=$script:Failure;CompletedAt=[DateTime]::UtcNow.ToString('o');StatePath=$StatePath}
        if(Test-Path -LiteralPath $StatePath){$completion.StateSha256=Hash $StatePath}
        try{if(!(Test-Path -LiteralPath $CompletionPath)){SaveJson $CompletionPath $completion};$completion|ConvertTo-Json -Compress}catch{$script:ExitCode=1}
    }
}
exit $script:ExitCode
