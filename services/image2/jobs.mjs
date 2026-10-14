import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fontkit from 'fontkit';
import { fail, ImageError, digest, clone,applyCommands } from './domain.mjs';
import { registry, executeOperation, inspectAsset, capabilities as processorCapabilities } from './processors.mjs';
import { executeV3Operation, validateV3Operation, V3_CPU_OPERATIONS } from './processors-v3.mjs';
import { exportV3Document, importV3Project, validateV3Export, readProjectArchive } from './exports-v3.mjs';
import { resolveNodeResource, createNodeResolver } from './render-node.mjs';
import { configFromEnv } from './providers.mjs';
import { ImageAgent, agentConfig } from './agent.mjs';
import {allowedAgentOperations,buildAgentTools,assertAgentProtectedLayers} from './agent-control.mjs';
import { exportDocument, importProjectBundle, scopedExportDocument, exportCanvasBounds } from './exports.mjs';
import { freezeCraftPackage } from './craft-package.mjs';

export class ImageRunner {
  constructor({ store, config = {}, fetchImpl = fetch, processor = executeOperation }) {
    this.store = store; this.config = { ...configFromEnv(), ...config, agent: { ...agentConfig(), ...config.agent } };
    if (config.agent && ('baseUrl' in config.agent || 'apiKey' in config.agent) && !('upstreams' in config.agent)) this.config.agent.upstreams = undefined;
    this.fetchImpl = fetchImpl; this.processor = processor;
    this.active = new Set(); this.stopped = true; this.agent = new ImageAgent(this); this.capabilityCache = null;
  }
  async capabilities() {
    if (this.capabilityCache && Date.now() - this.capabilityCache.at < 15000) return this.capabilityCache.value;
    const c = await processorCapabilities(this.config, this.fetchImpl);
    const value = { ...c, operations: c.operations.map(op => ({ ...op, name: op.operation, available: op.available })), agent: { available: Boolean(this.config.agent.baseUrl && this.config.agent.apiKey), model: this.config.agent.models[0],models:[...new Set((this.config.agent.upstreams||[{models:this.config.agent.models}]).flatMap(upstream=>upstream.models||[]))], maxRounds: 6, maxGenerations: this.config.agent.maxGenerations }, ocr: c.providers.ocr, defaultFont: { available: existsSync(this.defaultFontPath()), family: 'Noto Sans CJK SC' }, limits: { bodyBytes: 96 * 1024 * 1024, inputPixels: 40000000, restorePixels: 16000000, imageCount: 4 } };
    const professionalOperations=allowedAgentOperations({schemaVersion:3}),agentAvailable=Boolean(this.config.agent.baseUrl&&this.config.agent.apiKey);
    value.professional = {schemaVersion:3,operations:professionalOperations.map(operation=>({operation,executionClass:'cpu',available:true})),agent:{available:agentAvailable,reason:agentAvailable?'configured_cpu_control_only':'agent_unavailable',executionClasses:['cpu'],model:value.agent.model,models:value.agent.models,allowedOperations:professionalOperations,tools:buildAgentTools({schemaVersion:3}).map(tool=>tool.function.name)},models:{available:false},maskedPixelOperations:{available:false,requiresExplicitBake:true},exports:['png','pdf','svg','project'],svgExportMode:'appearance-proxy'};
    this.capabilityCache = { at: Date.now(), value }; return value;
  }
  defaultFontPath() { return this.config.defaultFontPath || fileURLToPath(new URL('./fonts/NotoSansCJKsc-Regular.otf', import.meta.url)); }
  defaultFont(owner, documentId) {
    this.store.getDocument(documentId, owner);
    const path = this.defaultFontPath(); fail(existsSync(path), '内置中文字体尚未安装，请上传字体', 503, 'font_unavailable');
    const bytes = readFileSync(path), font = fontkit.create(bytes);
    const old = this.store.listAssets(documentId, owner).find(a => a.mime === 'font/otf' && a.hash === digest(bytes));
    return old || this.store.addAsset(documentId, owner, { name: 'NotoSansCJKsc-Regular.otf', mime: 'font/otf', metadata: { family: font.familyName, postscriptName: font.postscriptName, builtin: true, license: 'SIL OFL 1.1' } }, bytes);
  }
  start() {
    this.stopped = false;
    for (const id of this.store.pendingJobs()) {
      const r = this.store.jobRecord(id);
      if (r.job.state === 'running') {
        const receipt = r.private.providerReceipt;
        const agentUnknown = r.private.agentState?.phase === 'llm_submitting';
        const toolUnknown = Object.values(r.private.toolStates || {}).some(s => s.providerReceipt?.provider === 'image' && s.providerReceipt.phase === 'submitting');
        if (agentUnknown || toolUnknown || (receipt?.provider === 'image' && receipt.phase === 'submitting')) {
          this.store.updateJob(id, { state: 'uncertain', stage: 'acceptance_unknown', error: '模型接收状态未知，已停止自动重投', retryable: false });
          if (r.private.input.runId) this.store.updateRun(r.private.input.runId, { state: 'uncertain', error: '模型接收状态未知，任务分支已保留' });
        } else this.store.updateJob(id, { state: 'queued', stage: 'resuming' });
      }
    }
    this.timer = setInterval(() => void this.tick(), 200); this.timer.unref(); void this.tick();
  }
  async stop() { this.stopped = true; clearInterval(this.timer); await Promise.allSettled([...this.activePromises || []]); }
  cancelled(id) { return this.store.jobRecord(id).private.cancelRequested === true; }
  async submit(owner, request) {
    fail(request && registry[request.operation] && request.operation !== 'export', '未知图片操作');
    const doc = this.store.getDocument(request.documentId, owner);
    const frozenRequest = { ...request, params: request.params || {}, inputs: request.inputs || [], mode: request.mode || (registry[request.operation].executionClass === 'generation' || request.operation === 'restore_layers' ? 'candidate' : 'apply') };
    const job = this.store.transaction(() => {
      const j = this.store.createJob(doc.id, owner, { kind: 'operation', idempotencyKey: request.idempotencyKey, input: frozenRequest });
      if (this.store.jobRecord(j.id).private.snapshot) return this.store.getJob(j.id, owner);
      fail(request.baseRevision === doc.revision, '工程已修改，请刷新后提交', 409, 'revision_conflict');
      this.validateOperation(doc, owner, request);
      this.store.updateJob(j.id, {}, { snapshot: clone(doc) });
      if (frozenRequest.mode === 'candidate') {
        const branch = this.store.createBranch(doc.id, owner, { baseRevision: doc.revision, metadata: { candidateJobId: j.id } });
        this.store.updateJob(j.id, { output: { branchDocumentId: branch.id } }, { branchDocumentId: branch.id, targetSourceRevision: branch.revision });
      }
      return this.store.getJob(j.id, owner);
    });
    setImmediate(() => void this.tick()); return this.store.getJob(job.id, owner);
  }
  validateOperation(doc, owner, request) {
    if(doc.schemaVersion===3){
      fail(['apply','candidate'].includes(request.mode||'apply'),'invalid operation mode');
      fail(Array.isArray(request.inputs||[])&&(request.inputs||[]).length<=100,'invalid operation inputs');
      for(const input of request.inputs||[]){const {asset}=this.store.getAsset(input.assetId,owner);fail(doc.assetIds.includes(asset.id),'输入素材不在当前工程',422);fail(!input.hash||input.hash===asset.hash,'输入素材hash不匹配',409,'source_changed');}
      const {target}=validateV3Operation(doc,request);let cursor=target;
      while(cursor){fail(!cursor.locked,'目标图层或所属组已锁定',409,'layer_locked');cursor=doc.layers.find(layer=>layer.id===cursor.parentId);}
      return;
    }
    for (const input of request.inputs || []) { const { asset } = this.store.getAsset(input.assetId, owner); fail(doc.assetIds.includes(asset.id), '输入素材不在当前工程', 422); }
    if (!request.targetLayerId) return;
    const layer = doc.layers.find(l => l.id === request.targetLayerId);
    fail(layer, '目标图层不存在', 404);
    let cursor = layer;
    while (cursor) { fail(!cursor.locked, '目标图层或所属组已锁定', 409, 'layer_locked'); cursor = doc.layers.find(l => l.id === cursor.parentId); }
    fail(['raster', 'mask'].includes(layer.type) || (layer.type === 'text' && layer.metadata?.fontConfirmed !== true), '文字、矢量和组请直接编辑图层属性，像素处理只用于位图', 422, 'typed_layer_required');
  }
  async submitRun(owner, conversationId, body) {
    const conversation = this.store.getConversation(conversationId, owner);
    if(this.store.getDocument(conversation.documentId,owner).schemaVersion===3)fail(this.config.agent.baseUrl&&this.config.agent.apiKey,'专业工程聊天模型尚未配置；未提交模型任务',422,'V3_OPERATION_UNAVAILABLE');
    const result = this.store.transaction(() => {
    const run = this.store.createRun(conversationId, owner, { text: body.text, references: body.references || [], idempotencyKey: body.idempotencyKey, ...(body.model===undefined?{}:{model:body.model}) });
    if (run.jobId) return { run, job: this.store.getJob(run.jobId, owner) };
    if(body.model!==undefined){const configured=(this.config.agent.upstreams||[{models:this.config.agent.models}]).flatMap(upstream=>upstream.models||[]);fail(typeof body.model==='string'&&configured.includes(body.model),'所选聊天模型不在已配置模型列表中',422,'agent_model_unavailable');}
    const doc = this.store.getDocument(conversation.documentId, owner);
    this.store.addMessage(conversationId, owner, { role: 'user', text: body.text, references: body.references || [], idempotencyKey: `run-user:${run.id}` });
    const branch = this.store.createBranch(doc.id, owner, { baseRevision: doc.revision, metadata: { runId: run.id } });
    this.store.craftService?.ensureAgentSnapshot(branch.id,owner);
    const job = this.store.createJob(doc.id, owner, { kind: 'agent', idempotencyKey: `run:${run.id}`, input: { runId: run.id, text: body.text, references: body.references || [],...(body.model===undefined?{}:{model:body.model}) } });
    this.store.updateJob(job.id, { output: { branchDocumentId: branch.id } }, { snapshot: clone(doc), branchDocumentId: branch.id,conversationMessageIds:this.store.listMessages(conversationId,owner).map(message=>message.id) });
    const saved = this.store.updateRun(run.id, { jobId: job.id, branchDocumentId: branch.id });
    return { run: saved, job: this.store.getJob(job.id, owner) };
    });
    setImmediate(() => void this.tick()); return result;
  }
  async export(owner, body) {
    const doc = this.store.getDocument(body.documentId, owner);
    fail(['png','svg','pdf','project'].includes(body.format), '不支持的导出格式');
    const job = this.store.transaction(() => {
    const job = this.store.createJob(doc.id, owner, { kind: 'export', idempotencyKey: body.idempotencyKey, input: body });
    if (!this.store.jobRecord(job.id).private.snapshot) {
      fail(body.baseRevision === doc.revision, '工程已修改，请刷新后导出', 409, 'revision_conflict');
      if (body.format !== 'project') { if(doc.schemaVersion===3)validateV3Export(doc,body);else scopedExportDocument(doc, body); }
      this.store.updateJob(job.id, {}, { snapshot: clone(doc), exportRevisions: this.store.listRevisions(doc.id, owner).filter(revision => revision.revision <= doc.revision),exportCraft:body.format==='project'?freezeCraftPackage(this.store,doc.id,owner)||null:null });
    }
    return this.store.getJob(job.id, owner);
    });
    setImmediate(() => void this.tick()); return job;
  }
  async importProject(owner, body) { const bundle=readProjectArchive(body);return bundle.manifest.version===3?importV3Project(this.store,owner,body,bundle):importProjectBundle(this.store,owner,body,inspectAsset); }
  async process(request,ctx) { return ctx.document.schemaVersion===3?executeV3Operation(request,ctx,this.processor):this.processor(request,ctx); }
  async exportArtifact(format,document,ctx) { return document.schemaVersion===3?exportV3Document(format,document,ctx):exportDocument(format,document,ctx); }
  async renderResource(owner,documentId,contentId,options={}) {
    const document=options.revision===undefined?this.store.getDocument(documentId,owner):this.store.getRevision(documentId,owner,options.revision);
    fail(document.schemaVersion===3,'render resources require a v3 document',422,'unsupported_schema');
    const content=document.contentAssets.find(item=>item.id===contentId);fail(content,'content not found in this revision',404,'not_found');
    fail(options.role===undefined||['content','mask'].includes(options.role),'invalid render resource role');
    if(options.layerId){const layer=document.layers.find(item=>item.id===options.layerId);fail(layer&&((options.role!=='mask'&&layer.contentId===contentId)||(options.role!=='content'&&layer.masks.some(mask=>mask.contentId===contentId))),'content is not referenced by the requested layer and role',404,'not_found');}
    const getAsset=id=>{fail(document.assetIds.includes(id),'resource not registered in this revision',422,'CONTENT_RESOURCE_UNREGISTERED');return this.store.getAsset(id,owner);};
    const authored=document.layers.some(layer=>(options.role!=='mask'&&layer.contentId===contentId)||(options.role!=='content'&&layer.masks.some(mask=>mask.contentId===contentId)));
    let resource;
    if(authored)resource=await resolveNodeResource(document,contentId,getAsset,options);
    else {fail(options.role!=='content'&&document.savedSelections.some(selection=>selection.contentId===contentId),'content has no visible layer, mask or saved selection reference',404,'not_found');resource=await createNodeResolver(getAsset)(content,{document,layer:{id:`selection_${contentId}`},role:'mask'});}
    return resource.kind==='raster'?{...resource,pixels:Buffer.from(resource.pixels).toString('base64'),pixelEncoding:'base64-rgba8'}:resource;
  }
  cancel(owner, id) {
    const job = this.store.getJob(id, owner);
    if (['complete','failed','uncertain','cancelled'].includes(job.state)) return job;
    const cancelled = this.store.updateJob(id, { ...(['queued','awaiting_user'].includes(job.state) ? { state: 'cancelled' } : {}), stage: 'cancel_requested' }, { cancelRequested: true });
    const runId = this.store.jobRecord(id).private.input.runId;
    if (runId) this.store.updateRun(runId, { state: 'cancelled' });
    return cancelled;
  }
  retry(owner, id, key) {
    const job = this.store.getJob(id, owner), r = this.store.jobRecord(id);
    fail(typeof key === 'string' && key.length > 0, '重试标识不能为空');
    fail(job.state === 'failed' || job.state === 'cancelled', '当前任务不能重试，接收未知的生成任务不会自动重投', 409, 'retry_not_allowed');
    fail(r.private.input.operation !== 'generate' && r.private.input.operation !== 'inpaint' && r.job.kind !== 'agent', '生成任务请检查原回执后明确发起新请求', 409, 'retry_not_allowed');
    const next = this.store.updateJob(id, { state: 'queued', stage: 'retrying', error: undefined }, { cancelRequested: false, retryKey: key });
    void this.tick(); return next;
  }
  async tick() {
    if (this.stopped) return;
    this.activePromises ||= new Set();
    for (const id of this.store.pendingJobs()) {
      if (this.active.size >= 2) break;
      const record = this.store.jobRecord(id);
      if (this.active.has(id) || record.job.state !== 'queued' || record.private.nextPollAt > Date.now()) continue;
      this.active.add(id);
      const promise = this.execute(id).finally(() => { this.active.delete(id); this.activePromises.delete(promise); });
      this.activePromises.add(promise);
    }
  }
  hydrateReceipt(receipt) {
    if (!receipt?.responseHash) return receipt;
    const bytes = readFileSync(join(this.store.blobs, receipt.responseHash));
    fail(digest(bytes) === receipt.responseHash, '模型回执校验失败', 500);
    return { ...receipt, response: JSON.parse(bytes.toString('utf8')) };
  }
  context(id, document, owner, namespace = 'operation') {
    const state = this.store.jobRecord(id).private;
    this.store.updateJob(id, {}, { activeNamespace: namespace });
    const previous = namespace === 'operation' ? state : state.toolStates?.[namespace] || {};
    const ctx = { document, owner, jobId: id, config: this.config, fetchImpl: this.fetchImpl, checkpoints: previous.processorState || {}, providerReceipt: this.hydrateReceipt(previous.providerReceipt), cancelled: () => this.cancelled(id), getAsset: async assetId => this.store.getAsset(assetId, owner) };
    ctx.checkpoint = async patch => {
      const live = this.store.jobRecord(id).private, scope = namespace === 'operation' ? live : live.toolStates?.[namespace] || {};
      const { providerReceipt, ...processorPatch } = patch;
      let persistedReceipt = providerReceipt;
      if (providerReceipt?.response) { const bytes = Buffer.from(JSON.stringify(providerReceipt.response)); fail(bytes.length <= 128 * 1024 * 1024, '模型回执超过处理上限'); const responseHash = digest(bytes); this.store.writeBlob(bytes, responseHash); const { response: _response, ...rest } = providerReceipt; void _response; persistedReceipt = { ...rest, responseHash }; }
      const update = { ...scope, processorState: { ...scope.processorState, ...processorPatch }, ...(providerReceipt ? { providerReceipt: persistedReceipt, callCounted: scope.callCounted || providerReceipt.phase === 'submitting' } : {}) };
      this.store.transaction(() => {
        if (providerReceipt?.phase === 'submitting' && !scope.callCounted) {
          const field = providerReceipt.provider === 'image' ? 'generationCalls' : 'visionCalls';
          this.store.updateJob(id, { metrics: { [field]: (this.store.jobRecord(id).job.metrics?.[field] || 0) + 1 } });
        }
        if (namespace === 'operation') this.store.updateJob(id, {}, { processorState: update.processorState, ...(providerReceipt ? { providerReceipt: persistedReceipt, callCounted: update.callCounted } : {}) });
        else this.store.updateJob(id, {}, { toolStates: { ...live.toolStates, [namespace]: update } });
      });
      ctx.checkpoints = update.processorState; if (providerReceipt) ctx.providerReceipt = providerReceipt;
    };
    ctx.saveAsset = async (key, descriptor, bytes) => {
      const asset = this.store.checkpointAsset(id, `${namespace}:${key}`, { ...descriptor, inputs: descriptor.inputs || ctx.inputReferences || (this.store.jobRecord(id).private.input.inputs || []) }, Buffer.from(bytes), document.id);
      this.store.linkAsset(document.id, asset.id); return asset;
    };
    return ctx;
  }
  async executeInline(id, branchId, owner, request, namespace) {
    if(this.cancelled(id))throw new ImageError('任务已取消',409,'CANCELLED');
    const state = this.store.jobRecord(id).private, prior = state.toolStates?.[namespace];
    const current = this.store.getDocument(branchId, owner);
    const doc = prior?.sourceRevision === undefined ? current : this.store.getRevision(branchId, owner, prior.sourceRevision);
    if (prior?.sourceRevision === undefined) this.store.updateJob(id, {}, { toolStates: { ...state.toolStates, [namespace]: { ...prior, sourceRevision: doc.revision } } });
    fail(registry[request.operation] && request.operation !== 'export', '未知操作');
    this.validateOperation(doc, owner, request);
    const ctx = this.context(id, doc, owner, namespace);
    ctx.inputReferences = [...request.inputs || []];
    const sourceLayer = doc.layers.find(l => l.id === request.targetLayerId);
    if (sourceLayer?.assetId && !ctx.inputReferences.some(r => r.role === 'base')) ctx.inputReferences.push({ role: 'base', assetId: sourceLayer.assetId });
    const result = await this.process(request, ctx);
    if (this.cancelled(id)) throw new ImageError('任务已取消', 409, 'CANCELLED');
    const latest = this.store.getDocument(branchId, owner);
    if(result.commands?.length){const proposal=applyCommands({...doc,assetIds:latest.assetIds},result.commands);assertAgentProtectedLayers(doc,proposal);}
    if(this.cancelled(id))throw new ImageError('任务已取消',409,'CANCELLED');
    const applied = result.commands?.length ? this.store.command(branchId, owner, { baseRevision: doc.revision, commandId: `${id}:${namespace}`, commands: result.commands }) : latest;
    return { ...result.output, branchDocumentId: branchId, revision: applied.revision, needsReview: result.needsReview };
  }
  async exportInline(id, documentId, owner, format, namespace, options={}) {
    const checkpoint = this.store.jobRecord(id).private.checkpoints?.[`${namespace}:export`];
    if (checkpoint) { const { asset } = this.store.getAsset(checkpoint, owner); return { assetId: asset.id, url: asset.url, mime: asset.mime, filename: asset.name }; }
    const prior=this.store.jobRecord(id).private.toolStates?.[namespace],current=this.store.getDocument(documentId,owner),doc=prior?.exportSourceRevision===undefined?current:this.store.getRevision(documentId,owner,prior.exportSourceRevision);
    const scope=prior?.exportScope||{layerIds:options.layerIds,bounds:options.bounds||(doc.schemaVersion===3?undefined:exportCanvasBounds(doc,options.layerIds))};
    if(prior?.exportSourceRevision===undefined){this.store.transaction(()=>{const live=this.store.jobRecord(id).private;this.store.updateJob(id,{}, {toolStates:{...live.toolStates,[namespace]:{...prior,exportSourceRevision:doc.revision,exportScope:scope,exportCraft:format==='project'?freezeCraftPackage(this.store,documentId,owner)||null:null}}});});}
    const ctx = this.context(id, doc, owner, namespace);
    const exported = await this.exportArtifact(format, doc, { ...scope,getAsset: ctx.getAsset, revisions: this.store.listRevisions(documentId, owner).filter(revision=>revision.revision<=doc.revision),craft:this.store.jobRecord(id).private.toolStates?.[namespace]?.exportCraft||undefined });
    const asset = await ctx.saveAsset('export', { name: exported.name, mime: exported.mime, metadata: { role: 'export', format, sourceDocumentId: doc.id, sourceRevision: doc.revision,...(format==='project'?{}:scope) } }, exported.bytes);
    return { assetId: asset.id, url: asset.url, mime: asset.mime, filename: asset.name };
  }
  async execute(id) {
    let record = this.store.jobRecord(id);
    this.store.updateJob(id, { state: 'running', stage: 'processing', progress: 0.05 });
    try {
      if (this.cancelled(id)) throw new ImageError('任务已取消', 409, 'CANCELLED');
      if (record.job.kind === 'agent') {
        if(record.private.snapshot?.schemaVersion===3)fail(this.config.agent.baseUrl&&this.config.agent.apiKey,'专业工程聊天模型尚未配置；未提交模型任务',422,'V3_OPERATION_UNAVAILABLE');
        const result = await this.agent.execute(id, record);
        this.store.updateJob(id, { state: result.state, progress: 1, stage: 'agent_complete', output: result.output }); return;
      }
      if (record.job.kind === 'export') {
        const cached = record.private.checkpoints?.['operation:export'];
        let asset;
        if (cached) asset = this.store.getAsset(cached, record.owner).asset;
        else {
          const ctx = this.context(id, record.private.snapshot, record.owner), scope = { layerIds: record.private.input.layerIds, bounds: record.private.input.bounds }, exported = await this.exportArtifact(record.private.input.format, record.private.snapshot, { ...scope, getAsset: ctx.getAsset, revisions: record.private.exportRevisions || this.store.listRevisions(record.job.documentId, record.owner).filter(revision => revision.revision <= record.private.snapshot.revision),craft:record.private.exportCraft||undefined });
          asset = await ctx.saveAsset('export', { name: exported.name, mime: exported.mime, metadata: { role: 'export', format: record.private.input.format, sourceDocumentId: record.private.snapshot.id, sourceRevision: record.private.snapshot.revision, ...(record.private.input.format !== 'project' ? scope : {}) } }, exported.bytes);
        }
        if (this.cancelled(id)) throw new ImageError('任务已取消，已生成文件仍保留', 409, 'CANCELLED');
        this.store.updateJob(id, { state: 'complete', progress: 1, stage: 'export_complete', output: { assetId: asset.id, url: asset.url, mime: asset.mime, filename: asset.name } }); return;
      }
      let targetId = record.private.branchDocumentId || record.job.documentId;
      const source = record.private.branchDocumentId ? this.store.getRevision(targetId, record.owner, record.private.targetSourceRevision ?? 0) : record.private.snapshot;
      const ctx = this.context(id, source, record.owner);
      ctx.inputReferences = [...record.private.input.inputs || []];
      const sourceLayer = source.layers.find(l => l.id === record.private.input.targetLayerId);
      if (sourceLayer?.assetId && !ctx.inputReferences.some(r => r.role === 'base')) ctx.inputReferences.push({ role: 'base', assetId: sourceLayer.assetId });
      const result = await this.process(record.private.input, ctx);
      if (this.cancelled(id)) throw new ImageError('任务已取消', 409, 'CANCELLED');
      record = this.store.jobRecord(id);
      let applied;
      try { applied = result.commands?.length ? this.store.command(targetId, record.owner, { baseRevision: source.revision, commandId: `job-apply:${id}`, commands: result.commands }) : this.store.getDocument(targetId, record.owner); }
      catch (error) {
        if (error.code !== 'revision_conflict' || record.private.branchDocumentId) throw error;
        const branch = this.store.createBranch(record.job.documentId, record.owner, { baseRevision: record.private.snapshot.revision, metadata: { candidateJobId: id } });
        for (const assetId of this.store.getDocument(record.job.documentId, record.owner).assetIds) this.store.linkAsset(branch.id, assetId);
        targetId = branch.id;
        applied = this.store.command(branch.id, record.owner, { baseRevision: branch.revision, commandId: `job-apply:${id}`, commands: result.commands });
        this.store.updateJob(id, {}, { branchDocumentId: branch.id, targetSourceRevision: branch.revision });
      }
      this.store.updateJob(id, { state: 'complete', progress: 1, stage: 'complete', output: { ...result.output, documentId: targetId, revision: applied.revision, needsReview: result.needsReview, ...(targetId !== record.job.documentId ? { branchDocumentId: targetId } : {}) } });
    } catch (error) {
      const r = this.store.jobRecord(id), uncertain = error.uncertain === true, cancelled = this.cancelled(id) || error.code === 'CANCELLED';
      const activeReceipt = r.private.activeNamespace && r.private.activeNamespace !== 'operation' ? r.private.toolStates?.[r.private.activeNamespace]?.providerReceipt : r.private.providerReceipt;
      if (!cancelled && activeReceipt?.provider === 'comfy' && activeReceipt.promptId && ['COMFY_PENDING','UPSTREAM_HTTP'].includes(error.code)) {
        this.store.updateJob(id, { state: 'queued', stage: 'waiting_for_vision', error: undefined, retryable: false }, { nextPollAt: Date.now() + Math.max(500, this.config.comfyPollMs || 1500) });
        return;
      }
      const state = uncertain ? 'uncertain' : cancelled ? 'cancelled' : 'failed';
      const receipt = r.private.providerReceipt;
      const accepted = Boolean(receipt?.promptId || receipt?.phase === 'received');
      this.store.updateJob(id, { state, stage: uncertain ? 'acceptance_unknown' : state, error: String(error.message || error).slice(0, 1500), retryable: !uncertain && r.job.kind !== 'agent' && registry[r.private.input.operation]?.executionClass !== 'generation', output: { ...r.job.output, accepted, assetIds: Object.values(r.private.checkpoints || {}) } });
      if (r.private.input.runId) this.store.updateRun(r.private.input.runId, { state, error: String(error.message).slice(0, 1500) });
    }
  }
}
