import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {createHash} from 'node:crypto';
import {executeOperation,decodeRGBA,encodePNG,inspectAsset} from '../processors.mjs';

async function pixels(width,height,fn){
  const data=Buffer.alloc(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)data.set(fn(x,y),(y*width+x)*4);
  return {width,height,data};
}
async function harness(raw,{provenance=true,metadata={}}={}){
  const original=await encodePNG(raw),assets=new Map(),info=await inspectAsset(original,'image/png');
  assets.set('original',{asset:{id:'original',mime:'image/png',hash:createHash('sha256').update(original).digest('hex'),...info},bytes:original});
  const layer={id:'target',type:'raster',assetId:'original',...(provenance?{sourceAssetId:'original',sourceRect:[0,0,raw.width,raw.height]}:{}),width:raw.width,height:raw.height,x:0,y:0,z:0,metadata};
  let sequence=0;
  const ctx={document:{id:'doc',width:raw.width,height:raw.height,layers:[layer]},config:{},getAsset:async id=>{assert.ok(assets.has(id),`known immutable asset ${id}`);return assets.get(id);},
    saveAsset:async(_key,descriptor,bytes)=>{const asset={id:`saved-${++sequence}`,hash:createHash('sha256').update(bytes).digest('hex'),...descriptor};assets.set(asset.id,{asset,bytes:Buffer.from(bytes)});return asset;},
    checkpoint:async()=>{},cancelled:()=>false,fetchImpl:async()=>{throw new Error('Provider calls are forbidden in CPU visibility regressions');}};
  const run=async(operation,params={},inputs=[])=>{
    const result=await executeOperation({operation,params,inputs,targetLayerId:'target',idempotencyKey:`test-${sequence}`},ctx);
    for(const command of result.commands)if(command.type==='layer.update'&&command.layerId==='target')Object.assign(layer,command.patch);
    return result;
  };
  const read=async id=>{const record=await ctx.getAsset(id||layer.assetId);return decodeRGBA(record.bytes,record.asset.mime);};
  const addMask=async(id,width,height,fn)=>{const raw=await pixels(width,height,fn),bytes=await encodePNG(raw);assets.set(id,{asset:{id,mime:'image/png',width,height,hash:createHash('sha256').update(bytes).digest('hex')},bytes});return {role:'edit',assetId:id};};
  return {ctx,layer,assets,run,read,addMask,original};
}
function equalPixelsExcept(actual,expected,hidden){
  assert.deepEqual([actual.width,actual.height],[expected.width,expected.height]);
  for(let i=0;i<actual.width*actual.height;i++)assert.deepEqual(actual.data.subarray(i*4,i*4+4),hidden.has(i)?Buffer.alloc(4):expected.data.subarray(i*4,i*4+4),`pixel ${i%actual.width},${Math.floor(i/actual.width)}`);
}

test('crop then refine preserves all 1199 retained processed pixels instead of stretching original provenance',async()=>{
  const f=await harness(await pixels(120,80,(x,y)=>[x*2,y*3,50,255]));
  await f.run('crop',{x:20,y:10,width:40,height:30});const cropped=await f.read();
  assert.deepEqual([...cropped.data.subarray(0,4)],[40,30,50,255]);
  const mask=await f.addMask('visible',40,30,(x,y)=>x===20&&y===15?[0,0,0,255]:[255,255,255,255]);
  const result=await f.run('refine_mask',{},[mask]),actual=await f.read();
  equalPixelsExcept(actual,cropped,new Set([15*40+20]));
  assert.equal(f.layer.sourceAssetId,'original');assert.deepEqual(f.layer.sourceRect,[0,0,120,80]);
  assert.deepEqual(f.layer.metadata.visibilitySourceRect,[0,0,40,30]);
  assert.ok(f.assets.get(result.output.assetId).asset.inputs.some(ref=>ref.role==='visibility_source'&&ref.assetId===f.layer.metadata.visibilitySourceAssetId&&ref.hash.length===64));
  assert.deepEqual(f.assets.get('original').bytes,f.original,'original bytes remain immutable');
});

for(const [operation,params]of [['rotate',{degrees:90}],['rotate',{degrees:23}],['flip',{axis:'horizontal'}],['flip',{axis:'vertical'}],['recolor',{color:'#30ad71',mode:'luminance'}]]){
  test(`${operation} ${JSON.stringify(params)} then refine retains processed orientation and colour`,async()=>{
    const f=await harness(await pixels(18,12,(x,y)=>[20+x*9,30+y*11,80+(x+y)%20,255]));
    await f.run('crop',{x:2,y:1,width:12,height:8});
    await f.run(operation,params);const processed=await f.read();
    const hx=Math.floor(processed.width/2),hy=Math.floor(processed.height/2);
    const mask=await f.addMask('visible',processed.width,processed.height,(x,y)=>x===hx&&y===hy?[0,0,0,255]:[255,255,255,255]);
    await f.run('refine_mask',{},[mask]);equalPixelsExcept(await f.read(),processed,new Set([hy*processed.width+hx]));
    assert.deepEqual(f.layer.sourceRect,[0,0,18,12]);assert.equal(f.layer.sourceAssetId,'original');
  });
}

test('active-mask hidden pixels follow crop, rotation, flip, recolour and exact nearest resize before recovery',async()=>{
  const source=await pixels(12,10,(x,y)=>x===5&&y===3?[0,0,0,0]:[x*17,y*19,70,255]),f=await harness(source);
  await f.addMask('initial-mask',12,10,(x,y)=>x>=4&&x<7&&y>=2&&y<5?[0,0,0,255]:[255,255,255,255]);f.layer.maskAssetId='initial-mask';
  const sourceRecord=f.assets.get('original');
  const expectedCrop=await sharp(sourceRecord.bytes).extract({left:2,top:1,width:8,height:6}).png().toBuffer();
  const expectedRotation=await sharp(expectedCrop).rotate(90).png().toBuffer();
  const expectedFlip=await sharp(expectedRotation).flop().png().toBuffer();
  const expectedBytes=await sharp(expectedFlip).resize(12,16,{kernel:'nearest',fit:'fill'}).png().toBuffer();
  const expected=await decodeRGBA(expectedBytes,'image/png');
  for(let i=0;i<expected.width*expected.height;i++){const j=i*4;if(expected.data[j+3]){expected.data[j]=240;expected.data[j+1]=60;expected.data[j+2]=120;}else expected.data.fill(0,j,j+4);}
  await f.run('crop',{x:2,y:1,width:8,height:6});await f.run('rotate',{degrees:90});await f.run('flip',{axis:'horizontal'});await f.run('resize',{width:12,height:16,kernel:'nearest'});await f.run('recolor',{color:'#f03c78',mode:'flatten'});
  const before=await f.read();assert.ok(before.data.some((v,i)=>i%4===3&&v===0));
  const mask=await f.addMask('all-visible',12,16,()=>[255,255,255,255]);
  await f.run('refine_mask',{},[mask]);assert.deepEqual((await f.read()).data,expected.data,'known masked pixels recover in processed coordinates; truly transparent source pixels stay unknown');
  assert.deepEqual(f.layer.sourceRect,[0,0,12,10]);assert.equal(f.layer.sourceAssetId,'original');
});

test('erase and successive visibility masks preserve their immutable colour baseline for reopening',async()=>{
  const f=await harness(await pixels(8,6,(x,y)=>[x*23,y*29,100,255]),{provenance:false});
  await f.run('recolor',{color:'#447799',mode:'flatten'});const coloured=await f.read();
  const eraseMask=await f.addMask('erase-area',8,6,x=>x>=4?[255,255,255,255]:[0,0,0,255]);
  await f.run('erase',{},[eraseMask]);assert.equal((await f.read()).data[(5)*4+3],0);
  const narrow=await f.addMask('narrow',8,6,x=>x<2?[255,255,255,255]:[0,0,0,255]);
  await f.run('refine_mask',{},[narrow]);
  const full=await f.addMask('full',8,6,()=>[255,255,255,255]);await f.run('refine_mask',{},[full]);
  assert.deepEqual((await f.read()).data,coloured.data,'mask reopening restores the latest colours, never the first original source');
});

test('legacy processed patches with no valid visibility baseline conservatively retain their current cropped pixels',async()=>{
  const f=await harness(await pixels(12,10,(x,y)=>[x*17,y*19,70,255]));
  const crop=await sharp(f.original).extract({left:2,top:1,width:6,height:4}).png().toBuffer();
  f.assets.set('legacy-crop',{asset:{id:'legacy-crop',mime:'image/png',metadata:{operation:'crop'}},bytes:crop});f.layer.assetId='legacy-crop';f.layer.width=6;f.layer.height=4;f.layer.metadata={operation:'crop'};
  const expected=await f.read(),mask=await f.addMask('visible',6,4,()=>[255,255,255,255]);await f.run('refine_mask',{},[mask]);
  assert.deepEqual((await f.read()).data,expected.data);assert.deepEqual(f.layer.sourceRect,[0,0,12,10]);
});

test('geometry clears old edit and visibility selection coordinates but retains their audit references',async()=>{
  const oldKeys=['editMaskAssetId','protectMaskAssetId','visibilityMaskAssetId','visibilityProtectMaskAssetId'];
  for(const [operation,params]of [['resize',{width:16,height:12}],['crop',{x:1,y:1,width:6,height:4}],['pad',{width:10,height:8}],['rotate',{degrees:180}],['flip',{axis:'horizontal'}]]){
    const metadata=Object.fromEntries(oldKeys.map((key,i)=>[key,`old-${i}`])),f=await harness(await pixels(8,6,(x,y)=>[x*23,y*29,100,255]),{metadata});
    await f.run(operation,params);
    for(const key of oldKeys){assert.equal(f.layer.metadata[key],null,`${operation} clears ${key}`);assert.equal(f.layer.metadata[`previous${key[0].toUpperCase()}${key.slice(1)}`],metadata[key]);}
  }
});

test('restoration freezes only previously visible input pixels, so refining cannot reconstruct input-mask occlusions',async()=>{
  const f=await harness(await pixels(8,6,(x,y)=>[x*23,y*29,100,255]));
  await f.addMask('input-mask',8,6,x=>x<4?[255,255,255,255]:[0,0,0,255]);f.layer.maskAssetId='input-mask';
  const result=await executeOperation({operation:'restore_layers',targetLayerId:'target',params:{ocr:false,segment:false,connected:false}},f.ctx);
  const patch=result.commands.find(c=>c.type==='layer.add').layer;patch.id='target';delete patch.parentId;f.ctx.document.layers=[patch];Object.assign(f.layer,patch);f.ctx.document.layers=[f.layer];
  assert.notEqual(f.layer.metadata.visibilitySourceAssetId,'original');
  const all=await f.addMask('all',8,6,()=>[255,255,255,255]);await f.run('refine_mask',{},[all]);const actual=await f.read();
  for(let y=0;y<6;y++)for(let x=0;x<8;x++)assert.equal(actual.data[(y*8+x)*4+3],x<4?255:0);
  assert.equal(result.output.differentChannels,0);assert.deepEqual(f.assets.get('original').bytes,f.original);
});
