import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createImageService} from '../server.mjs';
import {CONTENT_MIME} from '../domain-v3.mjs';
import {decodeRGBA} from '../processors.mjs';
import {prepareAgentMessages} from '../agent.mjs';

const OWNER='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222',TOKEN='appearance-test-only-internal-token';
const SVG=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="192"><path id="left" d="M0 0H128V192H0Z" fill="#136a9f"/><path id="right" d="M128 0H256V192H128Z" fill="#136a9f"/></svg>');
const paints={left:{fill:'#f0c33c'},right:{fill:'#123abc'}};
async function fixture(t,schemaVersion){
  const directory=mkdtempSync(join(tmpdir(),'image2-layer-reference-'));let network=0;
  const service=createImageService({directory,token:TOKEN,config:{agent:{baseUrl:'',apiKey:''}},fetchImpl:async()=>{network++;throw Error('No model/network allowed');}});
  await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{service.server.closeAllConnections();await service.close();rmSync(directory,{recursive:true,force:true});});
  const {store,runner}=service,d=store.createDocument(OWNER,{schemaVersion,width:16,height:16}),asset=store.addAsset(d.id,OWNER,{name:'source.svg',mime:'image/svg+xml'},SVG),commands=[];
  if(schemaVersion===3){
    const c=store.addAsset(d.id,OWNER,{name:'svg.json',mime:CONTENT_MIME},Buffer.from(JSON.stringify({formatVersion:1,kind:'svg',sourceAssetId:asset.id,fontAssetIds:[],pathStyles:paints})));
    commands.push({type:'content.add',content:{id:'svg',kind:'svg',assetId:c.id,formatVersion:1}},...['first','second'].map((id,index)=>({type:'layer.add',layer:{id,type:'vector',contentId:'svg',localBounds:{x:0,y:0,width:256,height:192},matrix:[1,0,0,1,-700+index*500,-900]}})));
  }else commands.push(...['first','second'].map((id,index)=>({type:'layer.add',layer:{id,type:'vector',assetId:asset.id,width:256,height:192,x:-700+index*500,y:-900,metadata:{pathStyles:paints}}})));
  const document=store.command(d.id,OWNER,{baseRevision:0,commandId:'layers',commands});
  const origin=`http://127.0.0.1:${service.server.address().port}/api/v3/image2`;
  const call=(path,options={})=>fetch(origin+path,{method:options.method||'GET',headers:{authorization:`Bearer ${TOKEN}`,'x-studio-visitor-id':options.owner||OWNER,...options.headers}});
  return {store,runner,document,asset,call,get network(){return network;}};
}
const pixel=(raw,x,y)=>[...raw.data.subarray((y*raw.width+x)*4,(y*raw.width+x)*4+4)];
for(const schemaVersion of [2,3])test(`v${schemaVersion} selected SVG appearance uses edited paths outside canvas bounds, owner-checked frozen revisions and no jobs`,async t=>{
  const f=await fixture(t,schemaVersion),{document:d}=f,path=`/documents/${d.id}/layer-appearance/first?revision=1`,before=f.store.getDocument(d.id,OWNER),jobs=f.store.listJobs(d.id,OWNER),assets=f.store.listAssets(d.id,OWNER);
  const response=await f.call(path);assert.equal(response.status,200,await response.clone().text());assert.equal(response.headers.get('content-type'),'image/png');const bytes=Buffer.from(await response.arrayBuffer()),raw=await decodeRGBA(bytes,'image/png');
  assert.deepEqual([raw.width,raw.height],[256,192]);assert.deepEqual(pixel(raw,64,96),[240,195,60,255]);assert.deepEqual(pixel(raw,192,96),[18,58,188,255]);
  assert.deepEqual(f.store.getDocument(d.id,OWNER),before);assert.deepEqual(f.store.listJobs(d.id,OWNER),jobs);assert.deepEqual(f.store.listAssets(d.id,OWNER),assets);assert.deepEqual(f.store.getAsset(f.asset.id,OWNER).bytes,SVG);
  const otherDocument=f.store.createDocument(OWNER,{schemaVersion,width:16,height:16});assert.equal((await f.call(`/documents/${otherDocument.id}/layer-appearance/first?revision=0`)).status,404);
  const rotated=f.store.command(d.id,OWNER,{baseRevision:1,commandId:'rotate',commands:[{type:'layer.update',layerId:'first',patch:schemaVersion===3?{matrix:[0,1,-1,0,-700,-900]}:{rotation:90}}]});
  const next=await f.runner.layerAppearance(OWNER,d.id,'first',rotated.revision),rotatedRaw=await decodeRGBA(next.bytes,'image/png');assert.deepEqual([rotatedRaw.width,rotatedRaw.height],[192,256]);assert.deepEqual(pixel(rotatedRaw,96,64),[240,195,60,255]);
  const duplicate=await decodeRGBA((await f.runner.layerAppearance(OWNER,d.id,'second',rotated.revision)).bytes,'image/png');assert.deepEqual([duplicate.width,duplicate.height],[256,192]);
  assert.deepEqual(Buffer.from(await (await f.call(path)).arrayBuffer()),bytes);
  assert.equal((await f.call(path,{owner:OTHER})).status,404);assert.equal((await f.call(`/documents/${d.id}/layer-appearance/first`)).status,400);assert.equal((await f.call(`/documents/${d.id}/layer-appearance/first?revision=0`)).status,404);assert.equal((await f.call(`/documents/${d.id}/layer-appearance/missing?revision=1`)).status,404);
  const head=await f.call(path,{method:'HEAD'});assert.equal(head.headers.get('content-length'),String(bytes.length));assert.equal((await head.arrayBuffer()).byteLength,0);
  const range=await f.call(path,{headers:{range:'bytes=1-5'}});assert.equal(range.status,206);assert.deepEqual(Buffer.from(await range.arrayBuffer()),bytes.subarray(1,6));
  const etag=response.headers.get('etag');assert.equal((await f.call(path,{headers:{'if-none-match':etag}})).status,304);assert.equal(f.network,0);
});

for(const schemaVersion of [2,3])test(`v${schemaVersion} Agent layer-only references use the same rendered bytes; explicit history and failed rendering never substitute`,async t=>{
  const f=await fixture(t,schemaVersion),{document:d}=f,message={id:'message',documentId:d.id,role:'user',text:'参考',revision:d.revision,references:[{layerId:'first',revision:1},{assetId:f.asset.id,revision:1}]};
  const prepared=await prepareAgentMessages(f.store,OWNER,[message],{renderLayer:async(source,id)=>(await f.runner.layerAppearance(OWNER,source.id,id,source.revision)).bytes});
  assert.equal(prepared.referencePlan.images.length,2);
  const selected=prepared.referencePlan.images[0],historical=prepared.referencePlan.images[1];
  const raw=await decodeRGBA(readFileSync(join(f.store.blobs,selected.previewHash)),'image/png'),original=await decodeRGBA(readFileSync(join(f.store.blobs,historical.previewHash)),'image/png');
  assert.deepEqual(pixel(raw,64,96),[240,195,60,255]);assert.deepEqual(pixel(original,64,96),[19,106,159,255]);
  assert.equal(prepared.messages[0].content[1].text.includes('rendered_layer_appearance'),true);
  const failed=await prepareAgentMessages(f.store,OWNER,[{...message,references:[{layerId:'first',revision:1}]}],{renderLayer:async()=>{throw Object.assign(new Error('fixture'),{code:'render_failed'});}});
  assert.equal(failed.referencePlan.images.length,0);assert.match(failed.messages[0].content[1].text,/previewUnavailable/);assert.equal(f.network,0);
});
