/** Explicit local CPU acceptance through HTTP, durable jobs/store, and actual export. No generation/GPU. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createImageService} from '../server.mjs';
import {decodeRGBA,inspectAsset} from '../processors.mjs';

const options={};for(let i=2;i<process.argv.length;i+=2)options[process.argv[i].replace(/^--/,'')]=process.argv[i+1];
if(!options.url||!options.image||!options.output)throw new Error('Required: --url LOCAL_WORKER --image PNG --output EVIDENCE_DIR; token comes from IMAGE2_OCR_TOKEN');
const worker=new URL(options.url);assert.equal(worker.hostname,'127.0.0.1','Acceptance only permits an explicit localhost worker');
const evidence=options.output,source=await readFile(options.image),info=await inspectAsset(source,'image/png');
await mkdir(evidence,{recursive:true});
const directory=await mkdtemp(join(tmpdir(),'image2-service-ocr-')),owner=randomUUID(),serviceToken=randomUUID();
let ocrRequests=0,healthRequests=0;
const service=createImageService({directory,token:serviceToken,config:{imageBaseUrl:'',imageApiKey:'',comfyBaseUrl:'',comfyToken:'',ocrUrl:worker.origin,ocrToken:process.env.IMAGE2_OCR_TOKEN||'',ocrTimeoutMs:120000,agent:{baseUrl:'',apiKey:''}},fetchImpl:async(url,init)=>{
  const destination=new URL(url);assert.equal(destination.origin,worker.origin,'No generation, Comfy or other remote provider is allowed');
  if(destination.pathname==='/ocr')ocrRequests++;else if(destination.pathname==='/health')healthRequests++;else throw new Error('Unexpected OCR worker route');
  return fetch(url,init);
}});
await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${service.server.address().port}/api/v3/image2`;
async function request(path,body){const response=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${serviceToken}`,'x-studio-visitor-id':owner,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});assert.equal(response.status,200,await (response.ok?Promise.resolve(''):response.text()));return response;}
async function json(path,body){return (await (await request(path,body)).json()).data;}
async function settle(id){const end=Date.now()+120000;while(Date.now()<end){const job=await json(`/jobs/${id}`);if(['complete','failed','uncertain','cancelled','awaiting_user'].includes(job.state))return job;await new Promise(resolve=>setTimeout(resolve,25));}throw new Error('Job timeout');}
async function bytes(id){return Buffer.from(await (await request(`/assets/${id}/content`)).arrayBuffer());}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
try{
  const health=await (await fetch(worker.origin+'/health')).json();assert.equal(health.ready,true);
  const document=await json('/documents',{name:'CPU OCR service acceptance 中文',width:info.width,height:info.height});
  const asset=await json('/assets',{documentId:document.id,name:'source.png',mime:'image/png',data:source.toString('base64')});
  const main=await json(`/documents/${document.id}/commands`,{baseRevision:0,commandId:'source-layer',commands:[{type:'layer.add',layer:{id:'source-layer',type:'raster',assetId:asset.id,x:0,y:0,width:info.width,height:info.height,z:0}}]});
  const started=Date.now(),submitted=await json('/operations',{documentId:main.id,baseRevision:main.revision,operation:'restore_layers',targetLayerId:'source-layer',params:{segment:false},mode:'candidate',idempotencyKey:'cpu-ocr-service-acceptance'});
  const job=await settle(submitted.job.id);assert.equal(job.state,'complete',job.error);assert.equal(job.output.coverage,1);assert.equal(job.output.differentChannels,0);
  const restoreMs=Date.now()-started,branch=await json(`/documents/${job.output.branchDocumentId}`),unchangedMain=await json(`/documents/${main.id}`);
  assert.deepEqual(unchangedMain.layers,main.layers);assert.equal(unchangedMain.revision,main.revision);assert.deepEqual(await bytes(asset.id),source);
  const group=branch.layers.find(layer=>layer.id==='source-layer');assert.equal(group.type,'group');
  const children=branch.layers.filter(layer=>layer.parentId===group.id),texts=children.filter(layer=>layer.type==='text');assert.ok(texts.length>=2);
  assert.ok(texts.every(layer=>layer.metadata.fontStatus==='unknown'&&layer.metadata.fontConfirmed===false&&layer.assetId===layer.metadata.sourcePatchAssetId));
  for(const layer of texts){
    assert.equal(layer.metadata.originalFont,'unknown');assert.equal(layer.fontAssetId,undefined);
    const candidates=layer.metadata.fontCandidates;assert.ok(candidates.length>=1&&candidates.length<=3);
    for(const candidate of candidates){
      assert.equal(candidate.originalFont,'unknown');assert.equal(candidate.requiresManualConfirmation,true);assert.equal(candidate.originalFontConfidence,undefined);
      assert.equal(candidate.glyphCoverage.ratio,1);assert.equal(candidate.geometryFit.method,'fontkit_ink_bounds');
      const font=service.store.getAsset(candidate.fontAssetId,owner);assert.ok(font.bytes.length>0);assert.ok(font.asset.mime.startsWith('font/'));
      assert.equal(hash(font.bytes),font.asset.hash,'a font candidate must reference the actual immutable font bytes');
    }
  }
  const exported=await json('/exports',{documentId:branch.id,baseRevision:branch.revision,format:'png',idempotencyKey:'actual-restored-png'}),exportJob=await settle(exported.job.id);assert.equal(exportJob.state,'complete',exportJob.error);
  const rendered=await bytes(exportJob.output.assetId),original=await decodeRGBA(source,'image/png'),restored=await decodeRGBA(rendered,'image/png');assert.deepEqual([restored.width,restored.height],[original.width,original.height]);
  let differentChannels=0,maxChannelDiff=0;for(let i=0;i<original.data.length;i++){const diff=Math.abs(original.data[i]-restored.data[i]);if(diff)differentChannels++;maxChannelDiff=Math.max(maxChannelDiff,diff);}
  assert.equal(differentChannels,0);assert.equal(maxChannelDiff,0);assert.equal(ocrRequests,1);
  const project=await json('/exports',{documentId:branch.id,baseRevision:branch.revision,format:'project',idempotencyKey:'actual-restored-project'}),projectJob=await settle(project.job.id);assert.equal(projectJob.state,'complete',projectJob.error);
  const report={schemaVersion:1,evaluatedAt:new Date().toISOString(),scope:'One synthetic Chinese fixture; local CPU OCR through createImageService HTTP/store/job/branch/export. Not a production/GPU/font-history acceptance.',models:health.models,packages:health.packages,device:health.device,downloadsAtRuntime:health.downloads_at_runtime,source:{file:'source.png',sha256:hash(source),width:info.width,height:info.height},restore:{jobId:job.id,state:job.state,elapsedMs:restoreMs,coverage:job.output.coverage,partitionDifferentChannels:job.output.differentChannels,needsReview:job.output.needsReview,warnings:job.output.warnings,targetGroupId:group.id,layerCount:children.length},texts:texts.map(layer=>({text:layer.text,confidence:layer.metadata.textConfidence,fontStatus:layer.metadata.fontStatus,fontConfirmed:layer.metadata.fontConfirmed,originalFont:layer.metadata.originalFont,fontCandidates:layer.metadata.fontCandidates,sourceRect:layer.sourceRect})),layers:children.map(layer=>({id:layer.id,type:layer.type,name:layer.name,x:layer.x,y:layer.y,width:layer.width,height:layer.height,ownedPixelCount:layer.metadata.ownedPixelCount,sourceRect:layer.sourceRect,assetId:layer.assetId,maskAssetId:layer.maskAssetId})),verification:{mainRevisionUnchanged:unchangedMain.revision===main.revision,mainLayersUnchanged:true,sourceBytesUnchanged:true,fontCandidatesHaveActualOwnedBytes:true,fontCandidatesNeverAutoConfirmed:true,renderedDifferentChannels:differentChannels,maxChannelDiff,rgbaChannels:original.data.length,ocrRequests,healthRequests,gpuCalled:false,generationCalled:false,hiddenContent:'not_reconstructed'},artifacts:{source:'source.png',rendered:'recomposed.png',branch:'branch.json',project:'restored.image2.zip',renderedSha256:hash(rendered)}};
  await Promise.all([writeFile(join(evidence,'source.png'),source),writeFile(join(evidence,'recomposed.png'),rendered),writeFile(join(evidence,'branch.json'),JSON.stringify(branch,null,2)+'\n'),writeFile(join(evidence,'restored.image2.zip'),await bytes(projectJob.output.assetId)),writeFile(join(evidence,'report.json'),JSON.stringify(report,null,2)+'\n')]);
  console.log(JSON.stringify(report));
}finally{service.server.closeAllConnections();await service.close();await rm(directory,{recursive:true,force:true});}
