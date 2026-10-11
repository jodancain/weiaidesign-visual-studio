# Image Studio 2.0 implementation contract

Shared workspace, bounded owners. Backend agent: domain.mjs/store.mjs/router.mjs + their tests. Processing agent: processors.mjs/providers.mjs/restore.mjs/vision-worker + processor tests. Frontend agent: app/image2, components/image2, lib/image2 + UI unit tests. Root: package/lock, server.mjs, jobs.mjs, agent.mjs, exports.mjs, BFF, deployment/docs and integration tests. Do not edit another owner's files without coordination.

## Public model
Document: {id,name,schemaVersion:2,revision,width,height,layers:Layer[],assetIds:string[],createdAt,updatedAt, parentDocumentId?,baseRevision?,metadata?}
Layer: {id,type:'raster'|'text'|'vector'|'group'|'mask',name,x,y,width,height,rotation:degrees,opacity:0..1,visible:boolean,locked:boolean,z:number,parentId?,assetId?,maskAssetId?,sourceAssetId?,sourceRect?,text?,fontAssetId?,fontFamily?,fontSize?,fontWeight?,fill?,stroke?,strokeWidth?,tracking?,lineHeight?,editability?:'pixels'|'text'|'path',metadata?}
Document commands: {type:'layer.add',layer}, {type:'layer.update',layerId,patch}, {type:'layer.remove',layerId}, {type:'layer.reorder',layerIds}, {type:'document.update',patch:{name?,width?,height?}}. All geometry in document pixels; server is canonical. Masks are source pixel RGBA/gray with white editable/protected. Text sourcePatch asset may remain until fontConfirmed metadata.
Asset: {id,documentId,name,mime,hash,bytes,width?,height?,createdAt,metadata?,inputs?:[{role,assetId,hash}]}. Exact immutable bytes. Tenant owner authorization mandatory even for branches.
Job: {id,documentId,kind,state:'queued'|'running'|'complete'|'failed'|'uncertain'|'cancelled'|'awaiting_user',progress,stage,createdAt,updatedAt,output?,error?,retryable?}. private input/receipt/checkpoints never served wholesale.
Operation request: {documentId,baseRevision,operation,params?:{},inputs?:[{role,assetId}],targetLayerId?,idempotencyKey,mode?:'apply'|'candidate'}.
Run: {id,documentId,branchDocumentId,state,jobId?,message,output?,...}; conversation message persists references via assetId/layerId/revision, no ordinal fallback.

## HTTP
Full prefix /api/v3/image2. Internal Bearer required (server config token) plus x-studio-visitor-id UUID. Health /health no private state. Responses {data:T}; errors {detail,code}. No new public host port.
GET capabilities; GET/POST documents; GET documents/:id; POST documents/:id/commands {baseRevision,commandId,commands}; GET documents/:id/revisions; POST documents/:id/history {baseRevision,commandId,direction:'undo'|'redo'}.
POST assets {documentId,name,mime,data:base64,metadata?}; GET assets/:id/content; GET documents/:id/assets.
POST operations -> {job}; GET jobs/:id; POST jobs/:id/cancel; POST jobs/:id/retry {idempotencyKey}.
GET documents/:id/jobs; POST documents/:id/accept {branchDocumentId,baseRevision,commandId}; GET documents/:id/branches.
GET/POST conversations {documentId}; GET conversations/:id/messages; POST conversations/:id/messages {text,references?,idempotencyKey} -> {run,job}; GET runs/:id; GET documents/:id/runs.
POST imports/legacy {snapshot,name,width,height,assets:[uploaded asset mappings]} (no arbitrary URL fetching). POST imports/project {data:base64 ZIP}; POST exports {documentId,format:'project'|'svg'|'pdf'|'png',idempotencyKey,baseRevision} -> job. Exports execute same runner.
Restore via operation restore_layers; capabilities is honest to configured/runtime availability.

## Store interface (backend owner)
export class ImageStore(directory). Methods: close(), createDocument(owner,body), listDocuments(owner), getDocument(id,owner), command(id,owner,{baseRevision,commandId,commands}), history(id,owner,{baseRevision,commandId,direction}), listRevisions(id,owner).
addAsset(documentId,owner,descriptor,bytes), getAsset(id,owner)->{asset,bytes}, listAssets(documentId,owner).
createJob(documentId,owner,{kind,idempotencyKey,input})->job; getJob(id,owner)->public; jobRecord(id)->{job,private,owner}; updateJob(id,patch,privatePatch={}); listJobs(documentId,owner); pendingJobs(); checkpointAsset(jobId,key,descriptor,bytes)->asset. Private job input frozen; checkpoint atomic bytes/fsync/hash then DB.
createBranch(documentId,owner,{baseRevision,name?,metadata?})->document; acceptBranch(documentId,owner,{branchDocumentId,baseRevision,commandId})->document; listBranches(documentId,owner). Branch inherits owned assets; add branch owned references rather than copying bytes. Branch contains base snapshot for changed-layer conflict checks. Preserve assets and receipts on undo.
Conversation/run persistence: createConversation(owner,{documentId}), listConversations(documentId,owner), getConversation(id,owner), addMessage(conversationId,owner,message), listMessages(id,owner), createRun(conversationId,owner,{idempotencyKey,...}), getRun(id,owner), runRecord(id), updateRun(id,patch), listRuns(documentId,owner).
Router factory createImageRouter({store,runner,config,fetchImpl?}) returns async handle(req,res) boolean. runner methods: capabilities(), submit(owner,request)->job, cancel(owner,id), retry(owner,id,key), submitRun(owner,conversationId,body)->{run,job}, importProject(owner,body), export(owner,body)->job. Root wires these after agent store ready.

## Processing interface (processing owner)
export registry: object operationName -> {executionClass:'cpu'|'vision'|'generation',label,...}; export inspectAsset(bytes,mime)->Promise<{mime,width?,height?,metadata?}>.
export executeOperation(request,ctx)->Promise<{commands:Command[],output?:{},needsReview?:boolean}>. ctx={document,owner,getAsset:async(id)->{asset,bytes},saveAsset:async(key,descriptor,bytes)->asset,checkpoint:async(patch),config,fetchImpl,cancelled:()=>boolean}.
Operations resize,crop,pad,rotate,flip,recolor,erase,color_key,trace,matting,segment,super_resolution,restore_layers,generate,inpaint,export. Root handles export through exports.mjs rather than processors.
Input assetId from inputs role='base', else target layer assetId. Pixel source uses same-size edit/protect masks; protect wins and feather inward. Output saveAsset checkpoint then commands replacement/add actual asset ID.
Generation/restore defaults candidate. Branch runs explicitly apply all operations to branch. Source logo/font/vector assets preserved.
Providers module exposes capability assessment, generation/reference edits with receipt checkpoints, Comfy submit/poll/download persisting prompt_id, and OCR worker HTTP. No live generation in tests. Unknown acceptance throws with uncertain=true, no automatic charged resubmission. ML unavailable must not fall back generation.
Restore visible pixel coverage, original RGBA recompose equality, residual/background/masks and unknown font metadata; use exact pixel ownership rather than lossful reinterpretation.

## Root integration
Standalone MJS Node22 package (not Next TS scanning). Dependencies sharp, imagetracerjs, @resvg/resvg-js, fontkit, pdfkit, fflate, fast-xml-parser. Frontend shares lib/image2/types.ts manually aligned by tests; no service source import outside package.
Image2 Node internal port 18088, OCR port 8080 internal only, named volume /data/image2, read-only model volume. BFF IMAGE2_API_URL selects origin only and IMAGE2_API_TOKEN; missing ->503. Stable visitor secret bootstrap first.
Agent max6 rounds, persistent own branch, operations via registry. New typed scope validations; stopping/unknown receipts remain durable. Fake injected provider only in tests.
