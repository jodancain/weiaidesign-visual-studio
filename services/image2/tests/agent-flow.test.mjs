import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as fontkit from 'fontkit';
import {createImageService} from '../server.mjs';
import {agentTools,prepareAgentMessages} from '../agent.mjs';
import {encodePNG,decodeRGBA,executeOperation,registry} from '../processors.mjs';

const OWNER='11111111-1111-4111-8111-111111111111',TOKEN='synthetic-agent-test-token';
const CONFIG={imageBaseUrl:'',imageApiKey:'',comfyBaseUrl:'',comfyToken:'',ocrUrl:'',ocrToken:'',agent:{baseUrl:'https://llm.fixture.invalid/v1',apiKey:'synthetic-llm-key',models:['stub'],timeoutMs:1000,maxTools:24,maxGenerations:4}};
const tool=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
const answer=message=>Response.json({choices:[{message:{role:'assistant',...message}}]});
async function waitFor(check,timeout=10000){const end=Date.now()+timeout;while(Date.now()<end){const value=await check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Agent fixture did not settle');}
async function pixels(width=8,height=6){const data=Buffer.alloc(width*height*4);for(let y=0;y<height;y++)for(let x=0;x<width;x++)data.set([x*23,y*31,90,255],(y*width+x)*4);return encodePNG({width,height,data});}
async function harness(t,{fetchImpl,config={},processor}={}){
  const directory=mkdtempSync(join(tmpdir(),'image2-agent-'));let service,origin;
  async function open(){service=createImageService({directory,token:TOKEN,config:{...CONFIG,...config,agent:{...CONFIG.agent,...config.agent}},fetchImpl,...(processor?{processor}:{})});await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${service.server.address().port}/api/v3/image2`;}
  async function close(){if(!service)return;const old=service;service=undefined;old.server.closeAllConnections();await old.close();}
  await open();t.after(async()=>{await close();rmSync(directory,{recursive:true,force:true});});
  async function request(path,body){return fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${TOKEN}`,'x-studio-visitor-id':OWNER,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});}
  async function json(path,body){const response=await request(path,body),data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data.data;}
  async function bytes(id){const response=await request(`/assets/${id}/content`);assert.equal(response.status,200);return Buffer.from(await response.arrayBuffer());}
  async function terminal(id){
    try{return await waitFor(async()=>{const job=await json(`/jobs/${id}`);return ['complete','failed','uncertain','cancelled','awaiting_user'].includes(job.state)?job:null;},60000);}
    catch(error){const record=service.store.jobRecord(id),state=record.private.agentState;throw new Error(`Agent fixture deadline 60000ms exceeded: ${JSON.stringify({jobId:id,state:record.job.state,stage:record.job.stage,phase:state?.phase,round:state?.round,toolIndex:state?.callIndex,pendingTools:state?.pending?.length,active:service.runner.active.has(id)})}`,{cause:error});}
  }
  async function sourceDocument({unknownText=false,logo=false}={}){
    const document=await json('/documents',{name:'Agent fixture 中文',width:256,height:160}),source=await pixels();
    const asset=await json('/assets',{documentId:document.id,name:'source.png',mime:'image/png',data:source.toString('base64')});
    const commands=[{type:'layer.add',layer:{id:'base',type:unknownText?'text':'raster',assetId:asset.id,x:0,y:0,width:8,height:6,z:0,...(unknownText?{text:'原文字',metadata:{role:'sourcePatch',fontStatus:'unknown',fontConfirmed:false,sourcePatchAssetId:asset.id,desiredText:'待改文字'}}:{})}}];
    let logoAsset;
    if(logo){logoAsset=await json('/assets',{documentId:document.id,name:'logo.svg',mime:'image/svg+xml',data:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M0 0H24V24H0Z" fill="#000000"/></svg>').toString('base64')});commands.push({type:'layer.add',layer:{id:'logo',type:'vector',assetId:logoAsset.id,width:24,height:24,x:208,y:120,z:1,metadata:{role:'logo',pathStyles:{}}}});}
    const main=await json(`/documents/${document.id}/commands`,{baseRevision:0,commandId:'source',commands});
    return {document:main,asset,logoAsset,source};
  }
  async function run(document,text='执行测试操作'){const conversation=await json('/conversations',{documentId:document.id});return {...await json(`/conversations/${conversation.id}/messages`,{text,idempotencyKey:'agent-request'}),conversation};}
  return {get service(){return service;},open,close,json,request,bytes,terminal,sourceDocument,run};
}

test('stub LLM routes real CPU pixels, Chinese text and vector Logo to its branch with an actual default font',async t=>{
  let llmPosts=0;const f=await harness(t,{fetchImpl:async(url,init)=>{
    assert.equal(String(url),'https://llm.fixture.invalid/v1/chat/completions');assert.equal(init.method,'POST');llmPosts++;
    const body=JSON.parse(init.body);assert.equal(body.model,'stub');assert.ok(body.tools.some(tool=>tool.function.name==='apply_commands'));
    if(llmPosts===1)return answer({tool_calls:[
      tool('resize','image_operation',{operation:'resize',targetLayerId:'base',params:{width:16,height:12,kernel:'nearest'}}),
      tool('text','apply_commands',{commands:[{type:'layer.add',layer:{id:'title',type:'text',name:'中文标题',text:'中文 MAI',x:10,y:40,width:190,height:45,fontSize:32,fill:'#000000',z:2}}]}),
      tool('logo','apply_commands',{commands:[{type:'layer.update',layerId:'logo',patch:{fill:'#00ff00',metadata:{role:'logo',pathStyles:{'0':{fill:'#00ff00'}}}}}]}),
    ]});
    assert.equal(llmPosts,2);assert.ok(body.messages.some(message=>message.role==='tool'));return answer({content:'像素、中文标题和Logo已完成。'});
  }});
  const {document,asset,logoAsset,source}=await f.sourceDocument({logo:true}),{job,run}=await f.run(document),done=await f.terminal(job.id);assert.equal(done.state,'complete',done.error);assert.equal(llmPosts,2);
  const branch=await f.json(`/documents/${done.output.branchDocumentId}`),main=await f.json(`/documents/${document.id}`);assert.deepEqual(main.layers,document.layers);assert.equal(main.revision,document.revision);assert.equal(done.metrics.llmCalls,2);assert.equal(done.metrics.generationCalls||0,0);
  const base=branch.layers.find(layer=>layer.id==='base'),text=branch.layers.find(layer=>layer.id==='title'),logo=branch.layers.find(layer=>layer.id==='logo');assert.notEqual(base.assetId,asset.id);assert.deepEqual([base.width,base.height,base.x,base.y],[8,6,0,0]);
  const resized=await decodeRGBA(await f.bytes(base.assetId),'image/png');assert.deepEqual([resized.width,resized.height],[16,12]);assert.deepEqual([...resized.data.subarray(0,4)],[0,0,90,255]);assert.deepEqual(await f.bytes(asset.id),source);
  assert.equal(text.metadata.fontConfirmed,true);assert.equal(text.fontFamily,'Noto Sans CJK SC');const fontAsset=(await f.json(`/documents/${branch.id}/assets`)).find(a=>a.id===text.fontAssetId);assert.equal(fontAsset.metadata.builtin,true);assert.ok(!main.assetIds.includes(text.fontAssetId),'default font for new branch text must be owned by the branch');
  const font=fontkit.create(await f.bytes(text.fontAssetId));assert.equal(font.familyName,text.fontFamily);assert.ok([...text.text].filter(c=>c!==' ').every(c=>font.hasGlyphForCodePoint(c.codePointAt(0))));
  assert.equal(logo.assetId,logoAsset.id);assert.equal(logo.fill,'#00ff00');assert.equal(logo.metadata.pathStyles['0'].fill,'#00ff00');assert.equal((await f.json(`/runs/${run.id}`)).state,'complete');
  const exported=await f.json('/exports',{documentId:branch.id,baseRevision:branch.revision,format:'png',idempotencyKey:'agent-real-render'}),exportJob=await f.terminal(exported.job.id);assert.equal(exportJob.state,'complete',exportJob.error);
  const output=await decodeRGBA(await f.bytes(exportJob.output.assetId),'image/png');assert.deepEqual([...output.data.subarray((125*256+212)*4,(125*256+212)*4+4)],[0,255,0,255]);
  let ink=0;for(let y=40;y<85;y++)for(let x=10;x<200;x++)if(output.data[(y*256+x)*4+3]>0)ink++;assert.ok(ink>300,'default font must rasterize actual Chinese glyphs');
});

test('LLM cannot confirm an unknown sourcePatch font or falsely finish a blocked text step',async t=>{
  let calls=0;const f=await harness(t,{fetchImpl:async(url)=>{assert.ok(String(url).endsWith('/chat/completions'));calls++;return calls===1?answer({tool_calls:[tool('font','apply_commands',{commands:[{type:'layer.update',layerId:'base',patch:{text:'新中文',fontFamily:'Invented Font',metadata:{fontConfirmed:true}}}]})]}):answer({content:'完成'});}});
  const {document,asset,source}=await f.sourceDocument({unknownText:true}),{job,run,conversation}=await f.run(document,'把原文字改成新中文'),done=await f.terminal(job.id);assert.equal(done.state,'awaiting_user');assert.match(done.output.message,/字体待确认/);
  const branch=await f.json(`/documents/${done.output.branchDocumentId}`);assert.deepEqual(branch.layers,document.layers);assert.equal(branch.revision,0);assert.deepEqual(await f.bytes(asset.id),source);assert.equal((await f.json(`/runs/${run.id}`)).state,'awaiting_user');
  const record=f.service.store.jobRecord(job.id);assert.equal(record.private.toolOutputs.tool_1_0.code,'font_confirmation_required');const messages=await f.json(`/conversations/${conversation.id}/messages`);assert.ok(messages.some(message=>message.role==='tool'&&message.text.includes('font_confirmation_required')));
  const main=await f.json(`/documents/${document.id}`);assert.deepEqual(main.layers,document.layers);assert.equal(main.revision,document.revision);
});

for(const pollFailure of ['COMFY_PENDING','UPSTREAM_HTTP'])test(`accepted Comfy ${pollFailure} in an Agent loop restarts by polling once, with no duplicate submission or completed CPU step`,async t=>{
  let llmPosts=0,comfyPosts=0,uploads=0,polls=0,ready=false;const calls=[],providerOutput=await pixels();
  const f=await harness(t,{config:{comfyBaseUrl:'http://comfy.fixture.invalid',comfyToken:'synthetic-comfy-key',comfyPollMs:0,comfyPollAttempts:1,comfyTimeoutMs:1000},processor:async(request,ctx)=>{calls.push(request.operation);return executeOperation(request,ctx);},fetchImpl:async(url,init={})=>{
    const path=String(url);
    if(path.endsWith('/chat/completions')){llmPosts++;if(llmPosts===1)return answer({tool_calls:[tool('fill','image_operation',{operation:'fill',targetLayerId:'base',params:{color:'#ffffff'}}),tool('matting','image_operation',{operation:'matting',targetLayerId:'base',params:{}})]});assert.equal(llmPosts,2);return answer({content:'处理完成'});}
    if(path.endsWith('/upload/image')){uploads++;return Response.json({name:'fixture.png'});}
    if(path.endsWith('/prompt')){assert.equal(init.method,'POST');comfyPosts++;return Response.json({prompt_id:'agent-accepted-fixture'});}
    if(path.endsWith('/history/agent-accepted-fixture')){polls++;if(!ready&&pollFailure==='UPSTREAM_HTTP')return new Response('temporary upstream error',{status:503});return Response.json(ready?{'agent-accepted-fixture':{status:{completed:true},outputs:{'3':{images:[{filename:'image2_matting_fixture.png'}]}}}}:{});}
    if(path.includes('/view?'))return new Response(providerOutput,{headers:{'content-type':'image/png'}});
    throw new Error('Unexpected mocked route');
  }});
  const {document}=await f.sourceDocument(),{job,run}=await f.run(document);
  await waitFor(()=>{const r=f.service.store.jobRecord(job.id);return polls>=1&&r.private.toolStates?.tool_1_1?.providerReceipt?.promptId==='agent-accepted-fixture'&&!f.service.runner.active.has(job.id);});
  const paused=f.service.store.jobRecord(job.id);assert.equal(paused.job.state,'queued');assert.equal(paused.job.stage,'waiting_for_vision');assert.equal(paused.private.agentState.callIndex,1);assert.ok(paused.private.toolOutputs.tool_1_0);assert.equal(paused.private.toolOutputs.tool_1_1,undefined);
  const branchId=paused.private.branchDocumentId,before=(await f.json(`/documents/${branchId}`)).revision;assert.equal(before,1);assert.equal(comfyPosts,1);assert.equal(uploads,1);assert.equal(llmPosts,1);
  await f.close();ready=true;await f.open();const done=await f.terminal(job.id);assert.equal(done.state,'complete',done.error);assert.equal(comfyPosts,1);assert.equal(uploads,1);assert.ok(polls>=2);assert.equal(llmPosts,2);assert.equal(calls.filter(op=>op==='fill').length,1);assert.equal(calls.filter(op=>op==='matting').length,2);
  const branch=await f.json(`/documents/${branchId}`);assert.equal(branch.revision,2);assert.deepEqual(await f.bytes(branch.layers.find(layer=>layer.id==='base').assetId),providerOutput);assert.equal((await f.json(`/runs/${run.id}`)).state,'complete');assert.deepEqual((await f.json(`/documents/${document.id}`)).layers,document.layers);assert.equal(done.metrics.llmCalls,2);assert.equal(done.metrics.visionCalls,1);assert.equal(done.metrics.generationCalls||0,0);
});

test('Agent tool schema advertises every implemented CPU image operation, including fill/repair/prepare/refine',()=>{
  const operations=agentTools.find(tool=>tool.function.name==='image_operation').function.parameters.properties.operation.enum;
  for(const [name,op] of Object.entries(registry))if(op.executionClass==='cpu'&&name!=='export')assert.ok(operations.includes(name),name);
  for(const name of ['fill','repair','prepare_text','refine_mask']){assert.ok(operations.includes(name));assert.equal(registry[name].executionClass,'cpu');}
});

test('Agent executes prepare_text, fill, traditional repair and refine_mask on original unknown text pixels without a generation provider',async t=>{
  let llmPosts=0,editMaskId,visibilityMaskId;const f=await harness(t,{fetchImpl:async(url)=>{
    assert.equal(String(url),'https://llm.fixture.invalid/v1/chat/completions');llmPosts++;
    if(llmPosts>1)return answer({content:'原文字裁片和修补背景已保存，等待字体确认。'});
    return answer({tool_calls:[tool('prepare','image_operation',{operation:'prepare_text',targetLayerId:'text',params:{}}),tool('fill','image_operation',{operation:'fill',targetLayerId:'text',params:{color:'#ffffff',purpose:'text_background'}}),tool('repair','image_operation',{operation:'repair',targetLayerId:'text',inputs:[{role:'edit',assetId:editMaskId}],params:{purpose:'text_background'}}),tool('refine','image_operation',{operation:'refine_mask',targetLayerId:'text',inputs:[{role:'edit',assetId:visibilityMaskId}],params:{}})]});
  }});
  const width=32,height=16,data=Buffer.alloc(width*height*4,255),mask=Buffer.alloc(data.length),visible=Buffer.alloc(data.length,255);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){const j=(y*width+x)*4;mask[j+3]=255;if(x>=10&&x<13&&y>=4&&y<10){data.set([0,0,0,255],j);mask.set([255,255,255,255],j);}}
  const source=await encodePNG({width,height,data}),document=await f.json('/documents',{name:'CPU text fixture',width,height});
  const asset=await f.json('/assets',{documentId:document.id,name:'source-text.png',mime:'image/png',data:source.toString('base64')});
  editMaskId=(await f.json('/assets',{documentId:document.id,name:'glyph.png',mime:'image/png',data:(await encodePNG({width,height,data:mask})).toString('base64')})).id;
  visibilityMaskId=(await f.json('/assets',{documentId:document.id,name:'visible.png',mime:'image/png',data:(await encodePNG({width,height,data:visible})).toString('base64')})).id;
  const main=await f.json(`/documents/${document.id}/commands`,{baseRevision:0,commandId:'source',commands:[{type:'layer.add',layer:{id:'text',type:'text',assetId:asset.id,sourceAssetId:asset.id,sourceRect:[0,0,width,height],text:'原',x:0,y:0,width,height,metadata:{role:'sourcePatch',sourcePatchAssetId:asset.id,fontConfirmed:false,fontStatus:'unknown'}}}]});
  const {job}=await f.run(main),done=await f.terminal(job.id);assert.equal(done.state,'complete',done.error||done.output?.message);assert.equal(done.metrics.generationCalls||0,0);assert.equal(llmPosts,2);
  const outputs=f.service.store.jobRecord(job.id).private.toolOutputs;for(let i=0;i<4;i++)assert.equal(outputs[`tool_1_${i}`].error,undefined,JSON.stringify(outputs[`tool_1_${i}`]));
  for(let i=0;i<3;i++)assert.ok(outputs[`tool_1_${i}`].cleanBackgroundAssetId);
  const clean=await decodeRGBA(await f.bytes(outputs.tool_1_0.cleanBackgroundAssetId),'image/png');assert.ok(clean.data.every(value=>value===255));
  const branch=await f.json(`/documents/${done.output.branchDocumentId}`),text=branch.layers[0];assert.equal(text.type,'text');assert.equal(text.text,'原');assert.equal(text.metadata.fontConfirmed,false);assert.equal(text.metadata.fontStatus,'unknown');assert.equal(text.metadata.sourcePatchAssetId,text.assetId);assert.deepEqual(await f.bytes(text.assetId),source);assert.deepEqual(await f.bytes(asset.id),source);assert.deepEqual((await f.json(`/documents/${main.id}`)).layers,main.layers);
});

for(const status of [404,429])test(`explicit LLM ${status} rejection uses the configured second model and records both attempts`,async t=>{
  const models=[];const f=await harness(t,{config:{agent:{models:['rejected-model','accepted-model']}},fetchImpl:async(url,init)=>{assert.equal(String(url),'https://llm.fixture.invalid/v1/chat/completions');const body=JSON.parse(init.body);models.push(body.model);return models.length===1?new Response('explicit rejection',{status}):answer({content:'完成'});}});
  const {document}=await f.sourceDocument(),{job}=await f.run(document),done=await f.terminal(job.id);assert.equal(done.state,'complete',done.error);assert.deepEqual(models,['rejected-model','accepted-model']);assert.equal(done.metrics.llmCalls,2);assert.equal(done.metrics.generationCalls||0,0);assert.equal(f.service.store.jobRecord(job.id).private.agentState.selectedModel,'accepted-model');
});

for(const failure of ['500','transport','invalid_json','missing_message'])test(`LLM ${failure} has unknown acceptance and neither switches model nor repeats after reopen`,async t=>{
  let posts=0;const f=await harness(t,{config:{agent:{models:['first-model','must-not-retry']}},fetchImpl:async(url,init)=>{assert.ok(String(url).endsWith('/chat/completions'));posts++;assert.equal(JSON.parse(init.body).model,'first-model');if(failure==='500')return new Response('server error',{status:500});if(failure==='transport')throw Error('synthetic connection ended');if(failure==='invalid_json')return new Response('{',{headers:{'content-type':'application/json'}});return Response.json({choices:[]});}});
  const {document}=await f.sourceDocument(),{job,run}=await f.run(document),done=await f.terminal(job.id);assert.equal(done.state,'uncertain');assert.equal(posts,1);assert.equal(done.metrics.llmCalls,1);assert.equal(done.metrics.generationCalls||0,0);assert.equal(done.retryable,false);assert.equal((await f.json(`/runs/${run.id}`)).state,'uncertain');
  await f.close();await f.open();assert.equal((await f.json(`/jobs/${job.id}`)).state,'uncertain');assert.equal(posts,1);assert.equal((await f.request(`/jobs/${job.id}/retry`,{idempotencyKey:'no-duplicate'})).status,409);assert.equal(posts,1);
});

test('a synthetic image provider tool records one generation call and keeps newly generated pixels on the Agent branch',async t=>{
  let llmPosts=0,generationPosts=0;const generated=await pixels();
  const f=await harness(t,{config:{imageBaseUrl:'https://image.fixture.invalid/v1',imageApiKey:'synthetic-image-key'},fetchImpl:async(url,init)=>{
    if(String(url).endsWith('/chat/completions')){llmPosts++;return llmPosts===1?answer({tool_calls:[tool('generate','image_operation',{operation:'generate',params:{prompt:'synthetic fixture only',n:1}})]}):answer({content:'背景已保存'});}
    assert.equal(String(url),'https://image.fixture.invalid/v1/images/generations');assert.equal(init.method,'POST');generationPosts++;return Response.json({data:[{b64_json:generated.toString('base64')}]});
  }});
  const document=await f.json('/documents',{name:'mock generation',width:256,height:160}),{job}=await f.run(document),done=await f.terminal(job.id);assert.equal(done.state,'complete',done.error||done.output?.message);assert.equal(done.metrics.llmCalls,2);assert.equal(done.metrics.generationCalls,1);assert.equal(generationPosts,1);assert.equal(llmPosts,2);
  const branch=await f.json(`/documents/${done.output.branchDocumentId}`);assert.equal(branch.layers.length,1);assert.equal(branch.layers[0].type,'raster');assert.deepEqual(await f.bytes(branch.layers[0].assetId),generated);assert.equal((await f.json(`/documents/${document.id}`)).layers.length,0);assert.equal((await f.json(`/documents/${document.id}`)).revision,0);
});

test('Agent sees ordered immutable reference pixels and frozen conversation history after main assets change',async t=>{
  let posts=0,expected,jobId;const f=await harness(t,{fetchImpl:async(url,init)=>{
    assert.equal(String(url),'https://llm.fixture.invalid/v1/chat/completions');posts++;
    const body=JSON.parse(init.body),user=body.messages.find(message=>message.role==='user'&&Array.isArray(message.content));
    assert.ok(user);assert.match(user.content[1].text,/Reference 1 \/ 图一/);assert.match(user.content[1].text,new RegExp(expected.logoAsset.id));
    assert.match(user.content[3].text,/Reference 2 \/ 图二/);assert.match(user.content[3].text,new RegExp(expected.asset.id));
    const previews=user.content.filter(part=>part.type==='image_url');assert.equal(previews.length,2);
    const logo=await decodeRGBA(Buffer.from(previews[0].image_url.url.split(',')[1],'base64'),'image/png'),base=await decodeRGBA(Buffer.from(previews[1].image_url.url.split(',')[1],'base64'),'image/png');
    assert.deepEqual([logo.width,logo.height],[24,24]);assert.deepEqual([...logo.data.subarray(0,4)],[0,0,0,255]);assert.deepEqual(base.data,(await decodeRGBA(expected.source,'image/png')).data);
    assert.ok(!JSON.stringify(body.messages).includes('later-message-must-not-enter-this-run'));
    const context=body.messages.at(-1).content;assert.ok(context.includes('editMaskAssetId'));assert.ok(context.includes('protectMaskAssetId'));
    const record=f.service.store.jobRecord(jobId);assert.ok(record.private.agentState.referencePlan.images.length===2);assert.equal(record.private.agentState.phase,'llm_submitting');
    assert.match(JSON.stringify(record.private.agentState.messages),/image2-preview:/);assert.ok(!JSON.stringify(record.private.agentState.messages).includes('data:image/png;base64'));
    return answer({content:'按图一与图二的明确素材关系完成分析。'});
  }});
  expected=await f.sourceDocument({logo:true});await f.service.runner.stop();
  const masked=await f.json(`/documents/${expected.document.id}/commands`,{baseRevision:1,commandId:'maskrefs',commands:[{type:'layer.update',layerId:'base',patch:{metadata:{editMaskAssetId:expected.asset.id,protectMaskAssetId:expected.asset.id}}}]});
  const conversation=await f.json('/conversations',{documentId:masked.id}),submitted=await f.json(`/conversations/${conversation.id}/messages`,{text:'结合图一和图二',references:[{assetId:expected.logoAsset.id,layerId:'logo',revision:masked.revision},{assetId:expected.asset.id,layerId:'base',revision:masked.revision}],idempotencyKey:'ordered-image-refs'});jobId=submitted.job.id;
  const replacement=await f.json('/assets',{documentId:masked.id,name:'newer.png',mime:'image/png',data:(await pixels(4,4)).toString('base64')});
  await f.json(`/documents/${masked.id}/commands`,{baseRevision:masked.revision,commandId:'replace-after-submit',commands:[{type:'layer.update',layerId:'base',patch:{assetId:replacement.id,width:4,height:4}}]});
  f.service.store.addMessage(conversation.id,OWNER,{role:'user',text:'later-message-must-not-enter-this-run',references:[{assetId:replacement.id}],idempotencyKey:'later-only'});
  f.service.runner.start();const done=await f.terminal(jobId);assert.equal(done.state,'complete',done.error);assert.equal(posts,1);assert.equal(done.metrics.llmCalls,1);assert.equal(done.metrics.generationCalls||0,0);
  const state=f.service.store.jobRecord(jobId).private.agentState;assert.equal(state.referencePlan.images.find(image=>image.assetId===expected.asset.id).sourceHash,expected.asset.hash);assert.deepEqual(await f.bytes(expected.asset.id),expected.source);
});

test('requested chat model prioritizes a configured allowlist entry, persists it and rejects arbitrary overrides atomically',async t=>{
  const seen=[];const f=await harness(t,{config:{agent:{models:['default-model','chosen-model']}},fetchImpl:async(url,init)=>{seen.push(JSON.parse(init.body).model);return answer({content:'完成'});}});
  const {document}=await f.sourceDocument(),conversation=await f.json('/conversations',{documentId:document.id});
  assert.deepEqual((await f.json('/capabilities')).agent.models,['default-model','chosen-model']);
  const invalid=await f.request(`/conversations/${conversation.id}/messages`,{text:'invalid',model:'https://arbitrary.invalid/model',idempotencyKey:'invalid-model'});assert.equal(invalid.status,422);assert.equal((await f.json(`/documents/${document.id}/runs`)).length,0);assert.equal((await f.json(`/conversations/${conversation.id}/messages`)).length,0);assert.equal(seen.length,0);
  const body={text:'selected',model:'chosen-model',idempotencyKey:'chosen'},submitted=await f.json(`/conversations/${conversation.id}/messages`,body),done=await f.terminal(submitted.job.id);assert.equal(done.state,'complete',done.error);assert.deepEqual(seen,['chosen-model']);assert.equal(done.output.model,'chosen-model');
  assert.equal(f.service.store.jobRecord(submitted.job.id).private.input.model,'chosen-model');assert.equal(f.service.store.runRecord(submitted.run.id).private.input.model,'chosen-model');
  f.service.runner.config.agent.models=['new-config'];const replay=await f.json(`/conversations/${conversation.id}/messages`,body);assert.equal(replay.job.id,submitted.job.id);assert.equal(seen.length,1);
});

test('Agent inline export defaults to visible infinite-canvas bounds rather than clipping negative objects at 1024',async t=>{
  let posts=0;const f=await harness(t,{fetchImpl:async()=>{posts++;return posts===1?answer({tool_calls:[tool('move','apply_commands',{commands:[{type:'layer.update',layerId:'base',patch:{x:-50,y:-40}}]}),tool('export','export_document',{format:'png'})]}):answer({content:'已导出'});}});
  const {document,source}=await f.sourceDocument(),{job}=await f.run(document),done=await f.terminal(job.id);assert.equal(done.state,'complete',done.error||done.output?.message);
  const output=f.service.store.jobRecord(job.id).private.toolOutputs.tool_1_1,raw=await decodeRGBA(await f.bytes(output.assetId),'image/png');assert.deepEqual([raw.width,raw.height],[8,6]);assert.deepEqual(raw.data,(await decodeRGBA(source,'image/png')).data);
  const asset=(await f.json(`/documents/${done.output.branchDocumentId}/assets`)).find(item=>item.id===output.assetId);assert.deepEqual(asset.metadata.bounds,{x:-50,y:-40,width:8,height:6});
  assert.equal(done.metrics.generationCalls||0,0);assert.equal(posts,2);
});

test('vision reference preparation bounds dimensions and unique pixels without duplicating repeated asset payloads',async t=>{
  const f=await harness(t,{fetchImpl:async()=>{throw new Error('preview preparation must not contact providers');}}),doc=await f.json('/documents',{name:'bounded-reference-plan'}),references=[];
  for(let index=0;index<17;index++) {
    const width=index?4:4000,height=index?4:8,data=Buffer.alloc(width*height*4);for(let i=0;i<data.length;i+=4)data.set([index*11,40,120,255],i);
    const asset=await f.json('/assets',{documentId:doc.id,name:`reference-${index}.png`,mime:'image/png',data:(await encodePNG({width,height,data})).toString('base64')});references.push({assetId:asset.id,revision:0});
  }
  references.push(...references.slice(0,10));
  const prepared=await prepareAgentMessages(f.service.store,OWNER,[{id:'message',documentId:doc.id,role:'user',text:'ordered',revision:0,references}]),content=prepared.messages[0].content;
  assert.equal(prepared.referencePlan.images.length,16);assert.equal(content.filter(part=>part.type==='image_url').length,16);assert.equal(content.filter(part=>part.type==='text').length,28);assert.ok(prepared.referencePlan.images.every(image=>Math.max(image.width,image.height)<=1536));
  assert.ok(content.some(part=>part.type==='text'&&part.text.includes('Reference 17')&&part.text.includes('pixel budget')));assert.ok(prepared.referencePlan.totalBytes<=12*1024*1024);
});
