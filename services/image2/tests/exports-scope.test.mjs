import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportDocument, scopedExportDocument } from '../exports.mjs';
import { encodePNG, decodeRGBA } from '../processors.mjs';
import { unzipSync, strFromU8 } from 'fflate';

const hasPoppler = spawnSync('pdftoppm', ['-v'], { timeout: 5000 }).status === 0;
const layer = (id, type, patch = {}) => ({ id, type, x: 0, y: 0, width: 8, height: 6, rotation: 0, opacity: 1, visible: true, locked: false, z: 0, ...patch });
const document = layers => ({ id: 'scope-test', name: 'scope', revision: 1, schemaVersion: 2, width: 100, height: 100, layers, assetIds: ['red','blue','white','mask'], updatedAt: '2026-10-12T00:00:00Z' });
const pixel = (raw, x, y) => [...raw.data.subarray((y * raw.width + x) * 4, (y * raw.width + x) * 4 + 4)];
async function assets() {
  const result = new Map();
  for (const [id, paint] of [['red',[255,0,0,255]],['blue',[0,0,255,255]],['white',[255,255,255,255]]]) {
    const data = Buffer.alloc(8 * 6 * 4); for (let i = 0; i < data.length; i += 4) data.set(paint, i);
    result.set(id, { asset: { id, mime: 'image/png', width: 8, height: 6 }, bytes: await encodePNG({ width: 8, height: 6, data }) });
  }
  const data = Buffer.alloc(8 * 6 * 4);
  for (let y = 0; y < 6; y++) for (let x = 0; x < 8; x++) data.set([x < 4 ? 255 : 0, x < 4 ? 255 : 0, x < 4 ? 255 : 0, 255], (y * 8 + x) * 4);
  result.set('mask', { asset: { id: 'mask', mime: 'image/png', width: 8, height: 6 }, bytes: await encodePNG({ width: 8, height: 6, data }) });
  return result;
}
const load = records => async id => { assert.ok(records.has(id), id); return records.get(id); };
async function renderPdf(t, bytes) {
  const directory = mkdtempSync(join(tmpdir(), 'image2-scope-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const pdf = join(directory, 'export.pdf'), png = join(directory, 'render'); writeFileSync(pdf, bytes);
  const process = spawnSync('pdftoppm', ['-singlefile','-r','72','-png',pdf,png], { timeout: 15000, encoding: 'utf8' });
  assert.equal(process.status, 0, process.stderr); return decodeRGBA(readFileSync(`${png}.png`), 'image/png');
}

test('selected nested child keeps rotated ancestors without importing siblings and translates negative canvas bounds', async () => {
  const doc = document([layer('parent','group',{x:-20,y:-10,rotation:90}),layer('red-child','raster',{parentId:'parent',assetId:'red'}),layer('blue-child','raster',{parentId:'parent',assetId:'blue',z:1}),layer('blue-root','raster',{assetId:'blue',x:-26,y:-10,z:2})]);
  const scope = { layerIds: ['red-child'], bounds: { x:-26,y:-10,width:6,height:8 } }, view = scopedExportDocument(doc, scope);
  assert.deepEqual(view.layers.map(l => l.id), ['parent','red-child']); assert.deepEqual([view.layers[0].x, view.layers[0].y], [6,0]);
  const output = await exportDocument('png', doc, { ...scope, getAsset:load(await assets()) }), rgba = await decodeRGBA(output.bytes, 'image/png');
  assert.deepEqual([rgba.width, rgba.height], [6,8]); assert.deepEqual(pixel(rgba,2,2), [255,0,0,255]);
  assert.equal(doc.layers[0].x, -20); assert.equal(doc.width, 100);
});

test('selected group includes all descendants while a retained ancestor never expands the selection', async () => {
  const doc = document([layer('root','group'),layer('nested','group',{parentId:'root'}),layer('red','raster',{parentId:'nested',assetId:'red'}),layer('blue','raster',{parentId:'root',assetId:'blue'}),layer('outside','raster',{assetId:'blue'})]);
  assert.deepEqual(scopedExportDocument(doc, { layerIds:['nested'] }).layers.map(l => l.id), ['root','nested','red']);
  assert.deepEqual(scopedExportDocument(doc, { layerIds:['root'] }).layers.map(l => l.id), ['root','nested','red','blue']);
});

test('PNG/SVG/PDF full-page exports use requested infinite bounds and preserve true vector paths', { skip:!hasPoppler }, async t => {
  const records = await assets(); records.set('logo', { asset:{id:'logo',mime:'image/svg+xml',width:8,height:6},bytes:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="6"><path id="original-logo" fill="#00ff00" d="M0 0H8V6H0Z"/></svg>') });
  const doc = document([layer('logo','vector',{x:-12,y:-8,assetId:'logo'})]), scope = { bounds:{x:-12,y:-8,width:8,height:6},getAsset:load(records) };
  const png = await decodeRGBA((await exportDocument('png',doc,scope)).bytes,'image/png'); assert.deepEqual(pixel(png,3,3),[0,255,0,255]);
  const svg = (await exportDocument('svg',doc,scope)).bytes.toString(); assert.match(svg,/width="8" height="6" viewBox="0 0 8 6"/); assert.match(svg, /d="M0 0H8V6H0Z"/); assert.match(svg, /data-layer-id="logo" transform="translate\(0 0\)/);
  const pdf = await renderPdf(t,(await exportDocument('pdf',doc,scope)).bytes); assert.deepEqual([pdf.width,pdf.height],[8,6]); assert.deepEqual(pixel(pdf,3,3),[0,255,0,255]);
});

test('group masks hide the same region in PNG/SVG/PDF including a scoped nested selection', { skip:!hasPoppler }, async t => {
  const doc = document([layer('group','group',{maskAssetId:'mask',x:-10,y:-20}),layer('child','raster',{assetId:'red',parentId:'group'})]), ctx = { layerIds:['child'],bounds:{x:-10,y:-20,width:8,height:6},getAsset:load(await assets()) };
  const png = await decodeRGBA((await exportDocument('png',doc,ctx)).bytes,'image/png'); assert.deepEqual(pixel(png,1,2),[255,0,0,255]); assert.equal(pixel(png,6,2)[3],0);
  const svg = (await exportDocument('svg',doc,ctx)).bytes.toString(); assert.match(svg, /data-layer-id="group"[^>]+mask="url\(#m_/);
  const pdf = await renderPdf(t,(await exportDocument('pdf',doc,ctx)).bytes); assert.deepEqual(pixel(pdf,1,2),[255,0,0,255]); assert.deepEqual(pixel(pdf,6,2),[255,255,255,255]);
});

test('typed vector and real text masks survive SVG and PDF without changing path/font identity', { skip:!hasPoppler }, async t => {
  const records = await assets();
  records.set('logo', { asset:{id:'logo',mime:'image/svg+xml',width:8,height:6},bytes:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="6"><path fill="#00ff00" d="M0 0H8V6H0Z"/></svg>') });
  records.set('font', { asset:{id:'font',mime:'font/otf'},bytes:readFileSync(new URL('../fonts/NotoSansCJKsc-Regular.otf',import.meta.url)) });
  for (const node of [layer('logo','vector',{assetId:'logo',maskAssetId:'mask'}),layer('text','text',{text:'中文',fontAssetId:'font',fontSize:6,fill:'#000000',maskAssetId:'mask',metadata:{fontConfirmed:true}})]) {
    const doc = document([node]),ctx = { bounds:{x:0,y:0,width:8,height:6},getAsset:load(records) };
    const png=await decodeRGBA((await exportDocument('png',doc,ctx)).bytes,'image/png'),svg=(await exportDocument('svg',doc,ctx)).bytes.toString(),pdf=await renderPdf(t,(await exportDocument('pdf',doc,ctx)).bytes);
    assert.match(svg,/mask="url\(#m_/);assert.match(svg,node.type==='text'?/<text font-family="i2-font-/ : /d="M0 0H8V6H0Z"/);
    // PDF viewers may antialias a soft-mask boundary by one pixel. Lossless PNG
    // remains exact; check the PDF beyond that rendering boundary.
    let visible=0;for(let y=0;y<6;y++)for(let x=0;x<8;x++){if(x<4&&pixel(png,x,y)[3]>0)visible++;if(x>=4)assert.equal(pixel(png,x,y)[3],0);if(x>=5)assert.deepEqual(pixel(pdf,x,y),[255,255,255,255]);}
    assert.ok(visible>0,node.type);
  }
});

test('project packages retain full document/history even with presentation-only scope', async () => {
  const doc = document([layer('red','raster',{assetId:'red',x:-10}),layer('blue','raster',{assetId:'blue',x:20})]);
  const out = await exportDocument('project',doc,{getAsset:load(await assets()),revisions:[doc],layerIds:['red'],bounds:{x:-10,y:0,width:8,height:6}});
  const manifest = JSON.parse(strFromU8(unzipSync(out.bytes)['manifest.json'])); assert.deepEqual(manifest.document.layers,doc.layers); assert.equal(manifest.document.width,100); assert.equal(manifest.revisions[0].layers.length,2);
});

test('native frame metadata clips children locally in SVG/PNG/PDF while preserving negative canvas placement', {skip:!hasPoppler},async t=>{
  const records=await assets(),doc=document([layer('frame','group',{x:-10,y:-8,width:4,height:6,metadata:{nativeFrame:true,frameClip:true}}),layer('child','raster',{assetId:'red',parentId:'frame',x:1,y:0})]);
  const ctx={bounds:{x:-10,y:-8,width:8,height:6},getAsset:load(records)},png=await decodeRGBA((await exportDocument('png',doc,ctx)).bytes,'image/png'),pdf=await renderPdf(t,(await exportDocument('pdf',doc,ctx)).bytes),svg=(await exportDocument('svg',doc,ctx)).bytes.toString();
  assert.deepEqual(pixel(png,2,2),[255,0,0,255]);assert.equal(pixel(png,6,2)[3],0);assert.deepEqual(pixel(pdf,2,2),[255,0,0,255]);assert.deepEqual(pixel(pdf,6,2),[255,255,255,255]);
  assert.match(svg,/data-layer-id="frame"[^>]*clip-path="url\(#c_/);assert.match(svg,/<rect x="0" y="0" width="4" height="6"\/>/);
});

test('invalid, missing and duplicate layer choices and invalid bounds fail instead of silently changing export scope', () => {
  const doc = document([layer('red','raster',{assetId:'red'})]);
  for (const layerIds of [[],['missing'],['red','red'],'red']) assert.throws(() => scopedExportDocument(doc,{layerIds}), e => e.code === 'invalid_export_selection');
  for (const bounds of [{x:0,y:0,width:1.5,height:2},{x:0,y:0,width:0,height:2},{x:NaN,y:0,width:2,height:2},{x:0,y:0,width:32768,height:32768}]) assert.throws(() => scopedExportDocument(doc,{bounds}), e => e.code === 'invalid_export_bounds');
});
