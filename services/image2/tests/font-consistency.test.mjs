import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImageStore } from '../store.mjs';
import { documentSvg, documentPng, documentPdf } from '../exports.mjs';
import { decodeRGBA, inspectAsset } from '../processors.mjs';

const owner='11111111-1111-4111-8111-111111111111';
const regular=readFileSync(new URL('../fonts/NotoSansCJKsc-Regular.otf',import.meta.url));
const subset=readFileSync(new URL('./fixtures/incomplete-cjk.woff2',import.meta.url));
const assets=new Map([['regular',{asset:{id:'regular',mime:'font/otf',metadata:{family:'Noto Sans CJK SC'}},bytes:regular}],['subset',{asset:{id:'subset',mime:'font/woff2',metadata:{family:'Noto Sans CJK SC'}},bytes:subset}]]);
const getAsset=async id=>assets.get(id);
const layer=(id,text,fontAssetId='regular',patch={})=>({id,type:'text',text,fontAssetId,fontSize:48,fontWeight:400,x:0,y:0,width:400,height:80,rotation:0,opacity:1,visible:true,z:0,fill:'#000000',metadata:{fontConfirmed:true},...patch});
const doc=layers=>({id:'font-test',name:'font-test',width:400,height:160,updatedAt:'2026-10-12T00:00:00Z',layers});

test('font byte weight overrides requested synthetic weight and forged asset metadata in authoring state',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'image2-real-font-')),store=new ImageStore(directory);t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const document=store.createDocument(owner,{}),info=await inspectAsset(regular,'font/otf');assert.equal(info.metadata.weight,400);
  const font=store.addAsset(document.id,owner,{name:'Noto.otf',mime:'font/otf',metadata:{family:'forged',weight:700}},regular);
  assert.equal(font.metadata.weight,400);assert.equal(font.metadata.family,'Noto Sans CJK SC');
  const updated=store.command(document.id,owner,{baseRevision:0,commandId:'requested-bold',commands:[{type:'layer.add',layer:layer('title','中文',font.id,{fontWeight:700,fontFamily:'forged'})}]});
  assert.equal(updated.layers[0].fontWeight,400);assert.equal(updated.layers[0].fontFamily,'Noto Sans CJK SC');
  const changed=store.command(document.id,owner,{baseRevision:1,commandId:'requested-bold-again',commands:[{type:'layer.update',layerId:'title',patch:{fontWeight:700}}]});assert.equal(changed.layers[0].fontWeight,400);
});

test('SVG retains distinct per-asset true text fonts even when two files share the same family',async()=>{
  const document=doc([layer('full','中文完整'),layer('subset','中','subset',{y:80})]),result=await documentSvg(document,getAsset);
  assert.equal(result.fonts.size,2);assert.equal([...result.svg.matchAll(/@font-face/g)].length,2);
  const families=[...result.svg.matchAll(/<text font-family="([^"]+)"/g)].map(m=>m[1]);assert.equal(new Set(families).size,2);assert.equal(families.length,2);
  assert.equal([...result.svg.matchAll(/font-weight="400"/g)].length,2);
});

test('PNG uses each registered glyph file rather than losing full CJK glyphs to a same-family subset',async()=>{
  const title=layer('full','中文完整'),expected=await decodeRGBA(await documentPng(doc([title]),getAsset),'image/png');
  const actual=await decodeRGBA(await documentPng(doc([title,layer('subset','中','subset',{y:80})]),getAsset),'image/png');
  assert.deepEqual(actual.data.subarray(0,400*80*4),expected.data.subarray(0,400*80*4));
  const standalone=await decodeRGBA(await documentPng(doc([layer('subset','中','subset')]),getAsset),'image/png');
  assert.deepEqual(actual.data.subarray(400*80*4),standalone.data.subarray(0,400*80*4));
});

test('PNG and PDF do not invent bold glyphs when only a regular font file is present',async()=>{
  const regularDoc=doc([layer('title','中文 MAI')]),requestedBold=doc([layer('title','中文 MAI','regular',{fontWeight:700})]);
  assert.deepEqual(await documentPng(regularDoc,getAsset),await documentPng(requestedBold,getAsset));
  // PDF's trailer IDs are random; glyph layout and embedded font streams are deterministic.
  const streams=bytes=>[...bytes.toString('latin1').matchAll(/stream\n([\s\S]*?)\nendstream/g)].map(match=>match[1]);
  assert.deepEqual(streams(await documentPdf(regularDoc,getAsset)),streams(await documentPdf(requestedBold,getAsset)));
});

test('original four bundled WOFF2 font slots keep exact bytes, render Chinese and embed in real PDF',async()=>{
  for (const name of ['source-han-sans','source-han-serif','smiley-sans','lxgw-wenkai']) {
    const bytes=readFileSync(new URL(`../../../public/fonts/${name}.woff2`,import.meta.url)),info=await inspectAsset(bytes,'font/woff2');
    assert.equal(info.mime,'font/woff2'); assert.ok(info.metadata.family);assert.ok(info.metadata.weight>0);
    const getFont=async id=>{assert.equal(id,name);return {asset:{id:name,mime:'font/woff2',metadata:info.metadata},bytes};};
    const fixture=doc([layer('text','中文 MAI',name)]),svg=(await documentSvg(fixture,getFont)).svg;
    assert.ok(svg.includes(`data:font/woff2;base64,${bytes.toString('base64')}`));assert.match(svg,/<text font-family="i2-font-/);
    const png=await decodeRGBA(await documentPng(fixture,getFont),'image/png');assert.ok(png.data.some((a,i)=>i%4===3&&a>0),name);
    const pdf=await documentPdf(fixture,getFont);assert.equal(pdf.toString('ascii',0,5),'%PDF-');assert.match(pdf.toString('latin1'),/\/FontFile[23]?/);
  }
});
