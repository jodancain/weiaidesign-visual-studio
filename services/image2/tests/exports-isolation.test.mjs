import test from 'node:test';
import assert from 'node:assert/strict';
import { documentPng, documentSvg } from '../exports.mjs';
import { decodeRGBA } from '../processors.mjs';

function svg(color, rootClass, opacity = 1) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" class="${rootClass}" opacity="${opacity}"><defs><linearGradient id="paint"><stop offset="0" stop-color="${color}"/><stop offset="1" stop-color="${color}"/></linearGradient></defs><style>.shape{fill:url(#paint)!important}.${rootClass} .shape{stroke:none}</style><rect class="shape" width="20" height="20"/></svg>`);
}
function fixture() {
  const assets = new Map([['left', { asset: { id:'left',mime:'image/svg+xml',width:20,height:20 }, bytes:svg('#ff0000','leftFrame',.5) }], ['right', { asset: { id:'right',mime:'image/svg+xml',width:20,height:20 }, bytes:svg('#0000ff','rightFrame') }]]);
  const document = { id:'isolation',name:'isolation',width:40,height:20,assetIds:['left','right'],layers:[
    {id:'left-layer',type:'vector',assetId:'left',x:0,y:0,width:20,height:20,rotation:0,opacity:1,visible:true,z:0},
    {id:'right-layer',type:'vector',assetId:'right',x:20,y:0,width:20,height:20,rotation:0,opacity:1,visible:true,z:1},
  ] };
  return {document,assets,getAsset:async id=>{assert.ok(assets.has(id));return assets.get(id);}};
}
const pixel = (raw,x,y) => [...raw.data.subarray((y*raw.width+x)*4,(y*raw.width+x)*4+4)];

test('two independent SVG assets may reuse gradient IDs and style classes without leaking paint', async () => {
  const f=fixture(),raw=await decodeRGBA(await documentPng(f.document,f.getAsset),'image/png');
  assert.deepEqual(pixel(raw,10,10),[255,0,0,128]);
  assert.deepEqual(pixel(raw,30,10),[0,0,255,255]);
  const {svg:exported}=await documentSvg(f.document,f.getAsset);
  const gradientIds=[...exported.matchAll(/linearGradient id="([^"]+)"/g)].map(m=>m[1]);
  assert.equal(gradientIds.length,2);assert.equal(new Set(gradientIds).size,2);
});

test('vector paint changes override important CSS only for the selected layer and retain original root opacity', async () => {
  const f=fixture(),original=Buffer.from(f.assets.get('left').bytes);
  const changed={...f.document,layers:f.document.layers.map(l=>l.id==='left-layer'?{...l,fill:'#00ff00'}:l)};
  const raw=await decodeRGBA(await documentPng(changed,f.getAsset),'image/png');
  assert.deepEqual(pixel(raw,10,10),[0,255,0,128]);
  assert.deepEqual(pixel(raw,30,10),[0,0,255,255]);
  assert.deepEqual(f.assets.get('left').bytes,original,'source SVG bytes are immutable');
});

test('distinct permitted layer ids do not collide after SVG namespace construction', async () => {
  const f=fixture(); f.assets.get('left').bytes=svg('#ff0000','leftFrame');
  const document={...f.document,layers:f.document.layers.map((l,index)=>({...l,id:index===0?'logo-1':'logo_1'}))};
  const raw=await decodeRGBA(await documentPng(document,f.getAsset),'image/png');
  assert.deepEqual(pixel(raw,10,10),[255,0,0,255]); assert.deepEqual(pixel(raw,30,10),[0,0,255,255]);
});
