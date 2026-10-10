/** Authenticated durable desktop worker. HTTP acceptance is separate from completion. */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, readdir, stat, rm } from 'node:fs/promises';
import { resolve, join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { sha256, runtimeHash, run, fileHash } from './render.mjs';
import { validateEffectsSpec } from './effects.mjs';
import { EFFECTS_TYPES } from '../../gateway/studio/effects-program.mjs';
import { atomicJSON, durableReadFile } from './durable-io.mjs';
export { atomicJSON } from './durable-io.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(process.env.STUDIO_CODE_DATA || join(HERE, '.data'));
const TOKEN = process.env.STUDIO_CODE_WORKER_TOKEN || process.env.STUDIO_WORKER_TOKEN;
if (!TOKEN || TOKEN.length < 24) throw Error('A private worker token of at least 24 characters is required');
await mkdir(DATA, { recursive: true });
const ID = /^[a-zA-Z0-9_-]{1,100}$/;
const HASH = /^[a-f0-9]{64}$/;
const active = new Map();
let mutations=Promise.resolve();
async function mutationLease(){let release;const previous=mutations;mutations=new Promise(r=>{release=r;});await previous;return release;}
const directory = id => { if (!ID.test(id)) throw Error('Invalid job ID'); return join(DATA, id); };
const readState = async id => {const s=JSON.parse(await durableReadFile(join(directory(id),'job.json'),'utf8'));if(await stat(join(directory(id),'cancelled.marker')).then(()=>true,()=>false)){s.status='cancelled';s.stage='cancelled';}return s;};
const saveState = state => atomicJSON(join(directory(state.jobRef),'job.json'),state);
function publicState(s) { const { assets, spec, bodyHash, ...rest } = s; return rest; }
function authenticated(req) { const a=Buffer.from(req.headers.authorization || ''), b=Buffer.from(`Bearer ${TOKEN}`); return a.length === b.length && timingSafeEqual(a,b); }
async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 768 * 1024 * 1024) throw Error('Request exceeds transfer buffer'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function validate(input) {
  if (!input || !ID.test(input.jobRef) || !HASH.test(input.inputHash) || !['render','enhancement','effects-render'].includes(input.kind)) throw Error('Invalid job identity/kind');
  if (!input.spec || typeof input.spec !== 'object') throw Error('Missing frozen spec');
  if (input.kind === 'render' && (!['three-webgl','remotion'].includes(input.spec.backend) || input.spec.fps !== 24)) throw Error('Invalid render spec');
  if (input.kind === 'enhancement') {
    const p = input.spec.parameters;
    if (!p || p.stages !== 'nr' || p.preset !== 'natural' || p.passes !== 1 || p.processingScale !== 100 || p.frameGeneration !== false || p.superResolution !== false) throw Error('Only verified NR natural x1 at 100 percent is supported');
    if (!HASH.test(input.spec.sourceHash)) throw Error('Missing enhancement source hash');
  }
  if (!Array.isArray(input.assets) || input.assets.length > 1000) throw Error('Invalid assets');
  if(input.kind==='effects-render')validateEffectsSpec(input.spec,input.assets);
  const ids = new Set();
  for (const asset of input.assets) {
    if (!ID.test(asset.id) || ids.has(asset.id) || !HASH.test(asset.hash) || typeof asset.base64 !== 'string') throw Error('Invalid/duplicate asset');
    ids.add(asset.id);
    if (sha256(Buffer.from(asset.base64,'base64')) !== asset.hash) throw Error('Asset content hash mismatch');
  }
}
async function getCapabilities() {
  const chrome = process.env.STUDIO_CHROME_BIN || (process.platform==='win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe':'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  const present = async path => path ? stat(path).then(()=>true,()=>false) : false;
  const desktop=await desktopStatus();
  const available = await present(chrome) && desktop.available;
  let nr=false;
  if(process.platform==='win32'&&desktop.available&&await present(process.env.STUDIO_NR_EXE)){try{nr=await fileHash(process.env.STUDIO_NR_EXE)==='fdefd51abf31a63f20f970f8a7a82d230e825dd3da962836b8e9e8febbf16b89'&&await fileHash(join(dirname(process.env.STUDIO_NR_EXE),'neural-runtime','nvngx_dlssnr.dll'))==='6eb209e764f39872625debd6abaf45e2bb6322f6f270f781f70c059ae30b3927';}catch{}}
  return { schemaVersion:1, available, runtimeHash:await runtimeHash(), desktop, effects:{available,reason:available?undefined:desktop.reason||'Configured Chrome is unavailable',schemaVersion:1,types:EFFECTS_TYPES,renderer:'Canvas2D',audio:'original AAC copy'}, renderers:{'three-webgl':{available,reason:!desktop.available?desktop.reason:undefined},remotion:{available,version:'4.0.532',reason:!desktop.available?desktop.reason:undefined}}, dlss:{available:nr,reason:nr?null:desktop.reason||'Windows interactive NR runtime is not configured',parameters:{stages:'nr',preset:'natural',passes:1,processingScale:100,frameGeneration:false,superResolution:false}}, scheduler:{serial:true,activeJobs:[...active.keys()],sharedGpuMutex:process.env.STUDIO_GPU_MUTEX || 'Global\\WeiaiStudioGpuV1'}, persistence:'job receipts and frame checkpoints on local disk' };
}
let desktopCache;
async function desktopStatus(){
  if(process.platform!=='win32')return{available:true,platform:process.platform};
  if(desktopCache&&Date.now()-desktopCache.at<5000)return desktopCache.value;
  const ps=`$ErrorActionPreference='Stop'; Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class DesktopProbe{[DllImport("user32.dll")]public static extern IntPtr OpenInputDesktop(uint f,bool inherit,uint access);[DllImport("user32.dll")]public static extern bool SwitchDesktop(IntPtr h);[DllImport("user32.dll")]public static extern bool CloseDesktop(IntPtr h);}'; $h=[DesktopProbe]::OpenInputDesktop(0,$false,256); $active=($h -ne [IntPtr]::Zero -and [DesktopProbe]::SwitchDesktop($h)); if($h -ne [IntPtr]::Zero){[DesktopProbe]::CloseDesktop($h)|Out-Null}; @{sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId;available=$active}|ConvertTo-Json -Compress`;
  let value;try{value=JSON.parse(await run('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(ps,'utf16le').toString('base64')],{timeout:10000}));value.available=Boolean(value.available&&value.sessionId>0);}catch{value={available:false};}
  if(!value.available)value.reason='Waiting for an unlocked Windows interactive desktop';desktopCache={at:Date.now(),value};return value;
}
let pumping = false;
async function pump() {
  if (pumping || active.size) return; pumping = true;
  const release=await mutationLease();
  try {
    for (const id of await readdir(DATA)) {
      if (!ID.test(id)) continue;
      let state; try { state = await readState(id); } catch { continue; }
      if (state.status !== 'queued' || state.requiresSubmission) continue;
      const desktop=await desktopStatus();if(!desktop.available){state.waitingReason=desktop.reason;await saveState(state);break;}delete state.waitingReason;
      const dir = directory(id); state.status='running';state.stage='waiting-gpu';state.startedAt=new Date().toISOString(); await saveState(state);
      const child = process.platform === 'win32'
        ? spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(HERE,'run-isolated.ps1'),'-Node',process.execPath,'-Script',join(HERE,'run-job.mjs'),'-JobDirectory',dir],{windowsHide:true,stdio:['ignore','ignore','pipe']})
        : spawn(process.execPath,[join(HERE,'run-job.mjs'),dir],{stdio:['ignore','ignore','pipe']});
      active.set(id, child); let stderr=''; child.stderr.on('data',b=>{stderr=(stderr+b).slice(-12000);});
      child.on('error',e=>{stderr=String(e);});
      child.on('close',async code=>{
        const releaseClose=await mutationLease();
        try {
          if(active.get(id)===child){
            try { const latest=await readState(id); if (latest.status==='running') { latest.status='failed';latest.stage='interrupted';latest.error=stderr || `Worker process exited ${code}`; await saveState(latest); } }
            finally { active.delete(id); }
          }
        } catch {} finally { releaseClose(); }
        void pump();
      });
      break;
    }
  } finally { pumping=false; release(); }
}
// A process restart never declares in-flight work complete. Explicit retry reuses PNG checkpoints.
for (const id of await readdir(DATA)) { if (ID.test(id)) { try { const s=await readState(id);if(s.status==='running'){s.status='failed';s.stage='interrupted';s.error='Desktop worker restarted; resume keeps completed frames';await saveState(s);} }catch{} } }
const server = createServer(async (req,res)=>{
  const reply=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  let release;
  try {
    if (!authenticated(req)) return reply(401,{error:'Unauthorized'});
    if(req.method==='POST'){release=await mutationLease();req.setTimeout(120000,()=>req.destroy());}
    const url = new URL(req.url,'http://localhost'); const path=url.pathname;
    if(req.method==='GET'&&path==='/api/v3/code/capabilities')return reply(200,await getCapabilities());
    if(req.method==='POST'&&path==='/api/v3/code/jobs'){
      const input=await readBody(req);validate(input);const dir=directory(input.jobRef);
      const bodyHash=sha256(JSON.stringify({kind:input.kind,spec:input.spec,assets:input.assets.map(({base64,...a})=>a)}));
      let old;try{old=await readState(input.jobRef);}catch(error){if(error.code!=='ENOENT')throw error;}
      if(old){
        if(old.inputHash!==input.inputHash)return reply(409,{error:'Job identity reused with different input'});
        if(old.requiresSubmission){
          // A late submission cannot undo a cancellation. Only a new, explicit
          // retry authorizes accepting the gateway's original frozen payload.
          if(old.status!=='queued'||!old.submissionAuthorized)return reply(200,publicState(old));
        }else{
          if(old.bodyHash!==bodyHash)return reply(409,{error:'Job identity reused with different input'});
          return reply(200,publicState(old));
        }
      }
      if(input.spec.runtimeHash&&input.spec.runtimeHash!==await runtimeHash())return reply(409,{error:'Frozen worker revision unavailable; restore the original release'});
      await mkdir(join(dir,'assets'),{recursive:true});const assets=[];
      for(const a of input.assets){const path=join(dir,'assets',a.id);await writeFile(path,Buffer.from(a.base64,'base64'));assets.push({id:a.id,hash:a.hash,mime:a.mime,path});}
      const state={jobRef:input.jobRef,inputHash:input.inputHash,bodyHash,kind:input.kind,spec:input.spec,assets,status:'queued',stage:'queued',progress:0,outputs:[],createdAt:old?.createdAt||new Date().toISOString(),retries:old?.retries||[],...(old?.cancelledBeforeAcceptance?{cancelledBeforeAcceptance:true,requiresSubmission:false,submissionAuthorized:false}:{})};
      await saveState(state);reply(202,publicState(state));void pump();return;
    }
    const match=path.match(/^\/api\/v3\/code\/jobs\/([a-zA-Z0-9_-]+)(?:\/(cancel|retry))?$/);
    if(match){
      let s;
      if(req.method==='POST'&&match[2]==='cancel'){
        const b=await readBody(req);if(!HASH.test(b.inputHash))return reply(409,{error:'Cancellation must match a frozen input hash'});
        try{s=await readState(match[1]);}catch(error){if(error.code!=='ENOENT')throw error;}
        if(s&&s.inputHash!==b.inputHash)return reply(409,{error:'Cancellation input hash mismatch'});
        if(!s){
          s={jobRef:match[1],inputHash:b.inputHash,status:'cancelled',stage:'cancelled',progress:0,assets:[],outputs:[],retries:[],createdAt:new Date().toISOString(),cancelledBeforeAcceptance:true,requiresSubmission:true,submissionAuthorized:false};
          await mkdir(directory(s.jobRef),{recursive:true});await writeFile(join(directory(s.jobRef),'cancelled.marker'),new Date().toISOString());await saveState(s);
        }else if(!['complete','failed','cancelled'].includes(s.status)){
          await writeFile(join(directory(s.jobRef),'cancelled.marker'),new Date().toISOString());s.status='cancelled';s.stage='cancelled';s.submissionAuthorized=false;await saveState(s);active.get(s.jobRef)?.kill('SIGTERM');
        }
        return reply(200,publicState(s));
      }
      s=await readState(match[1]);if(req.method==='GET'&&!match[2])return reply(200,publicState(s));
      if(req.method==='POST'&&match[2]==='retry'){
        const b=await readBody(req);if(b.inputHash!==s.inputHash||typeof b.retryKey!=='string'||!b.retryKey.length||b.retryKey.length>200)return reply(409,{error:'Retry must match frozen input'});
        if(s.retries.includes(b.retryKey))return reply(200,publicState(s));
        if(!['failed','cancelled'].includes(s.status)||active.has(s.jobRef))return reply(409,{error:'Only stopped jobs can retry'});
        await rm(join(directory(s.jobRef),'cancelled.marker'),{force:true});s.retries.push(b.retryKey);s.status='queued';s.stage=s.requiresSubmission?'awaiting-original-submission':'queued';if(s.requiresSubmission)s.submissionAuthorized=true;delete s.error;await saveState(s);reply(202,publicState(s));void pump();return;
      }
    }
    const media=path.match(/^\/api\/v3\/code\/media\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)$/);
    if(req.method==='GET'&&media){const s=await readState(media[1]),o=s.outputs.find(o=>o.name===media[2]);if(!o)return reply(404,{error:'Unpublished output'});const b=await readFile(join(directory(s.jobRef),o.name));if(sha256(b)!==o.sha256)throw Error('Stored output changed');res.writeHead(200,{'Content-Type':o.mime,'Content-Length':b.length});res.end(b);return;}
    reply(404,{error:'Not found'});
  }catch(error){reply(error.code==='ENOENT'?404:400,{error:String(error.message)});}finally{release?.();}
});
server.listen(Number(process.env.STUDIO_CODE_PORT||18089),process.env.STUDIO_CODE_HOST||'127.0.0.1',()=>console.log('Code video worker listening on configured interface'));
void pump();
setInterval(()=>void pump(),10000).unref();
process.on('SIGTERM',()=>{for(const child of active.values())child.kill('SIGTERM');server.close(()=>process.exit(0));});
