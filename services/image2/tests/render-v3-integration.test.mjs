import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {ImageStore} from '../store.mjs';
import {renderNode,resolveNodeResource} from '../render-node.mjs';
import {documentPng} from '../exports.mjs';

const OWNER='11111111-1111-4111-8111-111111111111';
const OTHER='22222222-2222-4222-8222-222222222222';
const options=process.env.IMAGE2_CANVASKIT_PROBE_MODULE?{modulePath:process.env.IMAGE2_CANVASKIT_PROBE_MODULE}:{};
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'image2-render-migration-')),store=new ImageStore(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return store;}
const pixel=(r,x,y)=>[...r.pixels.slice((y*r.width+x)*4,(y*r.width+x)*4+4)];

test('real store copy migration renders an already-cut slice without provenance recropping and keeps the old ledger intact',async t=>{
  const store=fixture(t),d=store.createDocument(OWNER,{width:40,height:32}),bytes=await sharp({create:{width:8,height:6,channels:4,background:'#ff0000'}}).png().toBuffer(),asset=store.addAsset(d.id,OWNER,{name:'cut.png',mime:'image/png'},bytes);
  store.command(d.id,OWNER,{baseRevision:0,commandId:'old-layout',commands:[{type:'layer.add',layer:{id:'group',type:'group',x:4,y:3,width:30,height:25}},{type:'layer.add',layer:{id:'slice',type:'raster',parentId:'group',assetId:asset.id,sourceAssetId:asset.id,sourceRect:[100,200,8,6],x:2,y:3,width:16,height:12}}]});
  const old=store.getDocument(d.id,OWNER),oldHistory=store.listRevisions(d.id,OWNER),copy=store.migrateV3(d.id,OWNER,{sourceRevision:1,idempotencyKey:'render-copy'}),frame=await renderNode(copy.document,id=>store.getAsset(id,OWNER),{...options,bounds:{x:0,y:0,width:40,height:32}});
  assert.deepEqual(pixel(frame,7,7),[255,0,0,255]);assert.deepEqual(pixel(frame,21,17),[255,0,0,255]);assert.deepEqual(pixel(frame,22,18),[0,0,0,0]);assert.deepEqual(store.getDocument(d.id,OWNER),old);assert.deepEqual(store.listRevisions(d.id,OWNER),oldHistory);
  const legacy=await sharp(await documentPng(old,id=>store.getAsset(id,OWNER))).ensureAlpha().raw().toBuffer();assert.ok(frame.pixels.every((v,i)=>v===legacy[i]));assert.deepEqual(store.getAsset(asset.id,OWNER).bytes,bytes);
  const content=copy.document.contentAssets[0],resource=await resolveNodeResource(copy.document,content.id,id=>store.getAsset(id,OWNER));assert.equal(resource.width,8);assert.equal(resource.height,6);await assert.rejects(renderNode(copy.document,id=>store.getAsset(id,OTHER),{...options,bounds:{x:0,y:0,width:40,height:32}}),e=>e.status===404);
});

test('migrated SVG wrapper renders viewBox styling with owned assets and leaves original SVG source bytes unchanged',async t=>{
 const store=fixture(t),d=store.createDocument(OWNER,{width:32,height:24}),svg=Buffer.from('<svg width="8" height="6" viewBox="10 20 8 6"><path id="p" d="M10 20H18V26H10Z" fill="red"/></svg>'),asset=store.addAsset(d.id,OWNER,{name:'logo.svg',mime:'image/svg+xml'},svg);
 store.command(d.id,OWNER,{baseRevision:0,commandId:'svg-layout',commands:[{type:'layer.add',layer:{id:'logo',type:'vector',assetId:asset.id,x:3,y:4,width:16,height:12,metadata:{pathStyles:{p:{fill:'#00ff00'}}}}}]});
 const old=store.getDocument(d.id,OWNER),copy=store.migrateV3(d.id,OWNER,{sourceRevision:1,idempotencyKey:'svg-render'}),r=await renderNode(copy.document,id=>store.getAsset(id,OWNER),{...options,bounds:{x:0,y:0,width:32,height:24}});assert.deepEqual(pixel(r,10,10),[0,255,0,255]);assert.deepEqual(pixel(r,2,10),[0,0,0,0]);assert.deepEqual(store.getAsset(asset.id,OWNER).bytes,svg);const legacy=await sharp(await documentPng(old,id=>store.getAsset(id,OWNER))).ensureAlpha().raw().toBuffer();assert.ok(r.pixels.every((v,i)=>v===legacy[i]));
});

test('unknown Chinese remains its actual pixel patch while metadata edits and confirmed background become distinct content',async t=>{
 const store=fixture(t),d=store.createDocument(OWNER,{width:200,height:80}),patchBytes=await sharp({create:{width:80,height:30,channels:4,background:'#ff00ff'}}).png().toBuffer(),patch=store.addAsset(d.id,OWNER,{name:'unknown-text.png',mime:'image/png'},patchBytes);
 store.command(d.id,OWNER,{baseRevision:0,commandId:'unknown',commands:[{type:'layer.add',layer:{id:'unknown',type:'text',assetId:patch.id,text:'未知中文',x:5,y:7,width:160,height:60,fontSize:24,metadata:{desiredText:'不能自动冒充改字'}}}]});
 const old=store.getDocument(d.id,OWNER),copy=store.migrateV3(d.id,OWNER,{sourceRevision:1,idempotencyKey:'unknown-render'}),r=await renderNode(copy.document,id=>store.getAsset(id,OWNER),{...options,bounds:{x:0,y:0,width:200,height:80}}),descriptor=copy.document.contentAssets[0],payload=JSON.parse(store.getAsset(descriptor.assetId,OWNER).bytes);assert.equal(payload.kind,'preservedText');assert.equal(payload.fontStatus,'unknown');assert.equal(payload.desiredText,'不能自动冒充改字');assert.deepEqual(pixel(r,30,20),[255,0,255,255]);assert.equal(old.layers[0].text,'未知中文');
 const confirmed=store.createDocument(OWNER,{width:200,height:80}),p=store.addAsset(confirmed.id,OWNER,{name:'p.png',mime:'image/png'},patchBytes),bgBytes=await sharp({create:{width:80,height:30,channels:4,background:'#ffffff'}}).png().toBuffer(),bg=store.addAsset(confirmed.id,OWNER,{name:'clean.png',mime:'image/png',inputs:[{role:'base',assetId:p.id}]},bgBytes),font=store.addAsset(confirmed.id,OWNER,{name:'Noto.otf',mime:'font/otf'},readFileSync(new URL('../fonts/NotoSansCJKsc-Regular.otf',import.meta.url)));
 store.command(confirmed.id,OWNER,{baseRevision:0,commandId:'confirmed',commands:[{type:'layer.add',layer:{id:'text',type:'text',assetId:p.id,fontAssetId:font.id,text:'中文',x:5,y:7,width:160,height:60,fontSize:24,fill:'#000000',metadata:{fontConfirmed:true,cleanBackgroundAssetId:bg.id}}}]});const fresh=store.migrateV3(confirmed.id,OWNER,{sourceRevision:1,idempotencyKey:'font-render'}),painted=await renderNode(fresh.document,id=>store.getAsset(id,OWNER),{...options,bounds:{x:0,y:0,width:200,height:80}});assert.equal(fresh.document.layers.filter(l=>l.type==='group').length,1);assert.equal(fresh.document.layers.filter(l=>l.type==='text').length,1);assert.deepEqual(pixel(painted,150,40),[255,255,255,255]);assert.ok(painted.pixels.some((v,i)=>i%4===0&&v===0&&painted.pixels[i+3]===255));
});
