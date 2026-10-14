import test from 'node:test';
import assert from 'node:assert/strict';
import { exactPixelSvg } from '../pixel-trace.mjs';
import { adjustPixels, filterPixels } from '../pixel-adjust.mjs';
import { executeOperation, encodePNG, decodeRGBA, inspectAsset, registry } from '../processors.mjs';
import { V3_CPU_OPERATIONS } from '../processors-v3.mjs';

const raw=(width,height,fn)=>{const data=Buffer.alloc(width*height*4);for(let y=0;y<height;y++)for(let x=0;x<width;x++)data.set(fn(x,y),(y*width+x)*4);return {width,height,data};};
async function fixture(source) {
  const bytes=await encodePNG(source),assets=new Map([['source',{asset:{id:'source',mime:'image/png',width:source.width,height:source.height},bytes}]]);
  let sequence=0,fetches=0;
  const context={document:{id:'doc',width:source.width,height:source.height,layers:[{id:'layer',type:'raster',assetId:'source',x:42,y:-17,width:source.width*3,height:source.height*3,rotation:27,z:0}]},config:{},getAsset:async id=>assets.get(id),saveAsset:async(key,descriptor,bytes)=>{const info=await inspectAsset(bytes,descriptor.mime),asset={...descriptor,...info,id:`saved-${++sequence}`};assets.set(asset.id,{asset,bytes});return asset;},checkpoint:async()=>{},cancelled:()=>false,fetchImpl:async()=>{fetches++;throw Error('Unexpected model call');}};
  return {assets,context,get fetches(){return fetches;},async run(operation,params,inputs=[]){const result=await executeOperation({operation,targetLayerId:'layer',params,inputs,idempotencyKey:'synthetic'},context);return {result,pixels:result.output.metadata.preset==='exact'?null:await decodeRGBA(assets.get(result.output.assetId).bytes,'image/png')};}};
}

test('exact trace preserves opaque original colours, single dots, holes and disconnected one-pixel lines',async()=>{
  const source=raw(23,19,(x,y)=>{if(x===0||y===0||x===22||y===18)return [248,241,232,255];if(x===2&&y===2)return [211,215,217,255];if(x===4||y===7)return [30,80,140,255];if(x>=10&&x<=16&&y>=10&&y<=16 && !(x>=12&&x<=14&&y>=12&&y<=14))return [0,0,0,255];return [0,0,0,0];});
  const traced=exactPixelSvg(source),round=await decodeRGBA(Buffer.from(traced.svg),'image/svg+xml');
  assert.deepEqual(round.data,source.data);assert.equal(traced.metadata.approximation,false);
  assert.equal(traced.metadata.pixelBoundariesExact,true);assert.doesNotMatch(traced.svg,/<image|stroke=|filter=/);
  assert.match(traced.svg,/#d3d7d9/);
});
test('exact trace retains SVG alpha values, reports renderer quantisation, and does not claim hidden RGB',async()=>{
  const source=raw(2,1,x=>x?[255,0,0,0]:[3,7,17,13]),traced=exactPixelSvg(source),round=await decodeRGBA(Buffer.from(traced.svg),'image/svg+xml');
  assert.match(traced.svg,/#030711/);assert.equal(round.data[3],13);assert.equal(traced.metadata.translucentRenderRounding,true);assert.equal(traced.metadata.hiddenTransparentRgbPreserved,false);
  for(let c=0;c<3;c++)assert.ok(Math.abs(Math.round(source.data[c]*13/255)-Math.round(round.data[c]*13/255))<=1);
});
test('exact trace rejects excessive complexity instead of quantising or pruning detail',()=>{
  const source=raw(8,8,(x,y)=>[(x+y)%2*255,0,0,255]);
  assert.throws(()=>exactPixelSvg(source,{maxRectangles:3}),error=>error.code==='TRACE_BUDGET');
  assert.throws(()=>exactPixelSvg(source,{maxPixels:4}),error=>error.code==='TRACE_BUDGET');
});
test('adjustments have neutral identity settings, known inversions and stable alpha',()=>{
  const source=raw(5,4,(x,y)=>[x*49,y*69,93,(x+y)*23]);
  for(const [kind,value] of [['brightness',0],['contrast',0],['exposure',0],['saturation',0],['hue',0],['gamma',1]])assert.deepEqual(adjustPixels(source,{kind,value}).data,source.data,kind);
  assert.deepEqual(adjustPixels(source,{kind:'levels',black:0,white:255,gamma:1}).data,source.data);
  const inverted=adjustPixels(source,{kind:'invert'});for(let i=0;i<source.data.length;i++)assert.equal(inverted.data[i],i%4===3?source.data[i]:255-source.data[i]);
  const gray=adjustPixels(source,{kind:'grayscale'});for(let i=0;i<gray.data.length;i+=4){assert.equal(gray.data[i],gray.data[i+1]);assert.equal(gray.data[i],gray.data[i+2]);assert.equal(gray.data[i+3],source.data[i+3]);}
  assert.throws(()=>adjustPixels(source,{kind:'brightness',value:'20'}),/finite/);assert.throws(()=>adjustPixels(source,{kind:'levels',black:100,white:20}),/smaller/);
});
test('filters preserve alpha and dimensions; blur does not leak hidden red into visible blue',async()=>{
  const source=raw(9,9,(x,y)=>x>=3&&x<=5&&y>=3&&y<=5?[0,0,255,255]:[255,0,0,0]);
  for(const kind of ['gaussian_blur','sharpen','median']){const output=await filterPixels(source,{kind});assert.equal(output.width,9);assert.equal(output.height,9);for(let i=3;i<output.data.length;i+=4)assert.equal(output.data[i],source.data[i]);if(kind==='gaussian_blur')assert.deepEqual([...output.data.subarray((4*9+4)*4,(4*9+4)*4+4)],[0,0,255,255]);}
  await assert.rejects(filterPixels(source,{kind:'median',size:4}),/3, 5/);
  const isolated=raw(5,5,(x,y)=>x===2&&y===2?[0,0,255,128]:[255,0,0,0]);
  assert.deepEqual([...(await filterPixels(isolated,{kind:'median',size:3})).data.subarray(48,52)],[0,0,255,128]);
});
test('Gaussian and sharpen preserve uniform translucent colour down to alpha 1',async()=>{
  for(const alpha of [1,13,50,128,255]) {
    const source=raw(9,9,()=>[100,50,25,alpha]);
    for(const kind of ['gaussian_blur','sharpen'])assert.deepEqual((await filterPixels(source,{kind,radius:2})).data,source.data,`${kind} alpha ${alpha}`);
  }
  const variedCoverage=raw(11,9,(x,y)=>[100,50,25,1+(x*31+y*17)%255]);
  for(const kind of ['gaussian_blur','sharpen'])assert.deepEqual((await filterPixels(variedCoverage,{kind,radius:3})).data,variedCoverage.data,`${kind} varied coverage`);
});
test('real processor workers keep edit/protect pixels, source, layout and alpha while making zero model calls',async()=>{
  const source=raw(9,7,(x,y)=>[x*22,y*31,84,150+x*7]);
  for(const [operation,params] of [['adjust',{kind:'invert'}],['filter',{kind:'gaussian_blur',radius:1}]]) {
    const f=await fixture(source);
    for(const [id,predicate] of [['edit',x=>x<6],['protect',x=>x<2]])f.assets.set(id,{asset:{id,mime:'image/png'},bytes:await encodePNG(raw(9,7,(x,y)=>{const v=predicate(x,y)?255:0;return [v,v,v,255];}))});
    const {result,pixels}=await f.run(operation,params,[{role:'edit_mask',assetId:'edit'},{role:'protect_mask',assetId:'protect'}]);
    for(let y=0;y<7;y++)for(let x=0;x<9;x++){const i=(y*9+x)*4;assert.equal(pixels.data[i+3],source.data[i+3]);if(x<2||x>=6)assert.deepEqual(pixels.data.subarray(i,i+4),source.data.subarray(i,i+4));}
    const patch={...f.context.document.layers[0],...result.commands[0].patch};assert.deepEqual([patch.x,patch.y,patch.width,patch.height,patch.rotation],[42,-17,27,21,27]);assert.deepEqual((await decodeRGBA(f.assets.get('source').bytes,'image/png')).data,source.data);assert.equal(f.fetches,0);assert.equal(registry[operation].executionClass,'cpu');assert.ok(V3_CPU_OPERATIONS.includes(operation));
  }
});
test('exact tracing executes through the registry worker and normaliser with editable paths',async()=>{
  const source=raw(7,5,(x,y)=>x===y?[107,111,119,255]:[0,0,0,0]),f=await fixture(source);
  const {result}=await f.run('trace',{preset:'exact'}),asset=f.assets.get(result.output.assetId);
  assert.equal(asset.asset.mime,'image/svg+xml');assert.deepEqual((await decodeRGBA(asset.bytes,asset.asset.mime)).data,source.data);assert.equal(result.output.metadata.approximation,false);assert.equal(result.commands[0].patch.type,'vector');assert.equal(f.fetches,0);
});
