import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ImageStore} from '../store.mjs';
import {ImageRunner} from '../jobs.mjs';
import {registry,encodePNG,decodeRGBA} from '../processors.mjs';
import {V3_CPU_OPERATIONS} from '../processors-v3.mjs';
import {CONTENT_MIME} from '../domain-v3.mjs';
import {allowedAgentOperations,buildAgentTools,projectAgentDocument,applyAgentCommands,writeAgentContent,readAgentContent} from '../agent-control.mjs';

const OWNER='11111111-1111-4111-8111-111111111111';
const CONFIG={imageBaseUrl:'',imageApiKey:'',comfyBaseUrl:'',comfyToken:'',ocrUrl:'',ocrToken:'',agent:{baseUrl:'https://agent.fixture.invalid/v1',apiKey:'synthetic-agent-key',models:['stub'],timeoutMs:1000,maxTools:24,maxGenerations:4}};
const tool=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}}),answer=message=>Response.json({choices:[{message:{role:'assistant',...message}}]});
function fixture(t,fetchImpl=async()=>{throw Error('No real external calls are allowed');},config={}){
  const directory=mkdtempSync(join(tmpdir(),'image2-agent-control-'));let store=new ImageStore(directory),runner;
  const open=()=>{runner=new ImageRunner({store,config:{...CONFIG,...config,agent:{...CONFIG.agent,...config.agent}},fetchImpl});};open();
  t.after(async()=>{await runner.stop();store.close();rmSync(directory,{recursive:true,force:true});});
  return {get store(){return store;},get runner(){return runner;},async reopen(){await runner.stop();store.close();store=new ImageStore(directory);open();},async finish(id){runner.start();const until=Date.now()+60000;while(Date.now()<until){const job=store.getJob(id,OWNER);if(['complete','failed','uncertain','cancelled','awaiting_user'].includes(job.state))return job;await new Promise(resolve=>setTimeout(resolve,10));}const record=store.jobRecord(id),state=record.private.agentState;throw Error(`Agent fixture deadline 60000ms exceeded: ${JSON.stringify({jobId:id,state:record.job.state,stage:record.job.stage,phase:state?.phase,round:state?.round,toolIndex:state?.callIndex,pendingTools:state?.pending?.length,active:runner.active.has(id)})}`);}};
}
async function base(f,{preserved=false,layers=[]}={}){
  const document=f.store.createDocument(OWNER,{schemaVersion:3,name:'Professional fixture 中文',width:160,height:100}),width=8,height=6,data=Buffer.alloc(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)data.set([x*23,y*31,90,255],(y*width+x)*4);
  const bytes=await encodePNG({width,height,data}),asset=f.store.addAsset(document.id,OWNER,{name:'source.png',mime:'image/png'},bytes);
  let content={id:'source-content',kind:'raster',assetId:asset.id,formatVersion:1};
  if(preserved){const payload={formatVersion:1,kind:'preservedText',text:'原中文',desiredText:'待改中文',fontStatus:'unknown',assetId:asset.id,status:'preserved'},json=f.store.addAsset(document.id,OWNER,{name:'preserved.json',mime:CONTENT_MIME},Buffer.from(JSON.stringify(payload)));content={...content,kind:'preservedText',assetId:json.id};}
  const current=f.store.command(document.id,OWNER,{baseRevision:0,commandId:'base',commands:[{type:'content.add',content},{type:'layer.add',layer:{id:'base',type:preserved?'text':'raster',contentId:content.id,localBounds:{x:0,y:0,width,height},matrix:[1,0,0,1,0,0],metadata:preserved?{role:'sourcePatch',fontStatus:'unknown'}:{} }},...layers.map(layer=>({type:'layer.add',layer}))]});
  return {document:current,asset,bytes,data,content};
}
async function run(f,document){const conversation=f.store.createConversation(OWNER,{documentId:document.id});return {...await f.runner.submitRun(OWNER,conversation.id,{text:'执行合成测试，不调用真实付费模型',idempotencyKey:'run'}),conversation};}
const contextOf=body=>JSON.parse(body.messages.findLast(m=>m.role==='system'&&m.content.startsWith('Current authoritative')).content.split(': ').slice(1).join(': '));

test('registry drives Agent discovery and v3 only advertises executable CPU operations with actual config gating',async t=>{
  const f=fixture(t),caps=await f.runner.capabilities();
  assert.deepEqual(allowedAgentOperations(),Object.keys(registry).filter(name=>name!=='export'));
  assert.deepEqual(allowedAgentOperations({schemaVersion:3}),Object.keys(registry).filter(name=>V3_CPU_OPERATIONS.includes(name)&&registry[name].executionClass==='cpu'));
  assert.equal(caps.professional.agent.available,true);assert.deepEqual(caps.professional.agent.executionClasses,['cpu']);assert.equal(caps.professional.models.available,false);
  const operations=buildAgentTools({schemaVersion:3}).find(tool=>tool.function.name==='image_operation').function.parameters.properties.operation.enum;
  assert.deepEqual(operations,caps.professional.agent.allowedOperations);for(const name of ['generate','inpaint','matting','segment','super_resolution','restore_layers'])assert.ok(!operations.includes(name));
  assert.ok(buildAgentTools({schemaVersion:3}).some(tool=>tool.function.name==='write_content'));
  const off=fixture(t,undefined,{agent:{baseUrl:'',apiKey:''}});assert.equal((await off.runner.capabilities()).professional.agent.available,false);const doc=off.store.createDocument(OWNER,{schemaVersion:3}),conversation=off.store.createConversation(OWNER,{documentId:doc.id});await assert.rejects(off.runner.submitRun(OWNER,conversation.id,{text:'x',idempotencyKey:'off'}),error=>error.code==='V3_OPERATION_UNAVAILABLE');assert.deepEqual(off.store.listJobs(doc.id,OWNER),[]);
});

test('v3 Agent executes real pixels, COW native text/vector, professional commands and export exclusively on its durable branch',async t=>{
  let posts=0;const f=fixture(t,async(url,init)=>{
    assert.equal(String(url),'https://agent.fixture.invalid/v1/chat/completions');const body=JSON.parse(init.body),state=contextOf(body);posts++;
    assert.equal(state.schemaVersion,3);assert.ok(Array.isArray(state.contentAssets));assert.ok(state.layers.every(l=>Array.isArray(l.masks)&&Array.isArray(l.effects)));
    if(posts===1)return answer({tool_calls:[
      tool('flip','image_operation',{operation:'flip',targetLayerId:'base',params:{axis:'horizontal'}}),
      tool('text','write_content',{payload:{formatVersion:1,kind:'text',text:'中文 MAI',fontSize:24,fill:'#000000'},layer:{id:'title',name:'中文标题',localBounds:{x:0,y:0,width:130,height:30},matrix:[1,0,0,1,8,24],z:2}}),
      tool('logo','write_content',{payload:{formatVersion:1,kind:'vector',viewBox:[0,0,16,16],paths:[{id:'p1',d:'M0 0H16V16H0Z',fill:'#00ff00'}],resources:[]},layer:{id:'logo',name:'Logo',localBounds:{x:0,y:0,width:16,height:16},matrix:[1,0,0,1,130,70],z:3}}),
      tool('professional','apply_commands',{commands:[{type:'selection.upsert',selection:{id:'selection',contentId:'source-content',name:'真实选区'}},{type:'artboard.upsert',artboard:{id:'board',bounds:{x:0,y:0,width:160,height:100},name:'作品'}},{type:'guide.upsert',guide:{id:'guide',axis:'x',position:80}},{type:'layer.update',layerId:'base',patch:{blendMode:'multiply',effects:[{id:'blur',type:'gaussianBlur',params:{sigma:0}}]}}]}),
      tool('export','export_document',{format:'png',bounds:{x:0,y:0,width:160,height:100}}),
    ]});
    if(posts===2){const text=state.authoredContents.find(item=>item.payload?.kind==='text'),vector=state.authoredContents.find(item=>item.payload?.kind==='vector');assert.equal(text.payload.text,'中文 MAI');assert.ok(text.payload.fontAssetId);assert.equal(vector.payload.paths[0].fill,'#00ff00');assert.ok(state.registeredFonts.some(font=>font.id===text.payload.fontAssetId&&font.metadata.family==='Noto Sans CJK SC'));return answer({tool_calls:[tool('read','read_content',{contentId:vector.contentId})]});}
    return answer({content:'已完成候选版本。'});
  });
  const b=await base(f),submitted=await run(f,b.document),done=await f.finish(submitted.job.id);assert.equal(done.state,'complete',done.error||done.output?.message);assert.equal(posts,3);assert.equal(done.metrics.llmCalls,3);assert.equal(done.metrics.generationCalls,0);assert.equal(done.metrics.visionCalls,0);
  const branch=f.store.getDocument(done.output.branchDocumentId,OWNER),main=f.store.getDocument(b.document.id,OWNER);assert.deepEqual(main.layers,b.document.layers);assert.equal(main.revision,1);assert.deepEqual(main.assetIds,b.document.assetIds);assert.ok(branch.layers.some(l=>l.id==='title'));assert.equal(branch.savedSelections.length,1);assert.equal(branch.artboards.length,1);assert.equal(branch.guides.length,1);
  const outputs=f.store.jobRecord(done.id).private.toolOutputs,raw=await decodeRGBA(f.store.getAsset(outputs.tool_1_0.assetId,OWNER).bytes,'image/png');assert.deepEqual([...raw.data.subarray(0,4)],[161,0,90,255]);
  assert.ok(done.output.previewAssetId);assert.deepEqual(done.output.assetIds,[done.output.previewAssetId]);assert.equal(f.store.getAsset(done.output.previewAssetId,OWNER).asset.mime,'image/png');
  const exported=f.store.getAsset(outputs.tool_1_4.assetId,OWNER),rendered=await decodeRGBA(exported.bytes,'image/png');assert.deepEqual([rendered.width,rendered.height],[160,100]);assert.deepEqual([...rendered.data.subarray((75*160+135)*4,(75*160+135)*4+4)],[0,255,0,255]);assert.deepEqual(f.store.getAsset(b.asset.id,OWNER).bytes,b.bytes);assert.equal(outputs.tool_2_0.payload.paths[0].id,'p1');
});

test('ancestor transforms/effects and shared immutable content cannot alter a locked layer through Agent commands',async t=>{
  const f=fixture(t),b=await base(f,{layers:[{id:'group',type:'group'},{id:'locked',type:'raster',parentId:'group',locked:true,contentId:'source-content',localBounds:{x:0,y:0,width:8,height:6}}]}),submitted=await run(f,b.document),record=f.store.jobRecord(submitted.job.id),branchId=record.private.branchDocumentId,before=f.store.getDocument(branchId,OWNER);
  for(const [i,patch] of [{matrix:[1,0,0,1,10,0]},{opacity:.5},{effects:[{id:'blur',type:'gaussianBlur',params:{sigma:1}}]}].entries())assert.throws(()=>applyAgentCommands(f.runner,submitted.job.id,branchId,OWNER,{commands:[{type:'layer.update',layerId:'group',patch}]},`attempt_${i}`),error=>error.code==='layer_locked');
  assert.throws(()=>applyAgentCommands(f.runner,submitted.job.id,branchId,OWNER,{commands:[{type:'content.add',content:{...b.content,assetId:'different'}}]},'shared'),error=>error.code==='content_identity_conflict');
  const result=await writeAgentContent(f.runner,submitted.job.id,branchId,OWNER,{payload:{formatVersion:1,kind:'vector',paths:[{id:'p',d:'M0 0H1V1Z',fill:'#f00'}]},layer:{id:'new-vector',localBounds:{x:0,y:0,width:1,height:1}}},'safe-new');assert.ok(result.contentId);assert.deepEqual(f.store.getDocument(branchId,OWNER).layers.find(l=>l.id==='locked'),before.layers.find(l=>l.id==='locked'));
});

test('unknown preserved text rejects content/metadata/delete bypasses and permits only sourced desiredText updates',async t=>{
  const f=fixture(t),b=await base(f,{preserved:true}),submitted=await run(f,b.document),record=f.store.jobRecord(submitted.job.id),branchId=record.private.branchDocumentId,before=f.store.getDocument(branchId,OWNER);
  for(const [i,commands] of [[{type:'layer.remove',layerId:'base'}],[{type:'layer.update',layerId:'base',patch:{metadata:{fontConfirmed:true}}}],[{type:'layer.update',layerId:'base',patch:{contentId:'missing'}}]].entries())assert.throws(()=>applyAgentCommands(f.runner,submitted.job.id,branchId,OWNER,{commands},`attack_${i}`),error=>['font_confirmation_required','invalid_request'].includes(error.code));
  await assert.rejects(writeAgentContent(f.runner,submitted.job.id,branchId,OWNER,{targetLayerId:'base',payload:{formatVersion:1,kind:'text',text:'假确认',fontSize:20}},'replace'),error=>error.code==='font_confirmation_required');
  const original=readAgentContent(f.store,before,OWNER,{contentId:b.content.id}).payload;
  await assert.rejects(writeAgentContent(f.runner,submitted.job.id,branchId,OWNER,{targetLayerId:'base',payload:{...original,text:'偷改原文'}},'forge'),error=>error.code==='font_confirmation_required');
  const output=await writeAgentContent(f.runner,submitted.job.id,branchId,OWNER,{targetLayerId:'base',payload:{...original,desiredText:'用户待确认的新文字'}},'desired'),after=f.store.getDocument(branchId,OWNER),payload=readAgentContent(f.store,after,OWNER,{contentId:output.contentId}).payload;assert.equal(payload.fontStatus,'unknown');assert.equal(payload.text,original.text);assert.equal(payload.assetId,b.asset.id);assert.equal(payload.desiredText,'用户待确认的新文字');assert.deepEqual(f.store.getAsset(b.asset.id,OWNER).bytes,b.bytes);
});

test('write_content and prepared native commands survive a lost acknowledgement without duplicate IDs, fonts or revisions',async t=>{
  const f=fixture(t),b=await base(f),submitted=await run(f,b.document),record=f.store.jobRecord(submitted.job.id),branch=record.private.branchDocumentId;
  const args={payload:{formatVersion:1,kind:'text',text:'中文',fontSize:24},layer:{id:'title',localBounds:{x:0,y:0,width:100,height:30}}},first=await writeAgentContent(f.runner,submitted.job.id,branch,OWNER,args,'content'),assetCount=f.store.listAssets(branch,OWNER).length;
  await f.reopen();const second=await writeAgentContent(f.runner,submitted.job.id,branch,OWNER,args,'content');assert.equal(second.contentId,first.contentId);assert.equal(f.store.getDocument(branch,OWNER).revision,1);assert.equal(f.store.listAssets(branch,OWNER).length,assetCount);
  const commands={commands:[{type:'guide.upsert',guide:{id:'persistent',axis:'x',position:15}}]},one=applyAgentCommands(f.runner,submitted.job.id,branch,OWNER,commands,'commands');await f.reopen();const two=applyAgentCommands(f.runner,submitted.job.id,branch,OWNER,commands,'commands');assert.equal(one.revision,two.revision);assert.equal(f.store.getDocument(branch,OWNER).guides.length,1);
});

test('model tools omitted from v3 discovery remain rejected at execution even if an LLM invents them',async t=>{
  let posts=0;const f=fixture(t,async(url)=>{assert.equal(String(url),'https://agent.fixture.invalid/v1/chat/completions');posts++;return posts===1?answer({tool_calls:[tool('rogue','image_operation',{operation:'generate',params:{prompt:'must never reach image provider'}})]}):answer({content:'模型入口未接通'});});
  const b=await base(f),submitted=await run(f,b.document),done=await f.finish(submitted.job.id);assert.equal(done.state,'awaiting_user');assert.equal(done.metrics.generationCalls,0);assert.equal(done.metrics.visionCalls,0);assert.equal(f.store.jobRecord(done.id).private.agentState.generations,0);assert.equal(f.store.jobRecord(done.id).private.toolOutputs.tool_1_0.code,'V3_OPERATION_UNAVAILABLE');assert.deepEqual(f.store.getDocument(done.output.branchDocumentId,OWNER).layers,b.document.layers);
  const cancelled=f.runner.cancel(OWNER,done.id);assert.equal(cancelled.state,'cancelled');assert.equal(f.store.getRun(submitted.run.id,OWNER).state,'cancelled');
});

test('actual content reads enforce branch membership and explicit payload limits',async t=>{
  const f=fixture(t),b=await base(f),other=f.store.createDocument(OWNER,{schemaVersion:3}),foreign=f.store.addAsset(other.id,OWNER,{name:'other.png',mime:'image/png'},b.bytes);assert.throws(()=>readAgentContent(f.store,b.document,OWNER,{assetId:foreign.id}),error=>error.code==='CONTENT_RESOURCE_UNREGISTERED');
  const large={formatVersion:1,kind:'vector',paths:Array.from({length:5000},(_,i)=>({id:`p${i}`,d:'M0 0H1V1Z',fill:'#000000'}))},asset=f.store.addAsset(b.document.id,OWNER,{name:'large.json',mime:CONTENT_MIME},Buffer.from(JSON.stringify(large))),doc=f.store.command(b.document.id,OWNER,{baseRevision:1,commandId:'large',commands:[{type:'content.add',content:{id:'large',kind:'vector',assetId:asset.id,formatVersion:1}}]});assert.throws(()=>readAgentContent(f.store,doc,OWNER,{contentId:'large'}),error=>error.code==='AGENT_CONTENT_BUDGET');const projection=projectAgentDocument(f.store,doc,OWNER);assert.equal(projection.authoredContents.find(item=>item.contentId==='large').omitted,'AGENT_CONTENT_BUDGET');assert.ok(projection.contentAssets.some(item=>item.id==='large'));
});

test('completed v3 preview and final acknowledgement recover without repeating the chat model or preview export',async t=>{
  let posts=0;const f=fixture(t,async()=>{posts++;return answer({content:'当前候选已保存'});}),b=await base(f),submitted=await run(f,b.document),done=await f.finish(submitted.job.id);assert.equal(done.state,'complete');assert.ok(done.output.previewAssetId);assert.equal(posts,1);
  await f.runner.stop();const assets=f.store.listAssets(done.output.branchDocumentId,OWNER).length;f.store.updateJob(done.id,{state:'running'});f.store.updateRun(submitted.run.id,{state:'running'});await f.reopen();const recovered=await f.finish(done.id);assert.equal(recovered.state,'complete');assert.equal(recovered.output.previewAssetId,done.output.previewAssetId);assert.equal(posts,1);assert.equal(f.store.listAssets(done.output.branchDocumentId,OWNER).length,assets);
});

test('v3 layer references include actual frozen visible PNG pixels with reference order and repeated images deduplicated',async t=>{
  let posts=0;const f=fixture(t,async(url,init)=>{
    assert.equal(String(url),'https://agent.fixture.invalid/v1/chat/completions');posts++;const body=JSON.parse(init.body),user=body.messages.find(message=>message.role==='user'),images=user.content.filter(part=>part.type==='image_url'),references=user.content.filter(part=>part.type==='text'&&part.text.startsWith('Reference '));assert.equal(images.length,1);assert.equal(references.length,2);assert.match(references[0].text,/rendered_layer_appearance/);assert.match(references[0].text,/图一/);assert.match(references[1].text,/图二/);
    const bytes=Buffer.from(images[0].image_url.url.split(',')[1],'base64'),raw=await decodeRGBA(bytes,'image/png');assert.deepEqual([raw.width,raw.height],[8,6]);assert.deepEqual([...raw.data.subarray(0,4)],[0,0,90,255]);return answer({content:'已查看原图参考。'});
  }),b=await base(f),conversation=f.store.createConversation(OWNER,{documentId:b.document.id}),submitted=await f.runner.submitRun(OWNER,conversation.id,{text:'比较图一和图二',references:[{layerId:'base',revision:b.document.revision},{layerId:'base',revision:b.document.revision}],idempotencyKey:'ordered'}),done=await f.finish(submitted.job.id);assert.equal(done.state,'complete');assert.equal(posts,1);assert.equal(f.store.jobRecord(done.id).private.agentState.referencePlan.images.length,1);assert.equal(done.output.previewRevision,f.store.getDocument(done.output.branchDocumentId,OWNER).revision);
});

test('new registered adjust/filter CPU tools are discovered and execute real protected pixels through the v3 Agent',async t=>{
  let posts=0,inputs;const f=fixture(t,async(url,init)=>{
    assert.equal(String(url),'https://agent.fixture.invalid/v1/chat/completions');posts++;const body=JSON.parse(init.body),schema=body.tools.find(tool=>tool.function.name==='image_operation');assert.ok(schema.function.parameters.properties.operation.enum.includes('adjust'));assert.ok(schema.function.parameters.properties.operation.enum.includes('filter'));assert.match(schema.function.description,/brightness/);assert.match(schema.function.description,/gaussian_blur/);
    return posts===1?answer({tool_calls:[tool('adjust','image_operation',{operation:'adjust',targetLayerId:'base',inputs,params:{kind:'invert'}}),tool('filter','image_operation',{operation:'filter',targetLayerId:'base',inputs,params:{kind:'median',size:3}})]}):answer({content:'已保存CPU调色和传统滤镜候选。'});
  }),b=await base(f);
  const mask=async(name,predicate)=>{const data=Buffer.alloc(8*6*4);for(let y=0;y<6;y++)for(let x=0;x<8;x++){const v=predicate(x,y)?255:0;data.set([v,v,v,255],(y*8+x)*4);}return f.store.addAsset(b.document.id,OWNER,{name,mime:'image/png'},await encodePNG({width:8,height:6,data}));};
  const edit=await mask('edit.png',x=>x<4),protect=await mask('protect.png',x=>x<2);inputs=[{role:'edit',assetId:edit.id},{role:'protect',assetId:protect.id}];const main=f.store.getDocument(b.document.id,OWNER),submitted=await run(f,main),done=await f.finish(submitted.job.id);assert.equal(done.state,'complete',done.error||done.output?.message);assert.equal(done.metrics.generationCalls,0);assert.equal(done.metrics.visionCalls,0);assert.equal(done.metrics.llmCalls,2);
  const output=f.store.jobRecord(done.id).private.toolOutputs.tool_1_1,raw=await decodeRGBA(f.store.getAsset(output.assetId,OWNER).bytes,'image/png');let edited=0;
  for(let y=0;y<6;y++)for(let x=0;x<8;x++){const j=(y*8+x)*4;if(x<2||x>=4)assert.deepEqual(raw.data.subarray(j,j+4),b.data.subarray(j,j+4));else if(!raw.data.subarray(j,j+4).equals(b.data.subarray(j,j+4)))edited++;}assert.ok(edited>0);assert.deepEqual(f.store.getDocument(b.document.id,OWNER).layers,main.layers);assert.deepEqual(f.store.getAsset(b.asset.id,OWNER).bytes,b.bytes);
});

async function waitFor(check){const end=Date.now()+10000;while(Date.now()<end){const value=check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Controlled cancellation window timed out');}

test('cancelling an outstanding LLM reply persists its received tools but cannot apply any returned command',async t=>{
  let respond,posts=0;const response=new Promise(resolve=>{respond=resolve;}),f=fixture(t,async()=>{posts++;return response;}),b=await base(f),submitted=await run(f,b.document),branchId=f.store.jobRecord(submitted.job.id).private.branchDocumentId;
  f.runner.start();await waitFor(()=>f.store.jobRecord(submitted.job.id).private.agentState?.phase==='llm_submitting');f.runner.cancel(OWNER,submitted.job.id);
  respond(answer({tool_calls:[tool('late','apply_commands',{commands:[{type:'document.update',patch:{name:'must-not-commit'}}]})]}));await waitFor(()=>!f.runner.active.size);
  assert.equal(f.store.getJob(submitted.job.id,OWNER).state,'cancelled');assert.equal(f.store.getRun(submitted.run.id,OWNER).state,'cancelled');assert.equal(f.store.getDocument(branchId,OWNER).revision,0);assert.equal(f.store.getDocument(branchId,OWNER).name,b.document.name);assert.equal(posts,1);
  const record=f.store.jobRecord(submitted.job.id);assert.equal(record.private.agentState.phase,'received');assert.equal(record.private.agentState.pending[0].id,'late');assert.equal(record.private.toolOutputs,undefined);
});

test('cancellation between tools retains the first committed receipt and forbids every subsequent command',async t=>{
  let posts=0;const f=fixture(t,async()=>{posts++;return answer({tool_calls:[tool('first','apply_commands',{commands:[{type:'document.update',patch:{name:'completed-first'}}]}),tool('second','apply_commands',{commands:[{type:'guide.upsert',guide:{id:'must-not-exist',axis:'x',position:10}}]})]});}),b=await base(f),submitted=await run(f,b.document);
  const add=f.store.addMessage.bind(f.store);f.store.addMessage=(...args)=>{const result=add(...args);if(args[2]?.idempotencyKey===`tool-output:${submitted.job.id}:tool_1_0`)f.runner.cancel(OWNER,submitted.job.id);return result;};
  const done=await f.finish(submitted.job.id);assert.equal(done.state,'cancelled');const record=f.store.jobRecord(done.id),branch=f.store.getDocument(record.private.branchDocumentId,OWNER);assert.equal(branch.revision,1);assert.equal(branch.name,'completed-first');assert.equal(branch.guides.length,0);assert.ok(record.private.toolOutputs.tool_1_0);assert.equal(record.private.toolOutputs.tool_1_1,undefined);assert.equal(posts,1);assert.equal(f.store.getRun(submitted.run.id,OWNER).state,'cancelled');
});

for(const checkpoint of ['saveAsset','checkpoint'])test(`write_content cancellation after awaiting ${checkpoint} preserves immutable output without committing its layer`,async t=>{
  const f=fixture(t),b=await base(f),submitted=await run(f,b.document),branchId=f.store.jobRecord(submitted.job.id).private.branchDocumentId;f.store.updateJob(submitted.job.id,{state:'running'});
  const context=f.runner.context.bind(f.runner);f.runner.context=(...args)=>{const ctx=context(...args),save=ctx.saveAsset,saveCheckpoint=ctx.checkpoint;
    if(checkpoint==='saveAsset')ctx.saveAsset=async(...saveArgs)=>{const asset=await save(...saveArgs);f.runner.cancel(OWNER,submitted.job.id);return asset;};
    else ctx.checkpoint=async patch=>{await saveCheckpoint(patch);if(patch.agentContentResult)f.runner.cancel(OWNER,submitted.job.id);};
    return ctx;
  };
  await assert.rejects(writeAgentContent(f.runner,submitted.job.id,branchId,OWNER,{payload:{formatVersion:1,kind:'vector',paths:[{id:'p',d:'M0 0H10V10H0Z',fill:'#00ff00'}]},layer:{id:'cancelled-vector',localBounds:{x:0,y:0,width:10,height:10}}},'cancel_content'),error=>error.code==='CANCELLED');
  const record=f.store.jobRecord(submitted.job.id),assetId=record.private.checkpoints['cancel_content:content_payload'];assert.ok(assetId);assert.equal(f.store.getAsset(assetId,OWNER).asset.mime,CONTENT_MIME);const branch=f.store.getDocument(branchId,OWNER);assert.equal(branch.revision,0);assert.equal(branch.layers.some(l=>l.id==='cancelled-vector'),false);assert.deepEqual(branch.layers,b.document.layers);assert.equal(f.store.getRun(submitted.run.id,OWNER).state,'cancelled');
});

test('locked clipped layer protects its unlocked base visibility and its actual rendered appearance',async t=>{
  const f=fixture(t),b=await base(f,{layers:[{id:'locked-clip',type:'raster',contentId:'source-content',clipToLayerId:'base',locked:true,z:1,localBounds:{x:0,y:0,width:8,height:6}}]}),submitted=await run(f,b.document),branchId=f.store.jobRecord(submitted.job.id).private.branchDocumentId,before=f.store.getDocument(branchId,OWNER),getAsset=id=>f.store.getAsset(id,OWNER),pixelsBefore=await f.runner.exportArtifact('png',before,{getAsset});
  assert.throws(()=>applyAgentCommands(f.runner,submitted.job.id,branchId,OWNER,{commands:[{type:'layer.update',layerId:'base',patch:{visible:false}}]},'hide-base'),error=>error.code==='layer_locked');
  const after=f.store.getDocument(branchId,OWNER),pixelsAfter=await f.runner.exportArtifact('png',after,{getAsset});assert.equal(after.revision,0);assert.deepEqual(after.layers,before.layers);assert.ok((await decodeRGBA(pixelsBefore.bytes,'image/png')).data.equals((await decodeRGBA(pixelsAfter.bytes,'image/png')).data));
});

test('locked clipping follows base groups, their children, ancestors and nested clipping dependencies',async t=>{
  const f=fixture(t),b=await base(f,{layers:[
    {id:'ancestor',type:'group',z:1},{id:'upstream',type:'group',parentId:'ancestor',z:0},{id:'upstream-pixels',type:'raster',contentId:'source-content',parentId:'upstream',localBounds:{x:0,y:0,width:8,height:6}},
    {id:'base-group',type:'group',parentId:'ancestor',z:1,clipToLayerId:'upstream'},{id:'group-pixels',type:'raster',contentId:'source-content',parentId:'base-group',localBounds:{x:0,y:0,width:8,height:6}},
    {id:'locked-clip',type:'raster',contentId:'source-content',parentId:'ancestor',clipToLayerId:'base-group',locked:true,z:2,localBounds:{x:0,y:0,width:8,height:6}},
  ]}),submitted=await run(f,b.document),branchId=f.store.jobRecord(submitted.job.id).private.branchDocumentId,before=f.store.getDocument(branchId,OWNER);
  for(const [i,commands] of [
    [{type:'layer.update',layerId:'group-pixels',patch:{visible:false}}],
    [{type:'layer.update',layerId:'upstream-pixels',patch:{opacity:.5}}],
    [{type:'layer.update',layerId:'ancestor',patch:{matrix:[1,0,0,1,20,10]}}],
    [{type:'layer.add',layer:{id:'extra-alpha',type:'raster',contentId:'source-content',parentId:'base-group',localBounds:{x:0,y:0,width:8,height:6},matrix:[1,0,0,1,30,0]}}],
  ].entries())assert.throws(()=>applyAgentCommands(f.runner,submitted.job.id,branchId,OWNER,{commands},`dependency_${i}`),error=>error.code==='layer_locked');
  assert.deepEqual(f.store.getDocument(branchId,OWNER).layers,before.layers);assert.equal(f.store.getDocument(branchId,OWNER).revision,0);
});

test('inline CPU erase/adjust proposals cannot alter an unlocked clipping base of a locked layer',async t=>{
  const f=fixture(t),b=await base(f,{layers:[{id:'locked-clip',type:'raster',contentId:'source-content',clipToLayerId:'base',locked:true,z:1,localBounds:{x:0,y:0,width:8,height:6}}]}),submitted=await run(f,b.document),branchId=f.store.jobRecord(submitted.job.id).private.branchDocumentId,before=f.store.getDocument(branchId,OWNER),mask=f.store.addAsset(branchId,OWNER,{name:'edit.png',mime:'image/png'},await encodePNG({width:8,height:6,data:Buffer.alloc(8*6*4,255)}));
  for(const [operation,params] of [['erase',{}],['adjust',{kind:'invert'}]]){
    await assert.rejects(f.runner.executeInline(submitted.job.id,branchId,OWNER,{operation,targetLayerId:'base',params,inputs:[{role:'edit',assetId:mask.id}]},`blocked_${operation}`),error=>error.code==='layer_locked');
    const record=f.store.jobRecord(submitted.job.id);assert.ok(record.private.toolStates[`blocked_${operation}`].processorState.v3ProcessorResult,'completed CPU result remains checkpointed');
    assert.equal(f.store.getDocument(branchId,OWNER).revision,0);assert.deepEqual(f.store.getDocument(branchId,OWNER).layers,before.layers);
  }
  assert.deepEqual(f.store.getAsset(b.asset.id,OWNER).bytes,b.bytes);
});

test('a locked child does not freeze unrelated unlocked siblings or new siblings in an ordinary parent group',async t=>{
  const f=fixture(t),b=await base(f,{layers:[{id:'ordinary-group',type:'group',z:1},{id:'locked-child',type:'raster',contentId:'source-content',parentId:'ordinary-group',locked:true,z:0,localBounds:{x:0,y:0,width:8,height:6}},{id:'unlocked-sibling',type:'raster',contentId:'source-content',parentId:'ordinary-group',z:1,localBounds:{x:0,y:0,width:8,height:6},matrix:[1,0,0,1,30,0]}]}),submitted=await run(f,b.document),branchId=f.store.jobRecord(submitted.job.id).private.branchDocumentId,before=f.store.getDocument(branchId,OWNER);
  const result=applyAgentCommands(f.runner,submitted.job.id,branchId,OWNER,{commands:[{type:'layer.update',layerId:'unlocked-sibling',patch:{opacity:.5,matrix:[1,0,0,1,40,0]}},{type:'layer.add',layer:{id:'new-sibling',type:'raster',contentId:'source-content',parentId:'ordinary-group',z:2,localBounds:{x:0,y:0,width:8,height:6},matrix:[1,0,0,1,60,0]}}]},'safe-siblings');
  const after=f.store.getDocument(branchId,OWNER);assert.equal(result.revision,1);assert.equal(after.layers.find(l=>l.id==='unlocked-sibling').opacity,.5);assert.ok(after.layers.some(l=>l.id==='new-sibling'));assert.deepEqual(after.layers.find(l=>l.id==='locked-child'),before.layers.find(l=>l.id==='locked-child'));
});
