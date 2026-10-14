import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fail, ImageError, clone, digest, timestamp, validId } from './domain.mjs';
import { createCraftRuntime, restoreCraftBundle } from './craft-runtime.mjs';

const TERMINAL = new Set(['complete','failed','cancelled']);
const KEY_LIMIT = 200, MAX_BYTES = 64 * 1024 * 1024;
const json = value => { const text = JSON.stringify(value); fail(text && Buffer.byteLength(text) <= 2 * 1024 * 1024, 'Craft request exceeds 2 MB', 413, 'craft_budget'); return text; };
const key = value => { fail(typeof value === 'string' && value.length > 0 && value.length <= KEY_LIMIT, 'idempotencyKey is required'); return value; };
const parse = row => row && JSON.parse(row.json);
const publicJob = job => { const result = clone(job); delete result.request; delete result.owner; return result; };
const nativeName = value => { fail(typeof value === 'string' && value.length > 0 && value.length <= 200 && basename(value) === value && !/[\\\x00-\x1f]/.test(value), 'invalid Craft filename'); return value; };
const KNOWN_MIME = new Set(['image/png','image/jpeg','image/webp','image/svg+xml','application/pdf','application/zip','font/ttf','font/otf','font/woff','font/woff2']);

function validatedMediaMime(bytes,mime) {
  const text=(start,end)=>bytes.toString('ascii',start,end);
  if(mime==='audio/wav'&&bytes.length>=12&&text(0,4)==='RIFF'&&text(8,12)==='WAVE')return mime;
  if(mime==='audio/aiff'&&bytes.length>=12&&text(0,4)==='FORM'&&['AIFF','AIFC'].includes(text(8,12)))return mime;
  if(mime==='audio/flac'&&bytes.length>=4&&text(0,4)==='fLaC')return mime;
  if(mime==='video/mp4'&&bytes.length>=12&&text(4,8)==='ftyp')return mime;
  return 'application/octet-stream';
}

/** Native projects are independent of image layers; all access is scoped by their image document. */
export class CraftService {
  constructor({ store, runtime, config = {} }) {
    this.store = store;
    this.runtime = runtime || createCraftRuntime({ binDir: config.binDir || process.env.IMAGE2_CRAFT_BIN_DIR, ...config });
    this.active = new Map(); this.stopped = true;
    store.db.exec(`CREATE TABLE IF NOT EXISTS craft_projects(id TEXT PRIMARY KEY,document_id TEXT NOT NULL,engine_id TEXT NOT NULL,json TEXT NOT NULL,FOREIGN KEY(document_id) REFERENCES documents(id));
      CREATE TABLE IF NOT EXISTS craft_jobs(id TEXT PRIMARY KEY,document_id TEXT NOT NULL,project_id TEXT NOT NULL,request_key TEXT NOT NULL,request_hash TEXT NOT NULL,json TEXT NOT NULL,UNIQUE(document_id,request_key),FOREIGN KEY(document_id) REFERENCES documents(id),FOREIGN KEY(project_id) REFERENCES craft_projects(id));
      CREATE TABLE IF NOT EXISTS craft_revisions(project_id TEXT NOT NULL,revision INTEGER NOT NULL,json TEXT NOT NULL,PRIMARY KEY(project_id,revision),FOREIGN KEY(project_id) REFERENCES craft_projects(id));
      CREATE TABLE IF NOT EXISTS craft_receipts(document_id TEXT NOT NULL,kind TEXT NOT NULL,request_key TEXT NOT NULL,request_hash TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(document_id,kind,request_key),FOREIGN KEY(document_id) REFERENCES documents(id));`);
    store.craftService = this;
  }
  writable(documentId,owner) { const doc=this.store.getDocument(documentId,owner);fail(!doc.metadata?.acceptedIntoDocumentId,'候选分支已经接受，请返回主工程继续编辑',409,'craft_branch_accepted');return doc; }
  async capabilities() {
    const engines = await this.runtime.capabilities();
    return { engines, persistent: true, candidateAcceptance: true, limits: { steps: 24, inputs: 32, inputBytes: MAX_BYTES, queuedPerDocument: 100 }, executionClass: 'native-cpu' };
  }
  async engine(engineId) {
    fail(typeof engineId === 'string', 'engineId is required');
    const engine = this.runtime.engineCapability ? await this.runtime.engineCapability(engineId) : (await this.runtime.capabilities()).find(item => item.id === engineId);
    fail(engine, '未知 Craft 引擎', 422, 'craft_unknown_engine');
    fail(engine.available, `${engine.name||engineId} 暂不可用（${engine.reason||'引擎尚未安装'}）`, 503, 'craft_unavailable');
    return engine;
  }
  receipt(documentId, kind, requestKey, request) {
    key(requestKey);
    const row = this.store.db.prepare('SELECT * FROM craft_receipts WHERE document_id=? AND kind=? AND request_key=?').get(documentId, kind, requestKey);
    if (!row) return null;
    fail(row.request_hash === digest(request), '同一幂等键不能用于不同 Craft 请求', 409, 'idempotency_conflict');
    return parse(row);
  }
  saveReceipt(documentId, kind, requestKey, request, result) { this.store.db.prepare('INSERT INTO craft_receipts VALUES(?,?,?,?,?)').run(documentId,kind,requestKey,digest(request),json(result)); }
  listProjects(documentId, owner) { this.store.getDocument(documentId, owner); return this.store.db.prepare('SELECT json FROM craft_projects WHERE document_id=? ORDER BY rowid DESC').all(documentId).map(parse); }
  project(documentId, owner, projectId) {
    this.store.getDocument(documentId, owner);
    const row = this.store.db.prepare('SELECT json FROM craft_projects WHERE document_id=? AND id=?').get(documentId, projectId);
    fail(row, 'Craft 工程不存在', 404, 'not_found'); return parse(row);
  }
  saveProject(project) { this.store.db.prepare('UPDATE craft_projects SET document_id=?,json=? WHERE id=?').run(project.documentId,json(project),project.id); }
  async createProject(documentId, owner, request) {
    this.writable(documentId, owner); const previous = this.receipt(documentId,'project',request.idempotencyKey,request); if (previous) return this.project(documentId,owner,previous.id);
    const engine=await this.engine(request.engineId);
    if(request.initialAssetId)await this.validateImport(documentId,owner,request.initialAssetId,request.engineId);
    const created=this.store.transaction(() => {
      const old = this.receipt(documentId,'project',request.idempotencyKey,request); if (old) return this.project(documentId,owner,old.id);
      this.writable(documentId,owner);
      const now = timestamp(), project = { id: randomUUID(), documentId, engineId: request.engineId, name: String(request.name || request.engineId).slice(0,200), revision: 0, createdAt: now, updatedAt: now };
      if(request.initialAssetId){fail(this.store.db.prepare("SELECT count(*) AS n FROM craft_jobs WHERE document_id=? AND json_extract(json,'$.state') IN ('queued','running')").get(documentId).n<100,'Craft 队列已满',429,'craft_queue_full');project.importSourceAssetId=request.initialAssetId;project.pendingImportAssetId=request.initialAssetId;project.importJobId=randomUUID();}
      this.store.db.prepare('INSERT INTO craft_projects VALUES(?,?,?,?)').run(project.id,documentId,project.engineId,json(project));
      this.store.db.prepare('INSERT INTO craft_revisions VALUES(?,?,?)').run(project.id,0,json(project));
      if(request.initialAssetId){
        const frozen={projectId:project.id,baseRevision:0,steps:[{command:'inspect',args:{}}],inputAssetIds:[],idempotencyKey:`import:${digest(request)}`};
        const job={id:project.importJobId,documentId,projectId:project.id,engineId:project.engineId,baseRevision:0,baseNativeAssetId:request.initialAssetId,state:'queued',stage:'import_verification',progress:0,createdAt:now,updatedAt:now,request:frozen,owner,importVerification:true,expectPreview:Boolean(engine.defaults?.preview),metrics:{generationCalls:0,llmCalls:0,visionCalls:0}};
        this.store.db.prepare('INSERT INTO craft_jobs VALUES(?,?,?,?,?,?)').run(job.id,documentId,project.id,frozen.idempotencyKey,digest(frozen),json(job));
      }
      this.saveReceipt(documentId,'project',request.idempotencyKey,request,{id:project.id}); return clone(project);
    });
    if(created.importJobId)setImmediate(()=>void this.tick());return created;
  }
  async validateImport(documentId,owner,assetId,engineId) {
    const doc=this.store.getDocument(documentId,owner);fail(doc.assetIds.includes(assetId),'工程包素材不在当前工程',422,'craft_asset_scope');const {bytes}=this.store.getAsset(assetId,owner);
    const directory=join(this.store.directory,'craft-work',`validate-${randomUUID()}`);mkdirSync(join(directory,'unpack'),{recursive:true,mode:0o700});const file=join(directory,'input.craftbundle');writeFileSync(file,bytes,{mode:0o600});
    try { await restoreCraftBundle(file,join(directory,'unpack'),engineId); }catch(error){throw new ImageError(`原生工程包无法导入：${error.message}`,422,error.code||'CRAFT_CHECKPOINT_INVALID');}finally{rmSync(directory,{recursive:true,force:true});}
  }
  projectView(documentId,owner,projectId) {
    const project=this.project(documentId,owner,projectId),doc=this.store.getDocument(documentId,owner);if(!project.lastJobId||!project.nativeAssetId)return project;
    const row=this.store.db.prepare('SELECT json,document_id FROM craft_jobs WHERE id=?').get(project.lastJobId);if(!row)return project;this.store.getDocument(row.document_id,owner);const job=parse(row);
    const output=job.output;if(!output||job.acceptedRevision===undefined||output.nativeAssetId!==project.nativeAssetId)return project;
    if(![project.nativeAssetId,...(output.assetIds||[])].every(id=>doc.assetIds.includes(id)))return project;
    return {...project,latestOutput:{...this.outputView(output,owner),needsAcceptance:false,accepted:true,sourceJobId:job.id,sourceDocumentId:row.document_id,acceptedProjectRevision:project.revision}};
  }
  outputView(output,owner) {
    if(!output?.assets)return output;
    return {...output,assets:output.assets.map(item=>{
      if(item.mime!=='image/svg+xml')return item;
      const asset=this.store.getAsset(item.id,owner).asset;
      fail(asset.mime===item.mime&&(!item.hash||asset.hash===item.hash),'Craft output identity changed',500,'asset_corrupt');
      const result={...item,...asset};delete result.width;delete result.height;
      if(asset.width!==undefined){result.width=asset.width;result.height=asset.height;}return result;
    })};
  }
  jobView(job,owner) { const result=publicJob(job);if(result.output)result.output=this.outputView(result.output,owner);return result; }
  listRevisions(documentId, owner, projectId) { this.project(documentId,owner,projectId); return this.store.db.prepare('SELECT json FROM craft_revisions WHERE project_id=? ORDER BY revision DESC').all(projectId).map(parse); }
  addAsset(documentId, owner, { name, mime = 'application/octet-stream', metadata = {}, inputs = [], assignedId }, bytes) {
    this.writable(documentId,owner); nativeName(name);
    fail(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_BYTES, 'Craft 文件必须为 1 字节至 64 MB', 413,'craft_budget');
    if (KNOWN_MIME.has(mime)) return this.store.addAsset(documentId,owner,{name,mime,metadata,inputs,assignedId},bytes);
    // Unknown native/office/media bytes remain downloadable opaque files. They are never HTML or image layers.
    if(assignedId!==undefined)fail(typeof assignedId==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(assignedId)&&!this.store.db.prepare('SELECT id FROM assets WHERE id=?').get(assignedId),'invalid imported native asset identity',409,'asset_identity_conflict');
    const hash = digest(bytes), path = this.store.writeBlob(bytes,hash), id = assignedId || randomUUID();
    fail(Array.isArray(inputs)&&inputs.length<=100,'invalid native asset inputs');
    const refs = inputs.map(input => { fail(input&&typeof input.role==='string'&&input.role.length>0&&input.role.length<=100,'invalid native input role');const asset = this.store.getAsset(input.assetId,owner).asset;fail(!input.hash||input.hash===asset.hash,'native input hash changed',409,'source_changed'); return {role:input.role,assetId:asset.id,hash:asset.hash}; });
    const asset = {id,documentId,name,mime:validatedMediaMime(bytes,mime),hash,bytes:bytes.length,createdAt:timestamp(),metadata:{...metadata,sourceMime:String(mime).slice(0,150),craftNative:true},inputs:refs,url:`/api/v3/image2/assets/${id}/content`};
    return this.store.transaction(() => { this.store.getDocument(documentId,owner); this.store.db.prepare('INSERT INTO assets VALUES(?,?,?,?)').run(id,documentId,json(asset),path); this.store.linkAsset(documentId,id);for(const input of refs)this.store.linkAsset(documentId,input.assetId); return asset; });
  }
  async submit(documentId, owner, request, options={}) {
    const document = this.writable(documentId,owner); key(request.idempotencyKey);
    const existing = this.store.db.prepare('SELECT * FROM craft_jobs WHERE document_id=? AND request_key=?').get(documentId,request.idempotencyKey);
    if (existing) { fail(existing.request_hash === digest(request),'同一幂等键不能用于不同 Craft 请求',409,'idempotency_conflict'); return publicJob(parse(existing)); }
    const project = this.project(documentId,owner,request.projectId);fail(!project.pendingImportAssetId||options.importVerification,'请先验收导入候选，原生工程尚未就绪',409,'craft_import_pending');await this.engine(project.engineId);
    fail(Number.isSafeInteger(request.baseRevision) && request.baseRevision === project.revision,'原生工程已修改，请刷新后提交',409,'craft_revision_conflict');
    fail(Array.isArray(request.steps) && request.steps.length > 0 && request.steps.length <= 24,'Craft steps must contain 1–24 commands');
    for (const step of request.steps) fail(step && typeof step.command === 'string' && step.command.length <= 200 && step.args && typeof step.args === 'object' && !Array.isArray(step.args),'invalid Craft step');
    const ids = request.inputAssetIds || []; fail(Array.isArray(ids) && ids.length <= 32 && ids.every(validId),'invalid Craft input assets');
    let bytes = 0; for (const id of ids) { fail(document.assetIds.includes(id),'素材不在当前工程',422,'craft_asset_scope'); bytes += this.store.getAsset(id,owner).asset.bytes; }
    fail(bytes <= MAX_BYTES,'Craft 输入总大小超过 64 MB',413,'craft_budget'); json(request);
    const job = this.store.transaction(() => {
      const repeated = this.store.db.prepare('SELECT * FROM craft_jobs WHERE document_id=? AND request_key=?').get(documentId,request.idempotencyKey);
      if(repeated){fail(repeated.request_hash===digest(request),'幂等键已被使用',409,'idempotency_conflict');return parse(repeated);}
      this.writable(documentId,owner);
      const current = this.project(documentId,owner,project.id); fail(current.revision === request.baseRevision,'原生工程已修改',409,'craft_revision_conflict');
      fail(this.store.db.prepare("SELECT count(*) AS n FROM craft_jobs WHERE document_id=? AND json_extract(json,'$.state') IN ('queued','running')").get(documentId).n < 100,'Craft 队列已满',429,'craft_queue_full');
      const now=timestamp(), value={id:randomUUID(),documentId,projectId:project.id,engineId:project.engineId,baseRevision:project.revision,state:'queued',stage:'queued',progress:0,createdAt:now,updatedAt:now,request:clone(request),owner,baseNativeAssetId:project.nativeAssetId||(options.importVerification?project.pendingImportAssetId:undefined),...(options.importVerification?{importVerification:true,expectPreview:options.expectPreview}:{}),metrics:{generationCalls:0,llmCalls:0,visionCalls:0}};
      this.store.db.prepare('INSERT INTO craft_jobs VALUES(?,?,?,?,?,?)').run(value.id,documentId,project.id,request.idempotencyKey,digest(request),json(value)); return value;
    });
    setImmediate(()=>void this.tick()); return publicJob(job);
  }
  record(documentId,owner,jobId) { this.store.getDocument(documentId,owner); const row=this.store.db.prepare('SELECT json FROM craft_jobs WHERE document_id=? AND id=?').get(documentId,jobId); fail(row,'Craft 任务不存在',404,'not_found'); return parse(row); }
  getJob(documentId,owner,jobId) { return this.jobView(this.record(documentId,owner,jobId),owner); }
  listJobs(documentId,owner) { this.store.getDocument(documentId,owner); return this.store.db.prepare('SELECT json FROM craft_jobs WHERE document_id=? ORDER BY rowid DESC LIMIT 200').all(documentId).map(row=>this.jobView(parse(row),owner)); }
  updateJob(job,patch) { const value={...job,...patch,updatedAt:timestamp()}; this.store.db.prepare('UPDATE craft_jobs SET json=? WHERE id=?').run(json(value),job.id); return value; }
  cancel(documentId,owner,jobId) { const job=this.record(documentId,owner,jobId); if(TERMINAL.has(job.state))return publicJob(job); const result=this.updateJob(job,{state:'cancelled',stage:'cancelled',finishedAt:timestamp()});this.active.get(jobId)?.controller.abort();return publicJob(result); }
  discard(documentId,owner,jobId) { return this.store.transaction(()=>{this.writable(documentId,owner);const job=this.record(documentId,owner,jobId);fail(job.state==='complete'&&job.acceptedRevision===undefined,'只可放弃尚未接受的已完成候选',409,'craft_candidate_not_discardable');return publicJob(this.updateJob(job,{state:'cancelled',stage:'candidate_discarded',discarded:true,output:{...job.output,needsAcceptance:false,discarded:true}}));}); }
  async retry(documentId,owner,jobId,request) {
    const job=this.record(documentId,owner,jobId);fail(!job.importedSource,'导入的来源回执不会重投，请明确发起新的原生操作',409,'craft_imported_receipt');fail(['failed','cancelled'].includes(job.state)&&job.acceptedRevision===undefined,'只可重试失败或已取消的任务',409,'craft_retry_unavailable');key(request.idempotencyKey);fail(request.idempotencyKey!==job.request.idempotencyKey,'重试需使用新的幂等键',409,'idempotency_conflict');
    const frozen={...job.request,idempotencyKey:request.idempotencyKey};
    if(job.output?.restoredFrom){const sourceRow=this.store.db.prepare('SELECT json FROM craft_projects WHERE id=?').get(job.output.restoredFrom.projectId),source=parse(sourceRow);fail(source,'恢复来源不存在',404,'not_found');return this.restoreRevision(documentId,owner,frozen,{...source,revision:job.output.restoredFrom.revision});}
    return this.submit(documentId,owner,frozen,{importVerification:job.importVerification,expectPreview:job.expectPreview});
  }
  start() {
    this.stopped=false;
    for(const row of this.store.db.prepare("SELECT json FROM craft_jobs WHERE json_extract(json,'$.state')='running'").all())this.updateJob(parse(row),{state:'queued',stage:'recovering'});
    this.timer=setInterval(()=>void this.tick(),200);this.timer.unref();void this.tick();
  }
  async stop() { this.stopped=true;clearInterval(this.timer); for(const {controller} of this.active.values())controller.abort();await Promise.allSettled([...this.active.values()].map(item=>item.promise)); }
  async tick() {
    if(this.stopped||this.active.size)return;
    const row=this.store.db.prepare("SELECT json FROM craft_jobs WHERE json_extract(json,'$.state')='queued' ORDER BY rowid LIMIT 1").get();if(!row)return;
    const job=parse(row),controller=new AbortController();
    const promise=this.run(job,controller.signal).finally(()=>{this.active.delete(job.id);if(!this.stopped)setImmediate(()=>void this.tick());});this.active.set(job.id,{controller,promise});await promise;
  }
  async run(job,signal) {
    const started=Date.now(),workDir=join(this.store.directory,'craft-work',job.id);
    job=this.updateJob(job,{state:'running',stage:'native_execution',startedAt:timestamp(),progress:0.1});
    try {
      rmSync(workDir,{recursive:true,force:true});mkdirSync(join(workDir,'input'),{recursive:true,mode:0o700});
      const inputFiles=(job.request.inputAssetIds||[]).map(id=>{const {asset,bytes}=this.store.getAsset(id,job.owner);const filename=`${id}-${nativeName(asset.name)}`,path=join(workDir,'input',filename);writeFileSync(path,bytes,{mode:0o600});return {assetId:id,filename,path};});
      let nativeFile;if(job.baseNativeAssetId){const {bytes}=this.store.getAsset(job.baseNativeAssetId,job.owner);nativeFile=join(workDir,'input.native.craftbundle');writeFileSync(nativeFile,bytes,{mode:0o600});}
      const result=await this.runtime.execute({engineId:job.engineId,workDir,steps:job.request.steps,inputFiles,nativeFile,signal});
      const latest=this.record(job.documentId,job.owner,job.id);if(latest.state==='cancelled'||signal.aborted)throw new ImageError('任务已取消',409,'CANCELLED');
      fail(result && result.checkpoint && Buffer.isBuffer(result.checkpoint.bytes),'引擎未返回可恢复的原生工程，结果未晋升',502,'craft_checkpoint_missing');
      const files=result.files||[];fail(Array.isArray(files)&&files.length<=64,'引擎输出文件过多',502,'craft_output_budget');
      if(job.importVerification&&job.expectPreview)fail(files.some(file=>file.role==='preview'&&file.mime?.startsWith('image/')),'导入工程未产生真实预览，已保留上传包而未接受',422,'craft_import_preview_required');
      fail(files.reduce((n,f)=>n+(f.bytes?.length||0),result.checkpoint.bytes.length)<=128*1024*1024,'引擎输出超过 128 MB',502,'craft_output_budget');
      this.store.transaction(()=>{
        const live=this.record(job.documentId,job.owner,job.id);fail(live.state==='running','任务已取消',409,'CANCELLED');
        const metadata={engineId:job.engineId,craftJobId:job.id,craftProjectId:job.projectId},inputs=[...(job.request.inputAssetIds||[]).map(assetId=>({assetId,role:'input'})),...(job.baseNativeAssetId?[{assetId:job.baseNativeAssetId,role:'native-base'}]:[])];
        const checkpoint=this.addAsset(job.documentId,job.owner,{name:result.checkpoint.name||'checkpoint.craftbundle',mime:result.checkpoint.mime,metadata:{...metadata,role:'native-checkpoint'},inputs},result.checkpoint.bytes);
        const assets=files.map(file=>({...this.addAsset(job.documentId,job.owner,{name:basename(file.name),mime:file.mime,metadata:{...metadata,role:file.role||'export',nativeOutputName:file.name},inputs},file.bytes),role:file.role||'export'}));
        const executionMs=Date.now()-started,receipt={...result.receipt};delete receipt.workDir;delete receipt.commandLine;
        const output={nativeAssetId:checkpoint.id,assets,assetIds:assets.map(a=>a.id),candidateRevision:job.baseRevision+1,needsAcceptance:true,result:result.result,state:result.state,receipt,warnings:result.warnings||[]};
        json(output);this.updateJob(live,{state:'complete',stage:'candidate_ready',progress:1,finishedAt:timestamp(),output,metrics:{...job.metrics,queueMs:started-Date.parse(job.createdAt),executionMs,totalMs:Date.now()-Date.parse(job.createdAt)}});
      });
    } catch(error) {
      const live=this.record(job.documentId,job.owner,job.id);
      if(this.stopped&&live.state!=='cancelled')this.updateJob(live,{state:'queued',stage:'recovering'});
      else if(live.state!=='cancelled')this.updateJob(live,{state:error.code==='CANCELLED'?'cancelled':'failed',stage:error.code==='CANCELLED'?'cancelled':'failed',error:String(error.message||'Craft 运行失败').slice(0,2000),code:error.code||'craft_failed',finishedAt:timestamp(),metrics:{...job.metrics,executionMs:Date.now()-started,totalMs:Date.now()-Date.parse(job.createdAt)}});
    } finally { rmSync(workDir,{recursive:true,force:true}); }
  }
  accept(documentId,owner,jobId,request) {
    return this.store.transaction(()=>{
      this.store.getDocument(documentId,owner);const old=this.receipt(documentId,`accept:${jobId}`,request.idempotencyKey,request);if(old)return old;this.writable(documentId,owner);
      const job=this.record(documentId,owner,jobId),project=this.project(documentId,owner,job.projectId);
      if(job.acceptedRevision!==undefined){const result=this.listRevisions(documentId,owner,project.id).find(p=>p.revision===job.acceptedRevision);this.saveReceipt(documentId,`accept:${jobId}`,request.idempotencyKey,request,result);return result;}
      fail(job.state==='complete'&&job.output?.nativeAssetId,'候选原生工程尚未完成',409,'craft_candidate_not_ready');
      fail(request.baseRevision===project.revision&&job.baseRevision===project.revision,'原生工程版本冲突，候选已保留',409,'craft_revision_conflict');
      const next={...project,revision:project.revision+1,nativeAssetId:job.output.nativeAssetId,assetIds:job.output.assetIds,updatedAt:timestamp(),lastJobId:job.id};delete next.pendingImportAssetId;
      this.saveProject(next);this.store.db.prepare('INSERT INTO craft_revisions VALUES(?,?,?)').run(project.id,next.revision,json(next));this.updateJob(job,{acceptedRevision:next.revision,accepted:true,output:{...job.output,needsAcceptance:false,accepted:true}});
      this.saveReceipt(documentId,`accept:${jobId}`,request.idempotencyKey,request,next);return next;
    });
  }
  restoreRevision(documentId,owner,request,sourceProject) {
    return this.store.transaction(()=>{
      this.writable(documentId,owner);key(request.idempotencyKey);
      const prior=this.store.db.prepare('SELECT * FROM craft_jobs WHERE document_id=? AND request_key=?').get(documentId,request.idempotencyKey);
      if(prior){fail(prior.request_hash===digest(request),'同一幂等键不能用于不同历史恢复',409,'idempotency_conflict');return publicJob(parse(prior));}
      const project=this.project(documentId,owner,request.projectId);fail(project.revision===request.baseRevision,'原生工程已修改，历史恢复草稿已保留',409,'craft_revision_conflict');
      const source=sourceProject||project;this.project(source.documentId,owner,source.id);fail(source.engineId===project.engineId,'原生历史引擎不一致',422,'craft_history_unavailable');fail(Number.isSafeInteger(request.revision)&&request.revision>=0&&request.revision<=source.revision,'无效的原生历史版本',422,'craft_history_unavailable');
      const row=this.store.db.prepare('SELECT json FROM craft_revisions WHERE project_id=? AND revision=?').get(source.id,request.revision),snapshot=parse(row);fail(snapshot?.nativeAssetId,'该历史版本还没有可恢复的原生工程',422,'craft_history_unavailable');
      const checkpoint=this.store.getAsset(snapshot.nativeAssetId,owner).asset,assets=(snapshot.assetIds||[]).map(id=>this.store.getAsset(id,owner).asset);
      this.store.linkAsset(documentId,checkpoint.id);for(const asset of assets)this.store.linkAsset(documentId,asset.id);
      const sourceJobRow=snapshot.lastJobId?this.store.db.prepare('SELECT json,document_id FROM craft_jobs WHERE id=?').get(snapshot.lastJobId):null;if(sourceJobRow)this.store.getDocument(sourceJobRow.document_id,owner);
      const sourceJob=parse(sourceJobRow),now=timestamp(),job={id:randomUUID(),documentId,projectId:project.id,engineId:project.engineId,baseRevision:project.revision,state:'complete',stage:'history_candidate_ready',progress:1,createdAt:now,updatedAt:now,finishedAt:now,owner,request:clone(request),metrics:{generationCalls:0,llmCalls:0,visionCalls:0,queueMs:0,executionMs:0,totalMs:0},output:{nativeAssetId:checkpoint.id,assetIds:assets.map(a=>a.id),assets:assets.map(asset=>({...asset,role:asset.metadata?.role||'export'})),state:sourceJob?.output?.state,candidateRevision:project.revision+1,needsAcceptance:true,restoredFrom:{projectId:source.id,revision:request.revision,checkpointHash:checkpoint.hash},receipt:{processor:'native-revision-restore',externalModelCalls:0},warnings:[]}};
      this.store.db.prepare('INSERT INTO craft_jobs VALUES(?,?,?,?,?,?)').run(job.id,documentId,project.id,request.idempotencyKey,digest(request),json(job));return publicJob(job);
    });
  }
  async restoreAgent(runner,agentJobId,documentId,owner,args,namespace) {
    if(runner.cancelled(agentJobId))throw new ImageError('任务已取消',409,'CANCELLED');
    const project=this.store.transaction(()=>this.forkForAgent(documentId,owner,args.projectId)),history=args.history||'source';fail(['source','branch'].includes(history),'invalid history scope');
    let source=project;if(history==='source'&&project.parentProjectId){const doc=this.store.getDocument(documentId,owner);source={...this.project(doc.parentDocumentId,owner,project.parentProjectId),revision:project.parentProjectRevision};}
    const idempotencyKey=`agent:${agentJobId}:${namespace}`,prior=this.store.db.prepare('SELECT json FROM craft_jobs WHERE document_id=? AND request_key=?').get(documentId,idempotencyKey);
    const job=prior?publicJob(parse(prior)):this.restoreRevision(documentId,owner,{projectId:project.id,revision:args.revision,baseRevision:project.revision,idempotencyKey},source);
    if(runner.cancelled(agentJobId))throw new ImageError('任务已取消',409,'CANCELLED');
    const accepted=this.accept(documentId,owner,job.id,{baseRevision:job.baseRevision,idempotencyKey});return {craftJobId:job.id,project:accepted,output:job.output,needsReview:true,message:'历史恢复已保存为任务分支候选，接受后才会更新主工程。'};
  }
  async agentCapabilities(documentId,owner,args={}) {
    if(args.projectId){const project=this.forkForAgent(documentId,owner,args.projectId),doc=this.store.getDocument(documentId,owner);return {project,branchRevisions:this.listRevisions(documentId,owner,project.id),sourceRevisions:project.parentProjectId?this.listRevisions(doc.parentDocumentId,owner,project.parentProjectId).filter(p=>p.revision<=project.parentProjectRevision):[]};}
    const engines=args.engineId&&this.runtime.engineCapability?[await this.runtime.engineCapability(args.engineId)].filter(Boolean):(await this.capabilities()).engines;
    if(!args.engineId)return {engines:engines.map(({id,name,available,reason,nativeExtension,version})=>({id,name,available,reason,nativeExtension,version})),projects:this.agentProjects(documentId,owner)};
    const engine=engines.find(e=>e.id===args.engineId);fail(engine,'未知 Craft 引擎',422,'craft_unknown_engine');
    const offset=args.offset??0,limit=args.limit??30;fail(Number.isSafeInteger(offset)&&offset>=0&&Number.isSafeInteger(limit)&&limit>0&&limit<=40,'invalid catalog page');
    const search=String(args.search||'').slice(0,100).toLowerCase(),items=[...(engine.tools||[]).map(t=>({...t,catalogKind:'tool'})),...(engine.commands||[]).map(c=>({...c,catalogKind:'command'}))].filter(item=>!search||JSON.stringify(item).toLowerCase().includes(search));
    const page=items.slice(offset,offset+limit);let bytes=0;const bounded=[];for(const item of page){const length=Buffer.byteLength(JSON.stringify(item));if(bytes+length>128*1024)break;bytes+=length;bounded.push(item);}
    return {engineId:engine.id,available:engine.available,reason:engine.reason,nativeExtension:engine.nativeExtension,total:items.length,offset,items:bounded,nextOffset:offset+bounded.length<items.length?offset+bounded.length:null};
  }
  ensureAgentSnapshot(documentId,owner) {
    const doc=this.store.getDocument(documentId,owner);if(!doc.parentDocumentId)return;
    this.store.transaction(()=>{
      if(this.store.db.prepare("SELECT 1 FROM craft_receipts WHERE document_id=? AND kind='branch-snapshot'").get(documentId))return;
      const sources=this.listProjects(doc.parentDocumentId,owner),now=timestamp();
      for(const source of sources){
        const project={...source,id:randomUUID(),documentId,revision:0,parentProjectId:source.id,parentProjectRevision:source.revision,createdAt:now,updatedAt:now};
        this.store.db.prepare('INSERT INTO craft_projects VALUES(?,?,?,?)').run(project.id,documentId,project.engineId,json(project));this.store.db.prepare('INSERT INTO craft_revisions VALUES(?,?,?)').run(project.id,0,json(project));
      }
      this.saveReceipt(documentId,'branch-snapshot','initial',{parentDocumentId:doc.parentDocumentId},{capturedAt:now,projects:sources.map(p=>({id:p.id,revision:p.revision}))});
    });
  }
  agentProjects(documentId,owner) { this.ensureAgentSnapshot(documentId,owner);return this.listProjects(documentId,owner); }
  forkForAgent(documentId,owner,projectId) {
    const doc=this.store.getDocument(documentId,owner);fail(doc.parentDocumentId,'AI Craft 编辑必须在任务分支执行',409,'craft_branch_required');
    this.ensureAgentSnapshot(documentId,owner);
    const project=this.listProjects(documentId,owner).find(p=>p.id===projectId||p.parentProjectId===projectId);
    fail(project,'原生工程不在此任务的冻结快照内，请从主工程发起新任务',404,'craft_project_snapshot_missing');return project;
  }
  async executeAgent(runner,agentJobId,documentId,owner,args,namespace) {
    const idempotencyKey=`agent:${agentJobId}:${namespace}`;
    const doc=this.store.getDocument(documentId,owner);fail(doc.parentDocumentId,'AI Craft 编辑必须在任务分支执行',409,'craft_branch_required');
    const project=args.projectId?this.store.transaction(()=>this.forkForAgent(documentId,owner,args.projectId)):await this.createProject(documentId,owner,{engineId:args.engineId,name:args.name,idempotencyKey});
    const request={projectId:project.id,baseRevision:args.baseRevision??project.revision,steps:args.steps,inputAssetIds:args.inputAssetIds||[],idempotencyKey};
    // Recover the frozen request, including its pre-edit native revision, after a lost tool response.
    const prior=this.store.db.prepare('SELECT json FROM craft_jobs WHERE document_id=? AND request_key=?').get(documentId,idempotencyKey);
    let job=prior?publicJob(parse(prior)):await this.submit(documentId,owner,request);
    while(!TERMINAL.has(job.state)){
      if(runner.cancelled(agentJobId)){this.cancel(documentId,owner,job.id);throw new ImageError('任务已取消',409,'CANCELLED');}
      await new Promise(resolve=>setTimeout(resolve,100));job=this.getJob(documentId,owner,job.id);
    }
    if(runner.cancelled(agentJobId))throw new ImageError('任务已取消',409,'CANCELLED');
    if(job.state!=='complete')throw new ImageError(job.error||'Craft 任务未完成',422,job.code||'craft_failed');
    const accepted=this.accept(documentId,owner,job.id,{baseRevision:job.baseRevision,idempotencyKey});
    return {craftJobId:job.id,project:accepted,output:job.output,needsReview:true,message:'原生工程候选仅写入任务分支，接受整个候选后才更新主工程。'};
  }
  /** Runs inside ImageStore.acceptBranch BEGIN IMMEDIATE, so image/native conflicts roll back together. */
  acceptImageBranch(documentId,owner,branchDocumentId,agentProducers=[]) {
    this.store.getDocument(branchDocumentId,owner);
    fail(!this.store.db.prepare("SELECT 1 FROM craft_jobs WHERE document_id=? AND json_extract(json,'$.state') IN ('queued','running') LIMIT 1").get(branchDocumentId),'原生候选仍在执行，图片与原生工程均未接受',409,'craft_candidate_not_ready');
    fail(!this.store.db.prepare("SELECT 1 FROM craft_jobs WHERE document_id=? AND json_extract(json,'$.state')='complete' AND json_extract(json,'$.acceptedRevision') IS NULL LIMIT 1").get(branchDocumentId),'请先接受或放弃原生候选，再接受整个任务分支',409,'craft_native_acceptance_required');
    const projects=this.listProjects(branchDocumentId,owner).filter(p=>p.revision>0);
    const reviewed=values=>values.map(project=>({id:project.id,revision:project.revision,nativeAssetId:project.nativeAssetId,lastJobId:project.lastJobId})).sort((a,b)=>a.id.localeCompare(b.id));
    for(const producer of agentProducers){const expected=producer.output?.craftProjects||[];fail(Array.isArray(expected)&&digest(reviewed(expected))===digest(reviewed(projects)),'原生候选已在预览后修改，请重新生成并审查任务候选；主工程未更新',409,'craft_candidate_stale');}
    for(const project of projects){
      if(project.parentProjectId){const source=this.project(documentId,owner,project.parentProjectId);fail(source.revision===project.parentProjectRevision,'原生工程已修改，图片与原生候选均未接受',409,'craft_branch_conflict');}
    }
    for(const project of projects){
      const native=this.store.getAsset(project.nativeAssetId,owner).asset;this.store.linkAsset(documentId,native.id);for(const id of project.assetIds||[])this.store.linkAsset(documentId,id);
      if(project.parentProjectId){const source=this.project(documentId,owner,project.parentProjectId),next={...source,revision:source.revision+1,nativeAssetId:project.nativeAssetId,assetIds:project.assetIds,lastJobId:project.lastJobId,updatedAt:timestamp()};this.saveProject(next);this.store.db.prepare('INSERT INTO craft_revisions VALUES(?,?,?)').run(next.id,next.revision,json(next));}
      else {const next={...project,id:randomUUID(),documentId,revision:1,acceptedFromProjectId:project.id};this.store.db.prepare('INSERT INTO craft_projects VALUES(?,?,?,?)').run(next.id,documentId,next.engineId,json(next));this.store.db.prepare('INSERT INTO craft_revisions VALUES(?,?,?)').run(next.id,1,json(next));}
    }
  }
}

export async function routeCraft(service,parts,method,owner,readBody) {
  const documentId=parts[1],tail=parts.slice(3);
  if(tail[0]==='capabilities'&&tail.length===1&&method==='GET')return service.capabilities();
  if(tail[0]==='assets'&&tail.length===1&&method==='POST') { const body=await readBody(),encoded=String(body.data||'').replace(/^data:[^;,]+;base64,/,'');fail(encoded.length>0&&encoded.length%4===0&&/^[A-Za-z0-9+/]+={0,2}$/.test(encoded),'invalid base64');return service.addAsset(documentId,owner,body,Buffer.from(encoded,'base64')); }
  if(tail[0]==='projects'){
    if(tail.length===1&&method==='GET')return service.listProjects(documentId,owner).map(project=>service.projectView(documentId,owner,project.id));
    if(tail.length===1&&method==='POST')return service.createProject(documentId,owner,await readBody());
    if(tail.length===2&&method==='GET')return service.projectView(documentId,owner,tail[1]);
    if(tail.length===3&&tail[2]==='restore'&&method==='POST')return service.restoreRevision(documentId,owner,{...await readBody(),projectId:tail[1]});
    if(tail.length===3&&tail[2]==='revisions'&&method==='GET')return service.listRevisions(documentId,owner,tail[1]);
  }
  if(tail[0]==='jobs'){
    if(tail.length===1&&method==='GET')return service.listJobs(documentId,owner);
    if(tail.length===1&&method==='POST')return service.submit(documentId,owner,await readBody());
    if(tail.length===2&&method==='GET')return service.getJob(documentId,owner,tail[1]);
    if(tail.length===3&&tail[2]==='retry'&&method==='POST')return service.retry(documentId,owner,tail[1],await readBody());
    if(tail.length===3&&tail[2]==='discard'&&method==='POST')return service.discard(documentId,owner,tail[1]);
    if(tail.length===3&&tail[2]==='cancel'&&method==='POST')return service.cancel(documentId,owner,tail[1]);
    if(tail.length===3&&tail[2]==='accept'&&method==='POST')return service.accept(documentId,owner,tail[1],await readBody());
  }
  throw new ImageError('Craft route not found',404,'not_found');
}
