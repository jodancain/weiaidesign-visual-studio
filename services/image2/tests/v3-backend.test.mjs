import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImageStore } from '../store.mjs';
import { createImageDocument, applyCommands, canonical, digest } from '../domain.mjs';
import { CONTENT_MIME, multiplyMatrix, worldMatrix } from '../domain-v3.mjs';
const OWNER='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222';
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l2EAAAAASUVORK5CYII=','base64');
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'image2-v3-'));let store=new ImageStore(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {get store(){return store;},reopen(){store.close();store=new ImageStore(dir);return store;}};}
function source(t){const f=fixture(t),d=f.store.createDocument(OWNER,{schemaVersion:3});const asset=f.store.addAsset(d.id,OWNER,{name:'pixel.png',mime:'image/png'},PNG);return {...f,store:f.store,document:d,asset,content:{id:'raster-content',kind:'raster',assetId:asset.id,formatVersion:1}};}
const layer=(id,contentId='raster-content',extra={})=>({id,type:'raster',contentId,localBounds:{x:0,y:0,width:1,height:1},matrix:[1,0,0,1,0,0],...extra});
const command=(f,key,commands)=>f.store.command(f.document.id,OWNER,{baseRevision:f.store.getDocument(f.document.id,OWNER).revision,commandId:key,commands});
const assertMatrix=(actual,expected)=>actual.forEach((n,i)=>assert.ok(Math.abs(n-expected[i])<1e-8,`${actual} != ${expected}`));
test('v3 matrix is sole authority and defaults are explicit while v2 stays v2',()=>{
  const d=createImageDocument({schemaVersion:3});assert.equal(d.resolution.dpiX,300);assert.equal(d.renderVersion,'weiai-rg-1');assert.equal(createImageDocument({}).schemaVersion,2);
  assert.throws(()=>applyCommands(d,[{type:'layer.add',layer:{...layer('bad'),x:5}}]),/unsupported layer property/);
  assert.throws(()=>createImageDocument({schemaVersion:4}),e=>e.code==='unsupported_schema');
  assert.throws(()=>createImageDocument({schemaVersion:3,requiredFeatures:['custom-shader']}),e=>e.code==='unsupported_feature');
});
test('one transaction adds real content, layers, mask, selection, artboard and guide; one undo/redo restores all',t=>{
  const f=source(t),before=f.store.getDocument(f.document.id,OWNER);
  const request={baseRevision:0,commandId:'batch',commands:[{type:'content.add',content:f.content},{type:'layer.add',layer:layer('photo')},{type:'mask.upsert',layerId:'photo',mask:{id:'mask',kind:'raster',contentId:f.content.id}},{type:'selection.upsert',selection:{id:'saved',name:'主体',contentId:f.content.id}},{type:'artboard.upsert',artboard:{id:'board',bounds:{x:-10,y:20,width:200,height:100}}},{type:'guide.upsert',guide:{id:'guide',axis:'x',position:-10,artboardId:'board'}}]};
  const after=f.store.command(f.document.id,OWNER,request);assert.equal(after.revision,1);assert.equal(after.layers[0].masks[0].id,'mask');assert.equal(after.savedSelections.length,1);assert.equal(after.artboards.length,1);assert.equal(after.guides.length,1);
  f.store.command(f.document.id,OWNER,request);assert.equal(f.store.listRevisions(f.document.id,OWNER).length,2);
  const undone=f.store.history(f.document.id,OWNER,{baseRevision:1,commandId:'undo',direction:'undo'});assert.deepEqual(undone.layers,before.layers);assert.deepEqual(undone.artboards,[]);assert.deepEqual(undone.contentAssets,[]);assert.ok(undone.assetIds.includes(f.asset.id));
  const redone=f.store.history(f.document.id,OWNER,{baseRevision:2,commandId:'redo',direction:'redo'});assert.deepEqual(redone.layers,after.layers);assert.deepEqual(redone.savedSelections,after.savedSelections);
});
test('world transforms through skewed parent preserve parent matrix and apply delta once to selected ancestors',t=>{
  const f=source(t),parent=[2,1,.5,3,10,-5],child=[1,.25,-.5,1,7,9];
  const d=command(f,'add',[{type:'content.add',content:f.content},{type:'layer.add',layer:{id:'group',type:'group',matrix:parent}},{type:'layer.add',layer:layer('child',f.content.id,{parentId:'group',matrix:child})}]);
  const before=worldMatrix(d,'child'),delta=[0,1,-1,0,40,20];
  const after=command(f,'world',[{type:'layer.transformWorld',layerIds:['child'],deltaWorld:delta}]);assertMatrix(after.layers[0].matrix,parent);assertMatrix(worldMatrix(after,'child'),multiplyMatrix(delta,before));
  const prior=worldMatrix(after,'child'),both=command(f,'both',[{type:'layer.transformWorld',layerIds:['group','child'],deltaWorld:delta}]);assertMatrix(worldMatrix(both,'child'),multiplyMatrix(delta,prior));
});
test('failed batches, inherited locks, invalid recursive refs and immutable content identities leave no revision',t=>{
  const f=source(t);command(f,'add',[{type:'content.add',content:f.content},{type:'layer.add',layer:{id:'group',type:'group',locked:true}},{type:'layer.add',layer:layer('photo')}]);
  const before=f.store.getDocument(f.document.id,OWNER),count=f.store.listRevisions(f.document.id,OWNER).length;
  assert.throws(()=>command(f,'late-invalid',[{type:'guide.upsert',guide:{id:'temporary',axis:'y',position:5}},{type:'layer.update',layerId:'photo',patch:{parentId:'group'}}]),e=>e.code==='layer_locked');
  assert.equal(canonical(f.store.getDocument(f.document.id,OWNER)),canonical(before));assert.equal(f.store.listRevisions(f.document.id,OWNER).length,count);
  assert.throws(()=>command(f,'immutable',[{type:'content.add',content:{...f.content,assetId:'different'}}]),e=>e.code==='content_identity_conflict');
  assert.throws(()=>command(f,'missing',[{type:'content.add',content:{id:'missing',kind:'raster',assetId:'missing',formatVersion:1}}]),/not registered/);
  assert.throws(()=>command(f,'no-metadata-drawing',[{type:'layer.update',layerId:'photo',patch:{metadata:{paths:[{d:'M0 0'}]}}}]),/immutable content/);
});
test('real JSON content is bounded, references same-project fonts, validates actual glyphs, and rejects arbitrary URLs',t=>{
  const f=source(t),other=f.store.createDocument(OTHER,{schemaVersion:3}),foreign=f.store.addAsset(other.id,OTHER,{name:'foreign.png',mime:'image/png'},PNG);
  const upload=value=>f.store.addAsset(f.document.id,OWNER,{name:'content.json',mime:CONTENT_MIME},Buffer.from(JSON.stringify(value)));
  assert.throws(()=>upload({formatVersion:1,kind:'preservedText',text:'原字',fontStatus:'unknown',status:'preserved',assetId:foreign.id}),e=>e.code==='CONTENT_RESOURCE_UNREGISTERED');
  const font=f.store.addAsset(f.document.id,OWNER,{name:'subset.woff2',mime:'font/woff2'},readFileSync(new URL('./fixtures/incomplete-cjk.woff2',import.meta.url)));
  assert.throws(()=>upload({formatVersion:1,kind:'text',text:'中文',fontAssetId:font.id,fontSize:24}),e=>e.code==='FONT_GLYPH_MISSING');
  const text=upload({formatVersion:1,kind:'text',text:'中',fontAssetId:font.id,fontSize:24,fill:'#ff0000'});
  const d=command(f,'real-text',[{type:'content.add',content:{id:'actual-text',kind:'text',assetId:text.id,formatVersion:1}},{type:'layer.add',layer:{id:'text',type:'text',contentId:'actual-text'}}]);assert.equal(d.layers[0].contentId,'actual-text');
  assert.throws(()=>upload({formatVersion:1,kind:'vector',paths:[{id:'p',d:'M0 0H1V1Z',fill:'url(https://outside.invalid/a)'}]}),/invalid path fill/);
  assert.throws(()=>upload({formatVersion:1,kind:'tiles',width:1,height:1,tileSize:1,tiles:[]}),e=>e.code==='unsupported_feature');
});
test('copy migration preserves source/history/tasks, maps actual pixels and uses 72 DPI; replay survives restart',t=>{
  const f=fixture(t),d=f.store.createDocument(OWNER,{name:'旧工程',width:300,height:160}),asset=f.store.addAsset(d.id,OWNER,{name:'slice.png',mime:'image/png',width:1,height:1},PNG);
  f.store.command(d.id,OWNER,{baseRevision:0,commandId:'initial',commands:[{type:'layer.add',layer:{id:'group',type:'group',x:3,y:5,width:900,height:400,rotation:15}},{type:'layer.add',layer:{id:'photo',type:'raster',assetId:asset.id,sourceAssetId:asset.id,sourceRect:[5,6,100,80],parentId:'group',x:12,y:8,width:300,height:160,rotation:30}}]});
  f.store.command(d.id,OWNER,{baseRevision:1,commandId:'move',commands:[{type:'layer.update',layerId:'photo',patch:{x:80}}]});
  f.store.history(d.id,OWNER,{baseRevision:2,commandId:'undo',direction:'undo'});
  const pending=f.store.createJob(d.id,OWNER,{kind:'operation',idempotencyKey:'unknown-paid',input:{operation:'generate'}});f.store.updateJob(pending.id,{state:'uncertain'});
  const original=f.store.getDocument(d.id,OWNER),revisions=f.store.listRevisions(d.id,OWNER),result=f.store.migrateV3(d.id,OWNER,{sourceRevision:3,idempotencyKey:'migration'});
  assert.equal(result.document.schemaVersion,3);assert.deepEqual(result.document.metadata.professionalSource,{documentId:d.id,revision:3,hash:digest(result.originalSnapshot)});assert.ok(f.store.listRevisions(result.document.id,OWNER).every(revision=>canonical(revision.metadata.professionalSource)===canonical(result.document.metadata.professionalSource)));assert.equal(result.document.resolution.dpiX,72);assert.notEqual(result.document.id,d.id);assert.notEqual(result.mappings.assets[asset.id],asset.id);
  const photo=result.document.layers.find(l=>l.id===result.mappings.layers.photo),group=result.document.layers.find(l=>l.id===result.mappings.layers.group);
  assert.deepEqual(photo.localBounds,{x:0,y:0,width:1,height:1});assert.ok(Math.abs(group.matrix[0]-Math.cos(15*Math.PI/180))<1e-9);assert.ok(Math.abs(photo.matrix[0]-300*Math.cos(30*Math.PI/180))<1e-9);
  assert.deepEqual(f.store.getDocument(d.id,OWNER),original);assert.deepEqual(f.store.listRevisions(d.id,OWNER),revisions);assert.equal(f.store.getJob(pending.id,OWNER).state,'uncertain');assert.deepEqual(f.store.listJobs(result.document.id,OWNER),[]);
  const redone=f.store.history(result.document.id,OWNER,{baseRevision:3,commandId:'redo-new',direction:'redo'});assert.equal(redone.layers.find(l=>l.id===photo.id).matrix[4],80);
  f.reopen();const again=f.store.migrateV3(d.id,OWNER,{sourceRevision:3,idempotencyKey:'migration'});assert.deepEqual(again,result);assert.deepEqual(f.store.getAsset(result.mappings.assets[asset.id],OWNER).bytes,PNG);
  assert.throws(()=>f.store.migrateV3(d.id,OWNER,{sourceRevision:2,idempotencyKey:'migration'}),e=>e.code==='idempotency_conflict');assert.throws(()=>f.store.migrateV3(d.id,OTHER,{sourceRevision:3,idempotencyKey:'private'}),e=>e.status===404);
});
test('migration keeps SVG viewBox, paint/font wrapper and stable mask identity throughout undo history',t=>{
  const f=fixture(t),d=f.store.createDocument(OWNER,{}),svg=Buffer.from('<svg width="8" height="6" viewBox="10 20 8 6"><path id="p" d="M10 20H18V26H10Z" fill="red"/></svg>');
  const asset=f.store.addAsset(d.id,OWNER,{name:'logo.svg',mime:'image/svg+xml',width:8,height:6},svg),mask=f.store.addAsset(d.id,OWNER,{name:'mask.png',mime:'image/png'},PNG);
  f.store.command(d.id,OWNER,{baseRevision:0,commandId:'vector',commands:[{type:'layer.add',layer:{id:'vector',type:'vector',assetId:asset.id,width:80,height:30,maskAssetId:mask.id,metadata:{pathStyles:{p:{fill:'#00ff00'}}}}}]});
  f.store.command(d.id,OWNER,{baseRevision:1,commandId:'paint',commands:[{type:'layer.update',layerId:'vector',patch:{fill:'#0000ff'}}]});f.store.history(d.id,OWNER,{baseRevision:2,commandId:'undo',direction:'undo'});
  const migrated=f.store.migrateV3(d.id,OWNER,{sourceRevision:3,idempotencyKey:'svg-copy'}),v=migrated.document.layers[0];assert.deepEqual(v.localBounds,{x:10,y:20,width:8,height:6});assertMatrix(v.matrix,[10,0,0,5,-100,-100]);
  const descriptor=migrated.document.contentAssets.find(c=>c.id===v.contentId),value=JSON.parse(f.store.getAsset(descriptor.assetId,OWNER).bytes);assert.equal(value.kind,'svg');assert.equal(value.pathStyles.p.fill,'#00ff00');assert.equal(v.metadata.pathStyles,undefined);
  const historical=f.store.listRevisions(migrated.document.id,OWNER).filter(d=>d.layers.length).map(d=>d.layers[0].masks[0].id);assert.equal(new Set(historical).size,1);assert.deepEqual(f.store.getAsset(asset.id,OWNER).bytes,svg);
});
test('migration makes attached text background real children without double scaling text metrics',t=>{
  const f=fixture(t),d=f.store.createDocument(OWNER,{}),patch=f.store.addAsset(d.id,OWNER,{name:'patch.png',mime:'image/png'},PNG),bg=f.store.addAsset(d.id,OWNER,{name:'clean.png',mime:'image/png',inputs:[{role:'base',assetId:patch.id}]},PNG),font=f.store.addAsset(d.id,OWNER,{name:'Noto.otf',mime:'font/otf'},readFileSync(new URL('../fonts/NotoSansCJKsc-Regular.otf',import.meta.url)));
  f.store.command(d.id,OWNER,{baseRevision:0,commandId:'text',commands:[{type:'layer.add',layer:{id:'text',type:'text',assetId:patch.id,fontAssetId:font.id,text:'中文',x:15,y:20,width:160,height:40,fontSize:24,metadata:{fontConfirmed:true,cleanBackgroundAssetId:bg.id}}}]});
  const result=f.store.migrateV3(d.id,OWNER,{sourceRevision:1,idempotencyKey:'text-copy'}),group=result.document.layers.find(l=>l.id===result.mappings.layers.text),text=result.document.layers.find(l=>l.type==='text');assert.equal(group.type,'group');assert.deepEqual(text.matrix,[1,0,0,1,0,0]);assert.deepEqual(group.matrix,[1,0,0,1,15,20]);assert.equal(result.document.layers.filter(l=>l.parentId===group.id).length,2);
});
test('mask linkage holds world space through direct layer and ancestor world transforms',t=>{
  const f=source(t),base=[2,.5,.25,3,10,20];
  command(f,'masks',[{type:'content.add',content:f.content},{type:'layer.add',layer:{id:'parent',type:'group',matrix:base}},{type:'layer.add',layer:layer('photo',f.content.id,{parentId:'parent',matrix:[1,0,0,1,4,5],masks:[{id:'local-unlinked',kind:'raster',contentId:f.content.id,linked:false,matrix:[3,0,0,4,7,8]},{id:'document-linked',kind:'raster',contentId:f.content.id,linked:true,coordinateSpace:'document',matrix:[3,0,0,4,7,8]},{id:'local-linked',kind:'raster',contentId:f.content.id,linked:true,matrix:[3,0,0,4,7,8]},{id:'document-unlinked',kind:'raster',contentId:f.content.id,linked:false,coordinateSpace:'document',matrix:[3,0,0,4,7,8]}]})}]);
  const before=f.store.getDocument(f.document.id,OWNER),oldWorld=worldMatrix(before,'photo'),oldMasks=before.layers[1].masks,delta=[0,1,-1,0,40,70];
  const moved=command(f,'parent-world',[{type:'layer.transformWorld',layerIds:['parent'],deltaWorld:delta}]),newWorld=worldMatrix(moved,'photo'),masks=moved.layers[1].masks;
  assertMatrix(multiplyMatrix(newWorld,masks[0].matrix),multiplyMatrix(oldWorld,oldMasks[0].matrix));assertMatrix(masks[1].matrix,multiplyMatrix(delta,oldMasks[1].matrix));assertMatrix(masks[2].matrix,oldMasks[2].matrix);assertMatrix(masks[3].matrix,oldMasks[3].matrix);
  const stable=multiplyMatrix(newWorld,masks[0].matrix),updated=command(f,'direct',[{type:'layer.update',layerId:'photo',patch:{matrix:[2,1,.2,3,8,9]}}]);assertMatrix(multiplyMatrix(worldMatrix(updated,'photo'),updated.layers[1].masks[0].matrix),stable);
});
test('blend and implemented effects use strict params and feature declarations; unsupported stacks fail atomically',t=>{
  const f=source(t),cm=[1,0,0,0,0,0,1,0,0,0,0,0,1,0,0,0,0,0,1,0];
  const d=command(f,'effects',[{type:'content.add',content:f.content},{type:'layer.add',layer:layer('paint',f.content.id,{blendMode:'multiply',effects:[{id:'color',type:'colorMatrix',params:{matrix:cm}},{id:'blur',type:'gaussianBlur',params:{sigma:2}}]})}]);assert.ok(d.requiredFeatures.includes('blend-modes'));assert.ok(d.requiredFeatures.includes('layer-effects'));
  const invalid=effects=>command(f,'bad-effects',[{type:'layer.update',layerId:'paint',patch:{effects}}]);assert.throws(()=>invalid([{id:'shader',type:'shader',params:{script:'noop'}}]),e=>e.code==='unsupported_feature');assert.throws(()=>invalid(Array.from({length:21},(_,i)=>({id:`blur${i}`,type:'gaussianBlur',params:{sigma:1}}))),/invalid layer effects/);assert.throws(()=>invalid([{id:'blur',type:'gaussianBlur',params:{sigma:257}}]),/invalid gaussian/);assert.equal(f.store.getDocument(f.document.id,OWNER).revision,d.revision);
  const stack=command(f,'stack-effects',[{type:'layer.update',layerId:'paint',patch:{effects:[{id:'blur1',type:'gaussianBlur',params:{sigma:1}},{id:'blur2',type:'gaussianBlur',params:{sigma:2}}]}}]);assert.deepEqual(stack.layers[0].effects.map(e=>e.id),['blur1','blur2']);
});
test('v3 branch accepts independent layers and immutable content together, conflicting artboards remain on branch',t=>{
  const f=source(t);command(f,'initial',[{type:'content.add',content:f.content},{type:'layer.add',layer:layer('a')},{type:'layer.add',layer:layer('b')}]);
  const branch=f.store.createBranch(f.document.id,OWNER,{baseRevision:1});f.store.command(branch.id,OWNER,{baseRevision:0,commandId:'candidate',commands:[{type:'layer.update',layerId:'a',patch:{matrix:[2,0,0,2,10,5]}},{type:'artboard.upsert',artboard:{id:'artboard',bounds:{x:0,y:0,width:100,height:100}}}]});command(f,'main',[{type:'layer.update',layerId:'b',patch:{matrix:[1,0,0,1,30,0]}}]);
  const accepted=f.store.acceptBranch(f.document.id,OWNER,{baseRevision:2,branchDocumentId:branch.id,commandId:'accept'});assert.equal(accepted.artboards.length,1);assert.equal(accepted.layers[0].matrix[4],10);assert.equal(accepted.layers[1].matrix[4],30);
  const conflicting=f.store.createBranch(f.document.id,OWNER,{baseRevision:3});f.store.command(conflicting.id,OWNER,{baseRevision:0,commandId:'branch-board',commands:[{type:'artboard.upsert',artboard:{id:'artboard',bounds:{x:1,y:1,width:100,height:100}}}]});command(f,'human-board',[{type:'artboard.upsert',artboard:{id:'artboard',bounds:{x:2,y:2,width:100,height:100}}}]);assert.throws(()=>f.store.acceptBranch(f.document.id,OWNER,{baseRevision:4,branchDocumentId:conflicting.id,commandId:'board-conflict'}),e=>e.code==='branch_conflict');assert.equal(f.store.getDocument(conflicting.id,OWNER).artboards[0].bounds.x,1);
});
test('dedicated path JSON validates grammar and preserved text retains pixels or reports unavailable explicitly',t=>{
  const f=source(t),upload=value=>f.store.addAsset(f.document.id,OWNER,{name:'content.json',mime:CONTENT_MIME},Buffer.from(JSON.stringify(value)));
  for(const d of ['M','M0 0L1','M0 0A1 1 0 2 0 1 1','M0 0Z1 1'])assert.throws(()=>upload({formatVersion:1,kind:'vector',paths:[{id:'p',d}]}),/SVG/);
  const original=upload({formatVersion:1,kind:'preservedText',assetId:f.asset.id,text:'旧字',desiredText:'新字',fontStatus:'unknown'});const d=command(f,'preserve',[{type:'content.add',content:{id:'preserved',kind:'preservedText',assetId:original.id,formatVersion:1}},{type:'layer.add',layer:{id:'preserved',type:'text',contentId:'preserved'}}]);assert.equal(d.layers[0].type,'text');assert.deepEqual(f.store.getAsset(f.asset.id,OWNER).bytes,PNG);
  assert.throws(()=>upload({formatVersion:1,kind:'svg',sourceAssetId:f.asset.id,fontAssetIds:[]}),e=>e.code==='CONTENT_KIND_MISMATCH');
});
test('real text bounds expand after immutable content replacement and undo keeps glyph metrics without scaling matrix',t=>{
  const f=source(t),font=f.store.addAsset(f.document.id,OWNER,{name:'Noto.otf',mime:'font/otf'},readFileSync(new URL('../fonts/NotoSansCJKsc-Regular.otf',import.meta.url)));
  const upload=(text,size)=>f.store.addAsset(f.document.id,OWNER,{name:'text.json',mime:CONTENT_MIME},Buffer.from(JSON.stringify({formatVersion:1,kind:'text',text,fontAssetId:font.id,fontSize:size,fill:'#000000',lineHeight:1.2})));
  const first=upload('中',24),long=upload('长中文标题\n第二行',48);
  const original=command(f,'text-base',[{type:'content.add',content:{id:'first',kind:'text',assetId:first.id,formatVersion:1}},{type:'layer.add',layer:{id:'text',type:'text',contentId:'first',localBounds:{x:0,y:0,width:1,height:1},matrix:[2,.5,.25,3,10,20]}}]);assert.ok(original.layers[0].localBounds.width>=24);
  const changed=command(f,'text-edit',[{type:'content.add',content:{id:'long',kind:'text',assetId:long.id,formatVersion:1}},{type:'layer.content',layerId:'text',contentId:'long'}]);assert.ok(changed.layers[0].localBounds.width>=240);assert.ok(changed.layers[0].localBounds.height>=116);assert.deepEqual(changed.layers[0].matrix,original.layers[0].matrix);
  const undo=f.store.history(f.document.id,OWNER,{baseRevision:2,commandId:'undo-text',direction:'undo'});assert.deepEqual(undo.layers[0].localBounds,original.layers[0].localBounds);
  const redo=f.store.history(f.document.id,OWNER,{baseRevision:3,commandId:'redo-text',direction:'redo'});assert.deepEqual(redo.layers[0].localBounds,changed.layers[0].localBounds);
});
test('branch collection edits merge by identity instead of conflicting on unrelated saved guides',t=>{
  const f=source(t);command(f,'base',[{type:'content.add',content:f.content},{type:'layer.add',layer:layer('a')}]);const branch=f.store.createBranch(f.document.id,OWNER,{baseRevision:1});
  f.store.command(branch.id,OWNER,{baseRevision:0,commandId:'branch-guide',commands:[{type:'guide.upsert',guide:{id:'branch-guide',axis:'x',position:10}},{type:'mask.upsert',layerId:'a',mask:{id:'mask',kind:'raster',contentId:f.content.id}}]});
  command(f,'main-guide',[{type:'guide.upsert',guide:{id:'main-guide',axis:'y',position:20}}]);
  const merged=f.store.acceptBranch(f.document.id,OWNER,{baseRevision:2,commandId:'accept-guides',branchDocumentId:branch.id});assert.equal(merged.guides.length,2);assert.equal(merged.layers[0].masks.length,1);assert.ok(merged.requiredFeatures.includes('layer-masks'));
});
test('all provenance resource references remain tenant-scoped and are remapped during copy migration',t=>{
  const f=source(t),other=f.store.createDocument(OTHER,{schemaVersion:3}),foreign=f.store.addAsset(other.id,OTHER,{name:'other.png',mime:'image/png'},PNG);
  assert.throws(()=>command(f,'bad-provenance',[{type:'document.update',patch:{metadata:{nested:{sourceAssetId:foreign.id}}}}]),e=>e.code==='CONTENT_RESOURCE_UNREGISTERED');
  const old=f.store.createDocument(OWNER,{}),asset=f.store.addAsset(old.id,OWNER,{name:'owned.png',mime:'image/png'},PNG);
  f.store.command(old.id,OWNER,{baseRevision:0,commandId:'provenance',commands:[{type:'layer.add',layer:{id:'source',type:'raster',assetId:asset.id,metadata:{sourceMaskAssetId:asset.id,nested:{sourceAssetId:asset.id}}}},{type:'document.update',patch:{metadata:{originAssetId:asset.id}}}]});
  const migrated=f.store.migrateV3(old.id,OWNER,{sourceRevision:1,idempotencyKey:'metadata-copy'}),mapped=migrated.mappings.assets[asset.id];assert.equal(migrated.document.layers[0].metadata.sourceMaskAssetId,mapped);assert.equal(migrated.document.layers[0].metadata.nested.sourceAssetId,mapped);assert.equal(migrated.document.metadata.originAssetId,mapped);
});
test('standalone old text with an actual font remains real text even when source-patch confirmation is absent',t=>{
  const f=fixture(t),d=f.store.createDocument(OWNER,{}),font=f.store.addAsset(d.id,OWNER,{name:'Noto.otf',mime:'font/otf'},readFileSync(new URL('../fonts/NotoSansCJKsc-Regular.otf',import.meta.url)));
  f.store.command(d.id,OWNER,{baseRevision:0,commandId:'standalone',commands:[{type:'layer.add',layer:{id:'text',type:'text',text:'独立中文',fontAssetId:font.id,fontSize:24,width:120,height:40,metadata:{fontConfirmed:false}}}]});
  const result=f.store.migrateV3(d.id,OWNER,{sourceRevision:1,idempotencyKey:'standalone-copy'}),content=result.document.contentAssets.find(c=>c.id===result.document.layers[0].contentId);assert.equal(content.kind,'text');assert.equal(JSON.parse(f.store.getAsset(content.assetId,OWNER).bytes).fontAssetId,result.mappings.assets[font.id]);assert.deepEqual(result.document.layers[0].matrix,[1,0,0,1,0,0]);
});
