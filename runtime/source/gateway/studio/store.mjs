import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, writeFileSync, renameSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { clone, canonical, digest, fail, StudioError, validateProject, invalidateApprovals, shotHash } from './domain.mjs';

const now = () => new Date().toISOString();
function exportPlanHash(input){
  // A finished export appends its artifact and bumps project revision. Neither
  // changes the render plan or turns a retry into a different export request.
  const p=input.project,referenced=new Set(p.sequence.clips.map(c=>c.assetId).filter(Boolean));
  const assets=p.assets.filter(a=>referenced.has(a.id)).map(({id,hash,kind,mime})=>({id,hash,kind,mime})).sort((a,b)=>a.id.localeCompare(b.id));
  return digest({project:{id:p.id,name:p.name,fps:p.fps,aspect:p.aspect,sequence:p.sequence,assets}});
}
export class StudioStore {
  constructor(directory) {
    this.directory=resolve(directory); this.assetDirectory=join(this.directory,'assets'); this.workDirectory=join(this.directory,'work');
    mkdirSync(this.assetDirectory,{recursive:true}); mkdirSync(this.workDirectory,{recursive:true});
    this.db=new DatabaseSync(join(this.directory,'studio.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, json TEXT NOT NULL, updated_at TEXT NOT NULL, history_head INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS history(project_id TEXT NOT NULL, seq INTEGER NOT NULL, command_id TEXT NOT NULL, request_hash TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL, PRIMARY KEY(project_id,seq), UNIQUE(project_id,command_id), FOREIGN KEY(project_id) REFERENCES projects(id));
      CREATE TABLE IF NOT EXISTS command_receipts(project_id TEXT NOT NULL, command_id TEXT NOT NULL, request_hash TEXT NOT NULL, response_json TEXT NOT NULL, PRIMARY KEY(project_id,command_id));
      CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, path TEXT NOT NULL, json TEXT NOT NULL, FOREIGN KEY(project_id) REFERENCES projects(id));
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, input_hash TEXT NOT NULL, state TEXT NOT NULL, json TEXT NOT NULL, private_json TEXT NOT NULL, UNIQUE(project_id,idempotency_key), FOREIGN KEY(project_id) REFERENCES projects(id));
      CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state);
      CREATE TABLE IF NOT EXISTS job_receipts(project_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, input_hash TEXT NOT NULL, job_id TEXT NOT NULL, PRIMARY KEY(project_id,idempotency_key), FOREIGN KEY(job_id) REFERENCES jobs(id));
      INSERT OR IGNORE INTO job_receipts SELECT project_id,idempotency_key,input_hash,id FROM jobs;
      CREATE TABLE IF NOT EXISTS project_owners(project_id TEXT PRIMARY KEY, visitor_id TEXT NOT NULL, FOREIGN KEY(project_id) REFERENCES projects(id));
      CREATE INDEX IF NOT EXISTS owner_visitor ON project_owners(visitor_id);
      CREATE TABLE IF NOT EXISTS job_actions(job_id TEXT NOT NULL, action TEXT NOT NULL, action_key TEXT NOT NULL, request_hash TEXT NOT NULL, PRIMARY KEY(job_id,action,action_key));
      CREATE TABLE IF NOT EXISTS worker_versions(origin TEXT PRIMARY KEY, runtime_hash TEXT NOT NULL, checked_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS asset_origins(asset_id TEXT PRIMARY KEY, source_asset_id TEXT NOT NULL, FOREIGN KEY(asset_id) REFERENCES assets(id), FOREIGN KEY(source_asset_id) REFERENCES assets(id));
      PRAGMA user_version=4;`);
  }
  close(){this.db.close();}
  transaction(fn){const depth=this.transactionDepth||0,name=`studio_${depth}`;this.transactionDepth=depth+1;try{this.db.exec(depth?`SAVEPOINT ${name}`:'BEGIN IMMEDIATE');try{const result=fn();this.db.exec(depth?`RELEASE SAVEPOINT ${name}`:'COMMIT');return result;}catch(e){this.db.exec(depth?`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`:'ROLLBACK');throw e;}}finally{this.transactionDepth=depth;}}
  getProject(id){const row=this.db.prepare('SELECT json FROM projects WHERE id=?').get(id);fail(row,'project not found',404);return JSON.parse(row.json);}
  listProjects(visitorId){return this.db.prepare('SELECT json FROM projects ORDER BY updated_at DESC').all().filter(r=>!visitorId||this.ownsProject(JSON.parse(r.json).id,visitorId)).map(r=>{const p=JSON.parse(r.json);return {id:p.id,name:p.name,revision:p.revision,createdAt:p.createdAt,updatedAt:p.updatedAt,totalFrames:p.totalFrames,aspect:p.aspect};});}
  ownsProject(id,visitorId){return !visitorId||this.db.prepare('SELECT visitor_id FROM project_owners WHERE project_id=?').get(id)?.visitor_id===visitorId;}
  assertOwner(id,visitorId){fail(this.ownsProject(id,visitorId),'project not found',404);}
  createProject(p,visitorId){validateProject(p);return this.transaction(()=>{this.db.prepare('INSERT INTO projects(id,revision,json,updated_at) VALUES(?,?,?,?)').run(p.id,p.revision,JSON.stringify(p),p.updatedAt);if(visitorId)this.db.prepare('INSERT INTO project_owners VALUES(?,?)').run(p.id,visitorId);return clone(p);});}
  persist(p){this.db.prepare('UPDATE projects SET revision=?, json=?, updated_at=? WHERE id=?').run(p.revision,JSON.stringify(p),p.updatedAt,p.id);return clone(p);}
  change(id,baseRevision,mutator,{commandId,request,undoable=true}={}) {
    return this.transaction(()=>{
      if(commandId){fail(typeof commandId==='string'&&commandId.length>0&&commandId.length<=200,'invalid commandId');const receipt=this.db.prepare('SELECT * FROM command_receipts WHERE project_id=? AND command_id=?').get(id,commandId);if(receipt){fail(receipt.request_hash===digest(request),'commandId already used with different content',409,'idempotency_conflict');return this.getProject(id);}}
      const before=this.getProject(id);fail(baseRevision===undefined||baseRevision===before.revision,'project changed; reload and retry',409,'revision_conflict');
      const after=invalidateApprovals(validateProject(mutator(clone(before))));
      after.id=before.id;after.createdAt=before.createdAt;after.revision=before.revision+1;after.updatedAt=now();
      if(undoable){const head=this.db.prepare('SELECT history_head FROM projects WHERE id=?').get(id).history_head;this.db.prepare('DELETE FROM history WHERE project_id=? AND seq>?').run(id,head);this.db.prepare('INSERT INTO history VALUES(?,?,?,?,?,?)').run(id,head+1,commandId||randomUUID(),digest(request||after),JSON.stringify(before),JSON.stringify(after));this.db.prepare('UPDATE projects SET history_head=? WHERE id=?').run(head+1,id);}
      this.persist(after);
      if(commandId)this.db.prepare('INSERT INTO command_receipts VALUES(?,?,?,?)').run(id,commandId,digest(request),JSON.stringify(after));
      return clone(after);
    });
  }
  history(id,baseRevision,direction){
    fail(['undo','redo'].includes(direction),'invalid history direction');
    return this.transaction(()=>{
      const current=this.getProject(id);fail(current.revision===baseRevision,'project changed; reload and retry',409,'revision_conflict');
      const head=this.db.prepare('SELECT history_head FROM projects WHERE id=?').get(id).history_head;
      const row=this.db.prepare('SELECT * FROM history WHERE project_id=? AND seq=?').get(id,direction==='undo'?head:head+1);fail(row,`nothing to ${direction}`,409,'empty_history');
      const target=JSON.parse(direction==='undo'?row.before_json:row.after_json);
      // Media revisions and completed work never disappear when undoing authoring edits.
      target.assets=current.assets;
      for(const s of target.shots){const live=current.shots.find(x=>x.id===s.id);s.takes=live?.takes||s.takes;delete s.approval;if(live?.approval)s.approval=live.approval;}
      target.revision=current.revision+1;target.updatedAt=now();
      this.db.prepare('UPDATE projects SET history_head=? WHERE id=?').run(direction==='undo'?head-1:head+1,id);
      return this.persist(validateProject(invalidateApprovals(target)));
    });
  }
  prepareAsset(projectId,{name,kind,mime,parentId,source,metadata},bytes){
    fail(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=512*1024*1024,'asset must be 1 byte–512 MB');
    fail(['image','video','audio','model','bake'].includes(kind),'invalid asset kind');fail(typeof name==='string'&&name.length>0&&name.length<=500,'invalid asset name');
    const validMime={image:/^image\/(png|jpeg|webp)$/,video:/^video\/(mp4|webm|quicktime)$/,audio:/^audio\/(mpeg|mp3|wav|x-wav|ogg|mp4|aac|flac|webm)$/,model:/^(model\/gltf-binary|application\/octet-stream)$/,bake:/^(model\/gltf-binary|application\/octet-stream)$/};
    fail(typeof mime==='string'&&validMime[kind].test(mime),'unsupported asset MIME type');
    const p=this.getProject(projectId);fail(!parentId||p.assets.some(a=>a.id===parentId),'parent asset not found');
    if(metadata)fail(canonical(metadata).length<=2000000,'asset metadata is too large');
    const hash=digest(bytes),assetId=randomUUID(),path=join(this.assetDirectory,hash);
    if(!existsSync(path)){const tmp=`${path}.${randomUUID()}.tmp`;writeFileSync(tmp,bytes,{flag:'wx'});renameSync(tmp,path);}
    const asset={id:assetId,name,kind,mime,hash,url:`/api/v3/assets/${assetId}/content`,bytes:bytes.length,createdAt:now(),...(parentId?{parentId}:{}),...(source?{source:String(source).slice(0,2000)}:{}),...(metadata?{metadata:clone(metadata)}:{})};
    return {asset,path};
  }
  insertAsset(projectId,prepared){this.db.prepare('INSERT INTO assets VALUES(?,?,?,?)').run(prepared.asset.id,projectId,prepared.path,JSON.stringify(prepared.asset));}
  addAsset(projectId,descriptor,bytes){const prepared=this.prepareAsset(projectId,descriptor,bytes);const project=this.change(projectId,undefined,p=>{this.insertAsset(projectId,prepared);p.assets.push(prepared.asset);return p;},{undoable:false});return {asset:prepared.asset,project};}
  getAsset(id){const row=this.db.prepare('SELECT * FROM assets WHERE id=?').get(id);fail(row,'asset not found',404);return {asset:JSON.parse(row.json),path:row.path,projectId:row.project_id};}
  resolveAsset(id){return this.getAsset(typeof id==='string'?id:id.id).path;}
  assetBytes(id){return readFileSync(this.resolveAsset(id));}
  createJob(projectId,kind,idempotencyKey,input,{baseRevision}={}){
    fail(typeof idempotencyKey==='string'&&idempotencyKey.length>0&&idempotencyKey.length<=200,'idempotencyKey is required');
    // Preserve the stored hash format for existing receipts and image rollback.
    const inputHash=digest({kind,input});
    return this.transaction(()=>{
      const project=this.getProject(projectId);fail(baseRevision===undefined||baseRevision===project.revision,'project changed before task submission; reload and retry',409,'revision_conflict');
      const old=this.db.prepare('SELECT * FROM job_receipts WHERE project_id=? AND idempotency_key=?').get(projectId,idempotencyKey);
      if(old){const record=this.job(old.job_id);const same=old.input_hash===inputHash||(kind==='export'&&record.job.kind===kind&&exportPlanHash(record.private.input)===exportPlanHash(input));fail(same,'idempotency key already used with different input',409,'idempotency_conflict');return record.job;}
      const receipt=job=>{this.db.prepare('INSERT INTO job_receipts VALUES(?,?,?,?)').run(projectId,idempotencyKey,inputHash,job.id);return job;};
      const active=this.db.prepare("SELECT json FROM jobs WHERE project_id=? AND input_hash=? AND state IN ('queued','running','uncertain')").get(projectId,inputHash);if(active)return receipt(JSON.parse(active.json));
      // Keep pre-existing schema-2 full-snapshot hashes and their aliases intact.
      if(kind==='export'){const planHash=exportPlanHash(input),equivalent=this.db.prepare("SELECT json,private_json FROM jobs WHERE project_id=? AND json_extract(json,'$.kind')='export' AND state IN ('queued','running','uncertain')").all(projectId).find(r=>exportPlanHash(JSON.parse(r.private_json).input)===planHash);if(equivalent)return receipt(JSON.parse(equivalent.json));}
      const timestamp=now(),job={id:randomUUID(),projectId,kind,state:'queued',progress:0,createdAt:timestamp,updatedAt:timestamp};
      this.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?)').run(job.id,projectId,idempotencyKey,inputHash,job.state,JSON.stringify(job),JSON.stringify({input:clone(input),inputHash,phase:'queued',attempts:0}));return receipt(job);
    });
  }
  job(id){const r=this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);fail(r,'job not found',404);return {job:JSON.parse(r.json),private:JSON.parse(r.private_json)};}
  listJobs(projectId){return this.db.prepare('SELECT json FROM jobs WHERE project_id=? ORDER BY rowid DESC').all(projectId).map(r=>JSON.parse(r.json));}
  pendingJobs(){return this.db.prepare("SELECT id FROM jobs WHERE state IN ('queued','running') OR (state='complete' AND json_extract(private_json,'$.effectsHandoff') IN ('pending','waiting')) OR (state='complete' AND json_extract(private_json,'$.archiveState') IN ('pending','running')) ORDER BY rowid").all().map(r=>r.id);}
  updateJob(id,patch,privatePatch={}){const record=this.job(id),job={...record.job,...patch,updatedAt:now()},priv={...record.private,...privatePatch};this.db.prepare('UPDATE jobs SET state=?,json=?,private_json=? WHERE id=?').run(job.state,JSON.stringify(job),JSON.stringify(priv),id);return job;}
  recoverJobs(){for(const id of this.pendingJobs()){const r=this.job(id);if(r.private.phase==='submitting'&&['generation','scene-generation','effects-plan'].includes(r.job.kind)&&!r.private.handle)this.updateJob(id,{state:'uncertain',error:'Gateway restarted during provider submission. Acceptance is unknown; automatic resubmission is disabled.',...(['scene-generation','effects-plan'].includes(r.job.kind)?{stage:'acceptance_unknown',cancellable:false,retryable:false}:{})},{phase:'uncertain'});else if(r.job.kind==='export'&&r.job.state==='running')this.updateJob(id,{state:'queued',progress:0},{phase:'queued'});}}
  addJobImage(id,index,descriptor,bytes,frame){
    const record=this.job(id),prepared=this.prepareAsset(record.job.projectId,descriptor,bytes);
    return this.transaction(()=>{
      const r=this.job(id),images=r.private.images||[];if(images[index])return clone(images[index]);fail(index===images.length,'preview images must be checkpointed in order',409);
      const p=this.getProject(r.job.projectId);this.insertAsset(p.id,prepared);p.assets.push(prepared.asset);p.revision++;p.updatedAt=now();this.persist(p);
      const image={id:prepared.asset.id,url:prepared.asset.url,...(frame===undefined?{}:{frame})};images.push(image);this.updateJob(id,{}, {images});return image;
    });
  }
  checkpointOutput(id,key,descriptor,bytes,details={}){
    const existing=this.job(id).private.outputs?.[key];if(existing)return clone(existing);
    const r=this.job(id),prepared=this.prepareAsset(r.job.projectId,descriptor,bytes);
    return this.transaction(()=>{const live=this.job(id);fail(!live.private.cancelRequested&&!['cancelled','uncertain'].includes(live.job.state),'task was cancelled',409,'cancelled');if(live.private.outputs?.[key])return clone(live.private.outputs[key]);
      const p=this.getProject(live.job.projectId);this.insertAsset(p.id,prepared);p.assets.push(prepared.asset);p.revision++;p.updatedAt=now();this.persist(p);
      const item={...prepared.asset,...clone(details)},outputs={...live.private.outputs,[key]:item};this.updateJob(id,{outputAssetIds:Object.values(outputs).map(a=>a.id),partialAssets:Object.values(outputs),outputRevision:p.revision},{outputs});return clone(item);});
  }
  jobAction(id,action,key,request,mutator){fail(typeof key==='string'&&key.length>0&&key.length<=200,'idempotencyKey is required');return this.transaction(()=>{const old=this.db.prepare('SELECT request_hash FROM job_actions WHERE job_id=? AND action=? AND action_key=?').get(id,action,key);if(old){fail(old.request_hash===digest(request),'action key conflicts',409);return this.job(id).job;}const result=mutator(this.job(id));this.db.prepare('INSERT INTO job_actions VALUES(?,?,?,?)').run(id,action,key,digest(request));return result;});}
  completeJobWithAsset(id,assetId,output={}){return this.transaction(()=>{const r=this.job(id),a=this.getAsset(assetId);fail(a.projectId===r.job.projectId,'cross-project output asset',409);return this.updateJob(id,{state:'complete',progress:1,outputAssetId:assetId,output},{phase:'complete'});});}
  prepareArchives(configured){for(const row of this.db.prepare("SELECT id FROM jobs WHERE state='complete'").all()){const r=this.job(row.id);if(!['generation','export'].includes(r.job.kind)||!r.job.outputAssetId)continue;if(!r.private.archiveState||(configured&&['running','unconfigured'].includes(r.private.archiveState)))this.queueArchive(row.id,configured);}}
  queueArchive(id,configured){const r=this.job(id);if(!['generation','export'].includes(r.job.kind)||r.job.state!=='complete')return r.job;const state=configured?'pending':'unconfigured';return this.updateJob(id,{output:{...r.job.output,archive:{state}}},{archiveState:state,nextPollAt:0});}
  completeJob(id,descriptor,bytes,output={}){
    const r=this.job(id);if(r.job.state==='complete')return r.job;
    const prepared=this.prepareAsset(r.job.projectId,descriptor,bytes);
    return this.transaction(()=>{
      const p=this.getProject(r.job.projectId);this.insertAsset(p.id,prepared);p.assets.push(prepared.asset);
      if(r.job.kind==='generation'){
        const s=p.shots.find(s=>s.id===r.private.input.shot.id);
        if(s){const take={id:randomUUID(),assetId:prepared.asset.id,jobId:id,model:output.model||'unknown',referenceMode:output.referenceMode||'unknown'};s.takes.push(take);if(!s.selectedTakeId&&r.private.input.approvalHash===shotHash(p,s))s.selectedTakeId=take.id;}
      }
      p.revision++;p.updatedAt=now();this.persist(p);
      return this.updateJob(id,{state:'complete',progress:1,outputAssetId:prepared.asset.id,output},{phase:'complete'});
    });
  }
}
