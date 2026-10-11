import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { documentPng, documentSvg, documentPdf } from '../exports.mjs';
import { encodePNG, decodeRGBA } from '../processors.mjs';

const HAS_POPPLER = spawnSync('pdftoppm',['-v'],{encoding:'utf8',timeout:5000}).status === 0;
const pixel = (raw,x,y) => [...raw.data.subarray((y * raw.width + x) * 4,(y * raw.width + x) * 4 + 4)];
const layer = (id,type,patch={}) => ({id,type,x:0,y:0,width:20,height:20,rotation:0,opacity:1,visible:true,z:0,...patch});
const document = (layers,width=160,height=60) => ({id:'export-layout',name:'layout',width,height,layers,updatedAt:'2026-10-10T00:00:00Z'});
async function color(id,rgba) {
  const data=Buffer.alloc(20*20*4);for(let i=0;i<data.length;i+=4)data.set(rgba,i);
  return {asset:{id,mime:'image/png',width:20,height:20},bytes:await encodePNG({width:20,height:20,data})};
}
function load(assets) { return async id=>{assert.ok(assets.has(id),id);return assets.get(id);}; }
async function pdfPixels(t,doc,getAsset) {
  const directory=mkdtempSync(join(tmpdir(),'image2-export-layout-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const pdf=join(directory,'fixture.pdf'),png=join(directory,'render');writeFileSync(pdf,await documentPdf(doc,getAsset));
  const run=spawnSync('pdftoppm',['-singlefile','-r','72','-png',pdf,png],{encoding:'utf8',timeout:15000});
  assert.equal(run.status,0,run.stderr);return decodeRGBA(readFileSync(png+'.png'),'image/png');
}
const font = {asset:{id:'font',mime:'font/otf',metadata:{family:'Noto Sans CJK SC'}},bytes:readFileSync(new URL('../fonts/NotoSansCJKsc-Regular.otf',import.meta.url))};
function inkBounds(raw) {
  let minX=raw.width,maxX=-1,minY=raw.height,maxY=-1;
  for(let y=0;y<raw.height;y++)for(let x=0;x<raw.width;x++) { const p=pixel(raw,x,y);if(p[3]>100&&p[0]<100&&p[1]<100&&p[2]<100) { minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y); } }
  return {minX,maxX,minY,maxY};
}

test('PNG and PDF traverse a whole group subtree before a higher root sibling regardless of child z', {skip:!HAS_POPPLER}, async t=>{
  const assets=new Map([['red',await color('red',[255,0,0,255])],['blue',await color('blue',[0,0,255,255])]]),getAsset=load(assets);
  const doc=document([layer('group','group'),layer('red-child','raster',{parentId:'group',assetId:'red',z:100}),layer('blue-root','raster',{assetId:'blue',z:1})],20,20);
  assert.deepEqual(pixel(await decodeRGBA(await documentPng(doc,getAsset),'image/png'),10,10),[0,0,255,255]);
  assert.deepEqual(pixel(await pdfPixels(t,doc,getAsset),10,10),[0,0,255,255]);
});

test('real Chinese font text extends past a tiny editing box in both PNG and PDF using matching line baselines', {skip:!HAS_POPPLER}, async t=>{
  const getAsset=load(new Map([['font',font]])),doc=document([layer('text','text',{text:'中文ABC中文ABC\n第二行',fontAssetId:'font',fontSize:24,fill:'#000000',width:1,height:1,x:10})],300,72);
  const png=await decodeRGBA(await documentPng(doc,getAsset),'image/png'),pdf=await pdfPixels(t,doc,getAsset),a=inkBounds(png),b=inkBounds(pdf);
  for(const bounds of [a,b]) {assert.ok(bounds.maxX>100,JSON.stringify(bounds));assert.ok(bounds.maxY>35,JSON.stringify(bounds));}
  assert.ok(Math.abs(a.minY-b.minY)<=3,JSON.stringify({a,b}));assert.ok(Math.abs(a.maxY-b.maxY)<=3,JSON.stringify({a,b}));
});

test('moving confirmed text does not paint its already detached clean background a second time in SVG, PNG or PDF', {skip:!HAS_POPPLER}, async t=>{
  const assets=new Map([['clean',await color('clean',[255,0,0,255])],['font',font]]),getAsset=load(assets);
  const doc=document([layer('background','raster',{assetId:'clean',width:40,height:30}),layer('moved-text','text',{x:90,text:'中',fontAssetId:'font',fontSize:24,fill:'#000000',width:40,height:30,z:1,metadata:{fontConfirmed:true,cleanBackgroundAssetId:'clean',backgroundDetached:true}})],160,60);
  const {svg}=await documentSvg(doc,getAsset);assert.equal([...svg.matchAll(/<image /g)].length,1);
  const png=await decodeRGBA(await documentPng(doc,getAsset),'image/png'),pdf=await pdfPixels(t,doc,getAsset);
  assert.deepEqual(pixel(png,10,10),[255,0,0,255]);assert.deepEqual(pixel(pdf,10,10),[255,0,0,255]);
  assert.equal(pixel(png,95,29)[3],0);assert.deepEqual(pixel(pdf,95,29),[255,255,255,255]);
  assert.ok(inkBounds(png).minX>=90);assert.ok(inkBounds(pdf).minX>=90);
});
