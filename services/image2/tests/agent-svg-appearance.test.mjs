import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImageStore } from '../store.mjs';
import { ImageRunner } from '../jobs.mjs';
import { CONTENT_MIME } from '../domain-v3.mjs';
import { encodePNG } from '../processors.mjs';
import { renderNode } from '../render-node.mjs';
import { applyAgentCommands, writeAgentContent } from '../agent-control.mjs';

const OWNER='11111111-1111-4111-8111-111111111111';
const CONFIG={imageBaseUrl:'',imageApiKey:'',comfyBaseUrl:'',comfyToken:'',ocrUrl:'',ocrToken:'',agent:{baseUrl:'https://appearance-agent.fixture.invalid',apiKey:'synthetic-only',models:['stub'],timeoutMs:1000,maxTools:24,maxGenerations:4}};
const response=message=>Response.json({choices:[{message:{role:'assistant',...message}}]});
async function fixture(t,fetchImpl=async()=>{throw Error('No external requests allowed');},{proxy=true}={}){
  const directory=mkdtempSync(join(tmpdir(),'image2-agent-svg-proxy-')),store=new ImageStore(directory),runner=new ImageRunner({store,config:CONFIG,fetchImpl});
  t.after(async()=>{await runner.stop();store.close();rmSync(directory,{recursive:true,force:true});});
  const document=store.createDocument(OWNER,{schemaVersion:3,width:16,height:12});
  const sourceBytes=Buffer.from('<svg width="8" height="6" viewBox="0 0 8 6"><path id="p" d="M0 0H8V6H0Z" fill="red"/></svg>');
  const source=store.addAsset(document.id,OWNER,{name:'source.svg',mime:'image/svg+xml'},sourceBytes),other=store.addAsset(document.id,OWNER,{name:'other.svg',mime:'image/svg+xml'},Buffer.from(sourceBytes.toString().replace('red','green')));
  const appearanceBytes=await encodePNG({width:8,height:6,data:Buffer.from(Array.from({length:48},()=>[0,0,255,255]).flat())});
  const appearance=store.addAsset(document.id,OWNER,{name:'appearance.png',mime:'image/png'},appearanceBytes),font=store.addAsset(document.id,OWNER,{name:'font.woff2',mime:'font/woff2'},readFileSync(new URL('./fixtures/incomplete-cjk.woff2',import.meta.url)));
  const payload={formatVersion:1,kind:'svg',sourceAssetId:source.id,fontAssetIds:[],...(proxy?{appearanceAssetId:appearance.id}:{}),fill:'#ff0000',pathStyles:{p:{fill:'#ff0000'}}};
  const asset=store.addAsset(document.id,OWNER,{name:'svg-content.json',mime:CONTENT_MIME},Buffer.from(JSON.stringify(payload)));
  const main=store.command(document.id,OWNER,{baseRevision:0,commandId:'initial',commands:[{type:'content.add',content:{id:'svg-content',kind:'svg',assetId:asset.id,formatVersion:1}},{type:'layer.add',layer:{id:'svg',type:'vector',contentId:'svg-content',localBounds:{x:0,y:0,width:8,height:6},matrix:[1,0,0,1,2,3]}}]});
  const conversation=store.createConversation(OWNER,{documentId:main.id}),submitted=await runner.submitRun(OWNER,conversation.id,{text:'修改SVG颜色',idempotencyKey:'appearance-run'}),branchId=store.jobRecord(submitted.job.id).private.branchDocumentId;
  return {store,runner,main,source,sourceBytes,appearance,appearanceBytes,other,font,payload,...submitted,branchId,async pixels(){return renderNode(store.getDocument(branchId,OWNER),id=>store.getAsset(id,OWNER),{bounds:{x:0,y:0,width:16,height:12}});}};
}

test('Agent rejects paint, paths, fonts, source and proxy removal before saving content when an SVG target is displayed through its old appearance',async t=>{
  let requests=0;const f=await fixture(t,async()=>{requests++;throw Error('Network forbidden');}),before=f.store.getDocument(f.branchId,OWNER),assets=f.store.listAssets(f.branchId,OWNER).length,pixels=await f.pixels();
  const changes=[{fill:'#00ff00'},{pathStyles:{p:{fill:'#00ff00'}}},{pathStyles:{p:{stroke:'#000000',strokeWidth:2}}},{fontAssetIds:[f.font.id]},{sourceAssetId:f.other.id},{appearanceAssetId:undefined}];
  for(const [index,patch] of changes.entries())await assert.rejects(writeAgentContent(f.runner,f.job.id,f.branchId,OWNER,{targetLayerId:'svg',payload:{...f.payload,...patch}},`proxy-reject-${index}`),e=>e.code==='SVG_APPEARANCE_EDIT_UNAVAILABLE'&&e.status===422);
  assert.deepEqual(f.store.getDocument(f.branchId,OWNER),before);assert.equal(f.store.listRevisions(f.branchId,OWNER).length,1);assert.equal(f.store.listAssets(f.branchId,OWNER).length,assets);
  assert.ok(Buffer.from((await f.pixels()).pixels).equals(Buffer.from(pixels.pixels)));assert.ok(f.store.getAsset(f.source.id,OWNER).bytes.equals(f.sourceBytes));assert.ok(f.store.getAsset(f.appearance.id,OWNER).bytes.equals(f.appearanceBytes));assert.equal(requests,0);
});

test('Agent cannot bypass appearance protection by staging modified SVG JSON and attaching it through apply_commands',async t=>{
  const f=await fixture(t),before=f.store.getDocument(f.branchId,OWNER),modified={...f.payload,fill:'#00ff00'},asset=f.store.addAsset(f.branchId,OWNER,{name:'staged.json',mime:CONTENT_MIME},Buffer.from(JSON.stringify(modified))),commands=[{type:'content.add',content:{id:'staged',kind:'svg',assetId:asset.id,formatVersion:1}},{type:'layer.content',layerId:'svg',contentId:'staged'}];
  assert.throws(()=>applyAgentCommands(f.runner,f.job.id,f.branchId,OWNER,{commands},'proxy-stage-bypass'),e=>e.code==='SVG_APPEARANCE_EDIT_UNAVAILABLE');
  const after=f.store.getDocument(f.branchId,OWNER);assert.deepEqual(after.layers,before.layers);assert.deepEqual(after.contentAssets,before.contentAssets);assert.equal(after.revision,before.revision);
  const moved=applyAgentCommands(f.runner,f.job.id,f.branchId,OWNER,{commands:[{type:'layer.update',layerId:'svg',patch:{matrix:[1,0,0,1,4,3]}}]},'proxy-geometry');assert.equal(moved.revision,1);
});

test('Agent can still edit real SVG paths when there is no fixed appearance proxy',async t=>{
  const f=await fixture(t,undefined,{proxy:false});
  await writeAgentContent(f.runner,f.job.id,f.branchId,OWNER,{targetLayerId:'svg',payload:{...f.payload,fill:'#00ff00',pathStyles:{p:{fill:'#00ff00'}}}},'native-svg');
  const rendered=await f.pixels(),i=(5*16+5)*4;assert.deepEqual([...rendered.pixels.subarray(i,i+4)],[0,255,0,255]);assert.ok(f.store.getAsset(f.source.id,OWNER).bytes.equals(f.sourceBytes));
});

test('an LLM success message after a rejected appearance edit leaves the real Agent run awaiting_user and preserves blue pixels',async t=>{
  let calls=0,payload;const f=await fixture(t,async()=>{calls++;return calls===1?response({tool_calls:[{id:'paint',type:'function',function:{name:'write_content',arguments:JSON.stringify({targetLayerId:'svg',payload:{...payload,fill:'#00ff00'}})}}]}):response({content:'已改成绿色'});});payload=f.payload;
  f.runner.start();const deadline=Date.now()+60000;let done;
  while(Date.now()<deadline){const job=f.store.getJob(f.job.id,OWNER);if(['complete','failed','uncertain','cancelled','awaiting_user'].includes(job.state)){done=job;break;}await new Promise(resolve=>setTimeout(resolve,10));}
  assert.ok(done,'Agent appearance fixture deadline 60000ms exceeded');assert.equal(done.state,'awaiting_user');assert.match(done.output.message,/外观位图/);assert.equal(f.store.getRun(f.run.id,OWNER).state,'awaiting_user');
  assert.equal(f.store.jobRecord(done.id).private.toolOutputs.tool_1_0.code,'SVG_APPEARANCE_EDIT_UNAVAILABLE');assert.equal(f.store.getDocument(f.branchId,OWNER).layers[0].contentId,'svg-content');
  const rendered=await f.pixels(),i=(5*16+5)*4;assert.deepEqual([...rendered.pixels.subarray(i,i+4)],[0,0,255,255]);assert.equal(calls,2);assert.equal(done.metrics.generationCalls,0);assert.equal(done.metrics.visionCalls,0);
  assert.deepEqual(f.store.getDocument(f.main.id,OWNER),f.main);
});
