import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exactPixelSvg } from '../pixel-trace.mjs';
import { normalizeSvg } from '../svg-normalize.mjs';
import { ImageStore } from '../store.mjs';
import { ImageRunner } from '../jobs.mjs';
import { documentPng } from '../exports.mjs';
import { decodeRGBA } from '../processors.mjs';
import { renderNode } from '../render-node.mjs';
import { prepareRenderGraph, SAMPLING_VERSION } from '../core/render-graph.mjs';

const OWNER='11111111-1111-4111-8111-111111111111';
const root=(body,attrs='')=>`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="12" viewBox="0 0 16 12" shape-rendering="crispEdges" ${attrs}>${body}</svg>`;
const path='<path fill="#ff0000" d="M1 2h4v6h-4Z"/>';

test('only certified integer pixel rectangles use nearest; CSS overrides, mixed SVG and nonrectangular closure retain linear sampling',()=>{
  const exact=root(path);
  assert.equal(normalizeSvg(exact).rasterSampling,'nearest');
  assert.equal(normalizeSvg(normalizeSvg(exact).svg).rasterSampling,'nearest');
  for(const svg of [
    root(path,'style="SHAPE-RENDERING:geometricPrecision"'),
    root(path.replace('<path','<path shape-rendering="auto"')),
    root(path.replace('<path','<path style="shape-rendering:geometricPrecision"')),
    root(path.replace('<path','<path transform="translate(1 0)"')),
    root(path,'transform="translate(1 0)"'),
    root(path+'<circle cx="6" cy="6" r="2"/>'),
    root(path+'<style>path{shape-rendering:auto}</style>'),
    root(path.replace('h-4Z','h-3Z')),
    root(path.replace('h4v6h-4','h0v6h-0')),
    root(path.replace('M1 2h4','M15 2h4')),
    root(path.replace('M1 2h4','M1.5 2h4')),
    root(path).replace('shape-rendering="crispEdges"',''),
  ])assert.equal(normalizeSvg(svg).rasterSampling,'linear',svg);
});

test('exact trace copy retains original editable SVG and zero decoded RGBA difference at integer half, native and double display sizes',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'image2-crisp-migration-')),store=new ImageStore(directory),runner=new ImageRunner({store,fetchImpl:async()=>{throw Error('No external calls');}});
  t.after(async()=>{await runner.stop();store.close();rmSync(directory,{recursive:true,force:true});});
  const width=16,height=12,data=Buffer.alloc(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)data.set((x+y)%3===0?[0,0,0,0]:[x%2?30:200,y%2?70:210,(x+y)%2?90:240,255],(y*width+x)*4);
  const traced=exactPixelSvg({width,height,data}),bytes=Buffer.from(traced.svg);
  for(const scale of [.5,1,2]){
    const document=store.createDocument(OWNER,{width:80,height:64}),asset=store.addAsset(document.id,OWNER,{name:'exact.svg',mime:'image/svg+xml',metadata:traced.metadata},bytes);
    store.command(document.id,OWNER,{baseRevision:0,commandId:'place',commands:[{type:'layer.add',layer:{id:'trace',type:'vector',assetId:asset.id,x:10,y:12,width:width*scale,height:height*scale}}]});
    const before=store.getDocument(document.id,OWNER),copy=store.migrateV3(document.id,OWNER,{sourceRevision:1,idempotencyKey:'crisp-copy'}),bounds={x:0,y:0,width:80,height:64};
    const rendered=await renderNode(copy.document,id=>store.getAsset(id,OWNER),{bounds}),original=await decodeRGBA(await documentPng(before,id=>store.getAsset(id,OWNER)),'image/png');
    assert.ok(Buffer.from(rendered.pixels).equals(original.data),`scale=${scale} changed appearance`);
    const content=copy.document.contentAssets.find(c=>c.id===copy.document.layers[0].contentId),payload=JSON.parse(store.getAsset(content.assetId,OWNER).bytes);
    assert.equal(payload.kind,'svg');assert.equal(payload.appearanceAssetId,undefined);assert.ok(store.getAsset(payload.sourceAssetId,OWNER).bytes.equals(bytes));
    const wire=await runner.renderResource(OWNER,copy.document.id,content.id,{revision:copy.document.revision,layerId:copy.document.layers[0].id,role:'content'});
    assert.equal(wire.sampling,'nearest');assert.equal(wire.pixelEncoding,'base64-rgba8');
    assert.equal(rendered.graph.samplingVersion,SAMPLING_VERSION);assert.ok(rendered.graph.cacheMaterial.includes(SAMPLING_VERSION));
  }
});

test('sampling mode and sampling rules version participate in cache identity; invalid modes fail before rendering',async()=>{
  const document={id:'sampling-cache',revision:1,schemaVersion:3,width:2,height:1,renderVersion:'weiai-rg-1',workingColor:{space:'srgb',bitDepth:8,alphaEncoding:'straight'},assetIds:['a'],contentAssets:[{id:'c',kind:'raster',assetId:'a',formatVersion:1}],layers:[{id:'l',type:'raster',contentId:'c',localBounds:{x:0,y:0,width:2,height:1},matrix:[1,0,0,1,0,0],z:0,visible:true,masks:[],effects:[]}]};
  const resource={kind:'raster',width:2,height:1,pixels:new Uint8Array([255,0,0,255,0,0,255,255]),hash:'same-pixel-hash'};
  const linear=await prepareRenderGraph(document,()=>({...resource,sampling:'linear'})),nearest=await prepareRenderGraph(document,()=>({...resource,sampling:'nearest'}));
  assert.notEqual(linear.cacheMaterial,nearest.cacheMaterial);assert.ok(nearest.cacheMaterial.includes(SAMPLING_VERSION));
  await assert.rejects(prepareRenderGraph(document,()=>({...resource,sampling:'unknown'})),e=>e.code==='RENDER_SAMPLING');
});
