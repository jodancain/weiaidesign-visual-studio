import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const scriptPath=fileURLToPath(new URL('../scripts/deploy-image2-b.ps1',import.meta.url));
const script=readFileSync(scriptPath,'utf8');
const readme=readFileSync(new URL('../scripts/DEPLOY-IMAGE2-B.md',import.meta.url),'utf8');

/** Lexical sanity only. This deliberately does not claim to parse the PowerShell grammar. */
function maskLiterals(input:string):string {
  const chars=[...input];let i=0;
  const blank=(from:number,to:number)=>{for(let n=from;n<to;n++)if(chars[n]!=='\n'&&chars[n]!=='\r')chars[n]=' ';};
  while(i<input.length){
    if(input[i]==='#'){const end=input.indexOf('\n',i);blank(i,end<0?input.length:end);i=end<0?input.length:end;continue;}
    if(input[i]==='@'&&(input[i+1]==="'"||input[i+1]==='"')&&/^\s*$/.test(input.slice(i+2,input.indexOf('\n',i)))){
      const quote=input[i+1],start=i;const rest=input.slice(i+2),match=new RegExp(`^${quote}@\\r?$`,'m').exec(rest);assert.ok(match,'unterminated here-string');i=i+2+match.index+match[0].length;blank(start,i);continue;
    }
    if(input[i]==="'"||input[i]==='"'){
      const quote=input[i],start=i++;let closed=false;
      while(i<input.length){if(quote==='"'&&input[i]==='`'){i+=2;continue;}if(input[i]===quote){if(quote==="'"&&input[i+1]==="'"){i+=2;continue;}i++;closed=true;break;}i++;}
      assert.ok(closed,'unterminated quoted string');blank(start,i);continue;
    }
    i++;
  }
  return chars.join('');
}
const masked=maskLiterals(script);
function body(name:string):string {
  const start=masked.indexOf(`function ${name}`);assert.ok(start>=0,`missing ${name}`);const open=masked.indexOf('{',start);let depth=1,index=open+1;
  for(;index<masked.length&&depth;index++){if(masked[index]==='{')depth++;else if(masked[index]==='}')depth--;}
  assert.equal(depth,0,`unbalanced function ${name}`);return script.slice(open+1,index-1);
}

test('deployment source has balanced lexical delimiters and the requested phases, without a frozen code SHA',()=>{
  const stack:string[]=[];const pairs:Record<string,string>={')':'(',']':'[','}':'{'};
  for(const c of masked){if('([{'.includes(c))stack.push(c);else if(')]}'.includes(c))assert.equal(stack.pop(),pairs[c]);}assert.deepEqual(stack,[]);
  for(const p of ['ReleaseId','SourceArchive','ExpectedSha','Phase'])assert.match(script,new RegExp(`\\[Parameter\\(Mandatory = \\$true\\)\\][^\\n]*\\$${p}`));
  assert.match(script,/ValidateSet\('Prepare','Canary','Cutover','Rollback'\)/);assert.doesNotMatch(script,/sha256:[a-f0-9]{64}|\b[0-9a-f]{64}\b/);
});
test('Cutover gate is checked before dry-run, host/config reads and phase mutations and binds exact booleans/source/images',()=>{
  const gateAt=script.indexOf("if ($Phase -eq 'Cutover') { $gate = Assert-GateFlags }"),dryAt=script.indexOf('if ($DryRun)'),hostAt=script.lastIndexOf("$script:Step='host-identity'");assert.ok(gateAt>0&&gateAt<dryAt&&dryAt<hostAt);
  const gate=body('Assert-GateFlags');assert.match(gate,/GateBPassed','OriginalPagePassed','CanaryPassed/);assert.match(body('Require-True'),/-is \[bool\]/);assert.match(gate,/ReleaseId.*-ceq \$ReleaseId/);assert.match(gate,/SourceSha256.*-ceq \$ExpectedSha/);assert.match(gate,/GenerationCalls','LlmCalls','VisionCalls/);
  const cut=body('Cutover-Release');assert.match(cut,/RestoreVerified/);assert.match(cut,/CanaryRuntimeReady/);for(const field of ['WebImageId','CoreImageId','CanaryBuildId'])assert.match(cut,new RegExp(field));assert.ok(cut.indexOf('Assert-NoActivity')<cut.indexOf("@('stop',$CoreName)"));assert.match(cut,/Assert-CoreIdle -ZeroModels/);
});
test('deploy-first requires the exact user instruction, typed pending acceptance and follow-up without weakening the default gate',()=>{
  const gate=body('Assert-GateFlags');
  assert.match(gate,/\$deployFirst = Field \$gate 'DeployBeforeUiTesting'/);
  assert.match(gate,/\$null -eq \$deployFirst.*\$deployFirst -is \[bool\]/);
  assert.match(gate,/if \(\$deployFirst -eq \$true\).*Require-False \$gate \$name/s);
  assert.match(body('Require-False'),/-is \[bool\].*!\$value/);
  assert.match(gate,/AuthorizationSource'\) -ceq 'user'/);
  const encoded=/FromBase64String\('([^']+)'\)/.exec(gate);assert.ok(encoded);assert.equal(Buffer.from(encoded[1],'base64').toString('utf8'),'先部署生产再测试');
  assert.match(gate,/AuthorizationInstruction'\) -ceq \$instruction/);
  assert.match(gate,/Require-True \$gate 'PostDeploymentTestingRequired'/);
  assert.match(gate,/else \{\s*foreach \(\$name in @\('GateBPassed','OriginalPagePassed','CanaryPassed'\)\) \{ Require-True \$gate \$name \}/);
  const cut=body('Cutover-Release');assert.match(cut,/GateBPassed=\(Field \$gate 'GateBPassed'\)/);assert.match(cut,/OriginalPagePassed=\(Field \$gate 'OriginalPagePassed'\)/);assert.match(cut,/CanaryPassed=\(Field \$gate 'CanaryPassed'\)/);
  assert.match(cut,/-Name Acceptance -Value \$acceptance -Force/);
  assert.ok(cut.indexOf('-Name Acceptance')<cut.indexOf('Write-ProductionConfig'));
  assert.match(readme,/先部署生产再测试/);assert.match(readme,/严格 JSON false/);assert.match(readme,/不能把这项授权当作 UI 已通过/);
});
test('DryRun returns a plan before Docker/config/filesystem operations, and real SSH-owned phases are refused',()=>{
  const chunk=script.slice(script.indexOf('if ($DryRun)'),script.indexOf('function Invoke-Docker'));
  assert.match(chunk,/DeploymentExecuted=\$false/);assert.match(chunk,/RuntimeConfigRead=\$false/);assert.match(chunk,/return\s*\}/);
  assert.doesNotMatch(chunk,/Invoke-Docker|Read-EnvMap|Write-Env|Save-State|Invoke-RestMethod|New-Item|CreateDirectory/);
  assert.match(script,/Require \(!\$env:SSH_CONNECTION -and !\$env:SSH_CLIENT\)/);
});
test('canary uses an independent restored volume, the same guest secret, blank providers and no public core port',()=>{
  const core=body('Start-Core');assert.doesNotMatch(core,/--publish|'-p'/);assert.match(core,/--network-alias','image2'/);assert.match(core,/source=\$CoreVolume,target=\/data\/image2/);
  const canary=body('Start-Canary');assert.match(canary,/'--publish','127\.0\.0\.1:18196:18084'/);assert.match(canary,/source=\$CanaryVolume,target=\/data/);assert.match(canary,/Assert-ModelBlank \$CoreName;Assert-ModelBlank \$CanaryName/);
  const config=body('Write-CanaryConfig');assert.match(config,/IMAGE_OPENAI_\|OPENAI_\|AGENT_LLM_\|GPU_COMFY_/);assert.match(config,/Guest-Secret \$web\) -ceq \(Guest-Secret \$original/);assert.match(config,/\$web\[\$key\]=''/);
  assert.doesNotMatch(script,/GateBPassed\s*=\s*\$true|CanaryPassed\s*=\s*\$true/);
});
test('backups are online SQLite plus immutable assets and old shared image volume, with finally unpause and isolated asset verification',()=>{
  const prep=body('Prepare-Release');assert.match(prep,/DatabaseSync,backup/);assert.match(prep,/await backup\(d,/);assert.match(prep,/readOnly:true/);assert.match(prep,/--exclude=\.\/studio\.sqlite-wal/);
  assert.match(prep,/finally \{ Unpause-Webs \}/);assert.match(script,/if\(\$script:PausedWebs\.Count\)\{Unpause-Webs\}/);
  assert.ok(prep.indexOf('$script:PausedWebs+=$name')<prep.indexOf("@('pause',$name)"));assert.match(prep,/source=\$RestoreVolume,target=\/data\/studio/);assert.match(prep,/PRAGMA quick_check/);assert.match(prep,/createHash\('sha256'\)/);assert.match(prep,/verifiedAssets -eq \$restore\.assets/);assert.match(prep,/source=\$CanaryVolume,target=\/target/);
  assert.doesNotMatch(prep,/source=\$GatewayVolume,target=\/data\/studio|source=\$LegacyVolume,target=\/target/);
});
test('source validation prevents path traversal/private env/runtime data/links and extracts only into a fresh release directory',()=>{
  const check=body('Check-Archive');assert.match(check,/Get-FileHash.*SHA256/);assert.match(check,/archive_unsafe/);assert.match(check,/archive_private/);assert.match(check,/archive_links/);assert.match(check,/\.env\\\.example/);
  const prep=body('Prepare-Release');assert.match(prep,/Require \(!\(Test-Path -LiteralPath \$SourceRoot\)\)/);assert.match(prep,/--label.*weiai\.image2\.source-sha=\$ExpectedSha/);assert.match(prep,/NewWebImageId=.*Docker-Object 'image'/);
});
test('only the guarded cutover publishes 18194 and rollback restores a retained matching container without touching ledgers/workers/tunnel',()=>{
  const cut=body('Cutover-Release');assert.match(cut,/'--publish','18194:18084'/);assert.match(cut,/source=\$LegacyVolume,target=\/data/);assert.match(cut,/Read-PublicRoutes/);assert.match(cut,/Restore-OldWeb 'failed'/);
  const rollback=body('Rollback-Release'),restore=body('Restore-OldWeb');assert.match(restore,/rollback_digest_mismatch/);assert.match(restore,/rollback_superseded/);assert.match(restore,/OriginalWebBuildId/);
  assert.doesNotMatch(rollback,/CoreName|volume|sqlite|tar|cp |--env-file/);assert.doesNotMatch(script,/docker (?:rm|rmi|system prune|volume rm)|down -v|cloudflared|launchctl|schtasks\/|D:\\studio-v3-worker/);
});
test('secret comparisons emit only boolean/count receipts, Docker errors suppress raw output, and documentation preserves evidence limits',()=>{
  assert.match(body('Assert-PrivateConfig'),/Matches=\$matches; ComparedFieldCount=\$file.Count/);assert.match(body('Invoke-Docker'),/raw output was suppressed/);
  assert.doesNotMatch(script,/Config\.Env\s*\|\s*(?:ConvertTo-Json|Out-File)|Write-(?:Host|Output|Error).*\$(?:token|value|map|original|core\.IMAGE2_API_TOKEN)/i);
  assert.match(script,/SetAccessRuleProtection\(\$true,\$false\)/);assert.match(readme,/没有执行 Windows/);assert.match(readme,/没有 PowerShell/);assert.match(readme,/CanaryRuntimeReady=true/);assert.match(readme,/不会创建 `GateBPassed=true`/);
});

const powershell=['pwsh','powershell'].find(name=>{const r=spawnSync(name,['-NoProfile','-NonInteractive','-Command','exit 0'],{encoding:'utf8',timeout:5000});return !r.error&&r.status===0;});
const quote=(value:string)=>`'${value.replaceAll("'","''")}'`;
test('real PowerShell AST parses the release script without executing it',{skip:!powershell?'PowerShell is not installed; lexical/static checks do not replace AST validation':false},()=>{
  const code=`$t=$null;$e=$null;$null=[Management.Automation.Language.Parser]::ParseFile(${quote(scriptPath)},[ref]$t,[ref]$e);if($e.Count){$e|ForEach-Object{$_.Message};exit 1};exit 0`;
  const r=spawnSync(powershell!,['-NoProfile','-NonInteractive','-Command',code],{encoding:'utf8',timeout:15000});assert.equal(r.status,0,`${r.stdout}\n${r.stderr}`);
});
test('real PowerShell Prepare/Canary dry-run writes nothing and invokes no Docker',{skip:!powershell?'PowerShell is not installed; dry-run execution is not verified':false},t=>{
  const dir=mkdtempSync(join(tmpdir(),'image2-release-static-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const drive=join(dir,'drive');mkdirSync(drive);
  for(const phase of ['Prepare','Canary']){
    const setup=process.platform==='win32'?'':`New-PSDrive -Name C -PSProvider FileSystem -Root ${quote(drive)}|Out-Null;`;
    const code=`${setup}& ${quote(scriptPath)} -ReleaseId offline-test-b -SourceArchive missing.tgz -ExpectedSha ${'0'.repeat(64)} -Phase ${phase} -DryRun`;
    const r=spawnSync(powershell!,['-NoProfile','-NonInteractive','-Command',code],{encoding:'utf8',timeout:15000});assert.equal(r.status,0,`${r.stdout}\n${r.stderr}`);const j=JSON.parse(r.stdout.trim());assert.equal(j.DryRun,true);assert.equal(j.DeploymentExecuted,false);assert.equal(j.RuntimeConfigRead,false);assert.deepEqual(j.CorePublishedPorts,[]);
  }
  assert.deepEqual(readdirSync(drive),[]);
});
test('real PowerShell refuses false/string true/nonzero model or wrong-source cutover gates before mutation',{skip:!powershell?'PowerShell is not installed; negative gate execution is not verified':false},t=>{
  const dir=mkdtempSync(join(tmpdir(),'image2-release-gate-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const drive=join(dir,'drive');mkdirSync(drive);const gatePath=join(dir,'gate.json');
  const gate={ReleaseId:'offline-test-b',SourceSha256:'0'.repeat(64),GateBPassed:true,OriginalPagePassed:true,CanaryPassed:true,GenerationCalls:0,LlmCalls:0,VisionCalls:0};
  for(const patch of [{GateBPassed:false},{GateBPassed:'true'},{GenerationCalls:1},{SourceSha256:'1'.repeat(64)}]){
    writeFileSync(gatePath,JSON.stringify({...gate,...patch}));const setup=process.platform==='win32'?'':`New-PSDrive -Name C -PSProvider FileSystem -Root ${quote(drive)}|Out-Null;`;
    const code=`${setup}& ${quote(scriptPath)} -ReleaseId offline-test-b -SourceArchive missing.tgz -ExpectedSha ${'0'.repeat(64)} -Phase Cutover -GateReceipt ${quote(gatePath)} -DryRun`;
    const r=spawnSync(powershell!,['-NoProfile','-NonInteractive','-Command',code],{encoding:'utf8',timeout:15000});assert.notEqual(r.status,0);assert.deepEqual(readdirSync(drive),[]);
  }
});
test('real PowerShell permits only truthful explicitly authorized deploy-first dry-run and rejects malformed bypasses',{skip:!powershell?'PowerShell is not installed; deploy-first execution is not verified':false},t=>{
  const dir=mkdtempSync(join(tmpdir(),'image2-release-deploy-first-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const drive=join(dir,'drive');mkdirSync(drive);const gatePath=join(dir,'gate.json');
  const gate={ReleaseId:'offline-test-b',SourceSha256:'0'.repeat(64),DeployBeforeUiTesting:true,AuthorizationSource:'user',AuthorizationInstruction:'先部署生产再测试',PostDeploymentTestingRequired:true,GateBPassed:false,OriginalPagePassed:false,CanaryPassed:false,GenerationCalls:0,LlmCalls:0,VisionCalls:0};
  const setup=process.platform==='win32'?'':`New-PSDrive -Name C -PSProvider FileSystem -Root ${quote(drive)}|Out-Null;`;
  const run=(patch:Record<string,unknown>)=>{writeFileSync(gatePath,JSON.stringify({...gate,...patch}));return spawnSync(powershell!,['-NoProfile','-NonInteractive','-Command',`${setup}& ${quote(scriptPath)} -ReleaseId offline-test-b -SourceArchive missing.tgz -ExpectedSha ${'0'.repeat(64)} -Phase Cutover -GateReceipt ${quote(gatePath)} -DryRun`],{encoding:'utf8',timeout:15000});};
  const accepted=run({});assert.equal(accepted.status,0,`${accepted.stdout}\n${accepted.stderr}`);const receipt=JSON.parse(accepted.stdout.trim());assert.equal(receipt.DeployBeforeUiTesting,true);assert.equal(receipt.PostDeploymentTestingRequired,true);assert.equal(receipt.DeploymentExecuted,false);assert.equal(receipt.RuntimeConfigRead,false);assert.deepEqual(readdirSync(drive),[]);
  for(const patch of [{DeployBeforeUiTesting:'true'},{DeployBeforeUiTesting:false},{AuthorizationSource:'agent'},{AuthorizationInstruction:'deploy'},{PostDeploymentTestingRequired:false},{GateBPassed:true},{OriginalPagePassed:'false'},{CanaryPassed:true},{GenerationCalls:1},{LlmCalls:'0'},{SourceSha256:'1'.repeat(64)}]){const rejected=run(patch);assert.notEqual(rejected.status,0,JSON.stringify(patch));assert.deepEqual(readdirSync(drive),[]);}
});
