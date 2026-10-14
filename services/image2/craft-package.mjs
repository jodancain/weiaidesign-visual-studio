import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fail, clone, digest, timestamp, validId } from './domain.mjs';
import { craftEngine } from './craft-catalog.mjs';
import { restoreCraftBundle } from './craft-runtime.mjs';

const LIMIT = 2 * 1024 * 1024, MAX_RECORDS = 2000;
const check = (ok, message) => fail(ok, message, 422, 'CRAFT_PACKAGE_INVALID');
const parse = row => row && JSON.parse(row.json);
const descriptor = project => Object.fromEntries(['id','engineId','name','revision','nativeAssetId','assetIds','lastJobId','importSourceAssetId','pendingImportAssetId','createdAt','updatedAt'].filter(key => project[key] !== undefined).map(key => [key, clone(project[key])]));
const compactOutput = output => output && Object.fromEntries(['nativeAssetId','assetIds','result','state','receipt','warnings','restoredFrom'].filter(key => output[key] !== undefined).map(key => [key, clone(output[key])]));
const checkBudget = value => check(Buffer.byteLength(JSON.stringify(value)) <= LIMIT, '原生工程历史清单超过 2 MB；请拆分工程后导出');

/** Called synchronously inside the export submission transaction, before any asynchronous work. */
export function freezeCraftPackage(store, documentId, owner) {
  if (!store.craftService) return undefined;
  const craft = store.craftService, projects = craft.listProjects(documentId, owner);
  if (!projects.length) return undefined;
  check(projects.length <= 100, '原生工程数量超过 100');
  const ids = new Set(), receipts = new Map(); let count = 0;
  const addAsset = id => {
    if (!id || ids.has(id)) return;
    check(ids.size < 1999, '原生工程依赖素材超过工程包上限');
    const { asset } = store.getAsset(id, owner); ids.add(id);
    for (const input of asset.inputs || []) addAsset(input.assetId);
  };
  const addJob = (job, projectId, acceptedRevision) => {
    const previous = receipts.get(job.id);
    check(!previous || previous.projectId === projectId, '原生回执关联多个工程，无法安全导出');
    const record = { id: job.id, projectId, engineId: job.engineId, source: { documentId: job.documentId, projectId: job.projectId, jobId: job.id, state: job.state,...(job.importedSource?{importedSource:clone(job.importedSource)}:{}) }, createdAt: job.createdAt, output: compactOutput(job.output), ...(acceptedRevision === undefined ? {} : { acceptedRevision }) };
    if (previous?.acceptedRevision !== undefined && acceptedRevision === undefined) return;
    check(receipts.has(job.id) || receipts.size < MAX_RECORDS, '原生回执数量超过工程包上限'); receipts.set(job.id, record);
    addAsset(job.baseNativeAssetId); for (const id of job.request?.inputAssetIds || []) addAsset(id);
    addAsset(job.output?.nativeAssetId); for (const id of job.output?.assetIds || []) addAsset(id);
  };
  const records = projects.map(project => {
    const revisions = craft.listRevisions(documentId, owner, project.id).filter(revision => revision.revision <= project.revision).sort((a,b) => a.revision-b.revision);
    count += revisions.length; check(count <= MAX_RECORDS, '原生历史版本超过工程包上限');
    for (const snapshot of [project, ...revisions]) {
      addAsset(snapshot.nativeAssetId); addAsset(snapshot.importSourceAssetId); addAsset(snapshot.pendingImportAssetId);
      for (const id of snapshot.assetIds || []) addAsset(id);
      if (snapshot.lastJobId) {
        const row = store.db.prepare('SELECT json,document_id FROM craft_jobs WHERE id=?').get(snapshot.lastJobId);
        check(row, '原生历史缺少来源回执'); store.getDocument(row.document_id, owner);
        addJob(parse(row), project.id, snapshot.revision);
      }
    }
    for (const row of store.db.prepare('SELECT json FROM craft_jobs WHERE document_id=? AND project_id=? ORDER BY rowid').all(documentId, project.id)) addJob(parse(row), project.id);
    return { project: descriptor(project), revisions: revisions.map(descriptor) };
  });
  const result = { version: 1, capturedAt: timestamp(), assetIds: [...ids], projects: records, sourceReceipts: [...receipts.values()] };
  checkBudget(result); return result;
}

export function craftPackageAssetIds(extension) { return extension?.assetIds || []; }

/** Validate untrusted package data and checkpoints before creating the destination document. */
export async function prepareCraftPackage(store, manifest, files) {
  const extension = manifest.craft;
  if (extension === undefined) return undefined;
  check(store.craftService, '原生工程服务尚未启用，工程包未部分导入');
  check(extension && extension.version === 1 && Array.isArray(extension.projects) && extension.projects.length <= 100 && Array.isArray(extension.sourceReceipts) && extension.sourceReceipts.length <= MAX_RECORDS && Array.isArray(extension.assetIds) && extension.assetIds.length <= 1999, '原生工程扩展格式或数量无效');
  checkBudget(extension);
  const assets = new Map(manifest.assets.map(asset => [asset.id, asset])), allowed = new Set(extension.assetIds), projectIds = new Map(), receiptIds = new Map(), checkpoints = new Map();
  check(allowed.size === extension.assetIds.length && [...allowed].every(id => validId(id) && assets.has(id)), '原生素材必须来自当前工程包');
  for (const id of allowed) for (const input of assets.get(id).inputs || []) check(allowed.has(input.assetId), '原生素材依赖不在冻结工程包内');
  const assetRef = (id, engineId, checkpoint = false) => { if (id === undefined) return; check(validId(id) && allowed.has(id), '原生历史引用包外素材'); if (checkpoint) { check(!checkpoints.has(id) || checkpoints.get(id) === engineId, '同一检查点被声明为不同引擎'); checkpoints.set(id,engineId); } };
  const validateDescriptor = (value, project) => {
    check(value && value.id === project.id && value.engineId === project.engineId && Number.isSafeInteger(value.revision) && value.revision >= 0 && value.revision <= 1000000 && typeof value.name === 'string' && value.name.length <= 200, '原生工程或历史身份无效');
    for (const field of ['nativeAssetId','importSourceAssetId','pendingImportAssetId']) assetRef(value[field],value.engineId,true);
    check(value.assetIds === undefined || (Array.isArray(value.assetIds) && value.assetIds.length <= 64), '原生导出素材数量无效'); for (const id of value.assetIds || []) assetRef(id,value.engineId);
    if(value.lastJobId !== undefined)check(validId(value.lastJobId), '原生来源回执身份无效');
  };
  let revisionCount = 0;
  for (const record of extension.projects) {
    const project = record?.project;let engine;try{engine=craftEngine(project?.engineId);}catch{/* Reject unknown engines without running discovery. */}check(project && validId(project.id) && !assets.has(project.id) && !projectIds.has(project.id) && engine, '原生工程引擎或身份无效'); projectIds.set(project.id,randomUUID());
    check(Array.isArray(record.revisions) && record.revisions.length > 0, '原生工程缺少历史');revisionCount+=record.revisions.length;check(revisionCount<=MAX_RECORDS,'原生历史数量超限');
    const revisions = new Set(); for(const snapshot of record.revisions){validateDescriptor(snapshot,project);check(snapshot.revision<=project.revision&&!revisions.has(snapshot.revision),'原生历史版本重复或越界');revisions.add(snapshot.revision);}
    validateDescriptor(project,project);const last=record.revisions.find(r=>r.revision===project.revision);check(last&&digest(descriptor(last))===digest(descriptor(project)),'原生当前状态与最后历史不一致');
  }
  const receipts = new Map();
  for (const receipt of extension.sourceReceipts) {
    check(receipt && validId(receipt.id) && !assets.has(receipt.id) && !projectIds.has(receipt.id) && !receiptIds.has(receipt.id) && projectIds.has(receipt.projectId), '原生来源回执无效');const record=extension.projects.find(p=>p.project.id===receipt.projectId);check(receipt.engineId===record.project.engineId,'原生回执引擎不一致');
    receiptIds.set(receipt.id,randomUUID());receipts.set(receipt.id,receipt);
    if(receipt.output){assetRef(receipt.output.nativeAssetId,receipt.engineId,true);check(Array.isArray(receipt.output.assetIds)&&receipt.output.assetIds.length<=64,'原生回执素材无效');for(const id of receipt.output.assetIds)assetRef(id,receipt.engineId);}
    if(receipt.acceptedRevision!==undefined){const revision=record.revisions.find(r=>r.revision===receipt.acceptedRevision);check(revision?.lastJobId===receipt.id&&revision.nativeAssetId===receipt.output?.nativeAssetId&&digest(revision.assetIds||[])===digest(receipt.output?.assetIds||[]),'原生已接受回执与历史不一致');}
  }
  for(const {project,revisions} of extension.projects)for(const value of [project,...revisions])if(value.lastJobId){const receipt=receipts.get(value.lastJobId);check(receipt?.projectId===project.id&&receipt.acceptedRevision===value.revision,'原生历史来源回执缺失');}
  const directory=mkdtempSync(join(tmpdir(),'craft-package-check-'));let expanded=0;
  try { for (const [id,engineId] of checkpoints) { const asset=assets.get(id),bytes=Buffer.from(files[asset.file]||[]);check(bytes.length>0&&digest(bytes)===asset.hash,'原生检查点hash不匹配');const work=join(directory,id);mkdirSync(work);const path=join(directory,`${id}.craftbundle`);writeFileSync(path,bytes);const bundle=await restoreCraftBundle(path,work,engineId);expanded+=bundle.files.reduce((sum,file)=>sum+Buffer.byteLength(file.data,'base64'),0);check(expanded<=128*1024*1024,'原生检查点解压总量超过128MB');rmSync(work,{recursive:true,force:true}); } } finally { rmSync(directory,{recursive:true,force:true}); }
  return { extension, allowed, projectIds, receiptIds };
}

export function craftImportMetadataRef(plan, key, value) {
  const ids=key==='craftProjectId'?plan?.projectIds:key==='craftJobId'?plan?.receiptIds:undefined;
  if(!ids)return undefined;
  return ids.get(value) || value;
}
export function isCraftOpaqueAsset(plan, asset) { return plan?.allowed.has(asset.id) && ['application/octet-stream','audio/wav','audio/aiff','audio/flac','video/mp4'].includes(asset.mime); }

/** Runs inside the same transaction as image/asset history import. No jobs are scheduled. */
export function installCraftPackage(store, documentId, owner, plan, assetIds) {
  if(!plan)return undefined;
  const now=timestamp(),mapAsset=id=>id===undefined?undefined:assetIds.get(id),sourceInfo={importedAt:now,packageCapturedAt:plan.extension.capturedAt};
  const mapDescriptor = value => {
    const project={...descriptor(value),id:plan.projectIds.get(value.id),documentId,createdAt:now,updatedAt:now,importedSource:{...sourceInfo,projectId:value.id,revision:value.revision,...(value.pendingImportAssetId?{pendingImportAssetId:value.pendingImportAssetId}: {})}};
    for(const key of ['nativeAssetId','importSourceAssetId'])if(value[key])project[key]=mapAsset(value[key]);
    project.assetIds=(value.assetIds||[]).map(mapAsset);if(value.lastJobId)project.lastJobId=plan.receiptIds.get(value.lastJobId);delete project.pendingImportAssetId;return project;
  };
  for(const {project,revisions} of plan.extension.projects){const next=mapDescriptor(project);store.db.prepare('INSERT INTO craft_projects VALUES(?,?,?,?)').run(next.id,documentId,next.engineId,JSON.stringify(next));for(const revision of revisions)store.db.prepare('INSERT INTO craft_revisions VALUES(?,?,?)').run(next.id,revision.revision,JSON.stringify(mapDescriptor(revision)));}
  for(const receipt of plan.extension.sourceReceipts){
    const id=plan.receiptIds.get(receipt.id),projectId=plan.projectIds.get(receipt.projectId),accepted=receipt.acceptedRevision!==undefined;
    let output;if(receipt.output){const nativeAssetId=mapAsset(receipt.output.nativeAssetId),ids=receipt.output.assetIds.map(mapAsset);output={...compactOutput(receipt.output),nativeAssetId,assetIds:ids,assets:ids.map(id=>{const asset=store.getAsset(id,owner).asset;return {...asset,role:asset.metadata?.role||'export'};}),needsAcceptance:false,accepted,discarded:!accepted};}
    const request={projectId,baseRevision:Math.max(0,(receipt.acceptedRevision||0)-1),idempotencyKey:`imported:${id}`,steps:[],inputAssetIds:[]},job={id,documentId,projectId,engineId:receipt.engineId,state:accepted?'complete':'cancelled',stage:'imported_source_receipt',progress:1,createdAt:now,updatedAt:now,finishedAt:now,owner,request,baseRevision:request.baseRevision,importedSource:{...sourceInfo,...clone(receipt.source),jobId:receipt.id},...(accepted?{acceptedRevision:receipt.acceptedRevision,accepted:true}:{}),output,metrics:{generationCalls:0,llmCalls:0,visionCalls:0}};
    store.db.prepare('INSERT INTO craft_jobs VALUES(?,?,?,?,?,?)').run(id,documentId,projectId,request.idempotencyKey,digest(request),JSON.stringify(job));
  }
  return {...sourceInfo,projectIds:Object.fromEntries(plan.projectIds),receiptIds:Object.fromEntries(plan.receiptIds)};
}
