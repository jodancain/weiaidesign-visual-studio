import test from 'node:test';
import assert from 'node:assert/strict';
import type {ImageDocument,ImageLayer,LayerMask,Matrix2D} from '../lib/image2/types';
import {professionalWorldMatrix,professionalMaskWorld,convertProfessionalMask,professionalSelectionFromMask,professionalMaskFromSelection,professionalMaskFit} from '../components/image2/ProfessionalProperties';
import {multiply} from '../services/image2/core/matrix.mjs';

const matrix:Matrix2D=[2,.5,.25,3,10,-5];
const layer=(id:string,extra:Partial<ImageLayer>={}):ImageLayer=>({id,name:id,type:'raster',x:999,y:999,width:999,height:999,rotation:999,opacity:1,visible:true,locked:false,z:0,matrix:[1,0,0,1,4,8],localBounds:{x:10,y:20,width:80,height:60},masks:[],...extra});
const document=():ImageDocument=>({id:'doc',name:'document',schemaVersion:3,revision:1,width:100,height:100,layers:[layer('parent',{type:'group',matrix}),layer('child',{parentId:'parent'})],assetIds:['mask-asset'],createdAt:0,updatedAt:0,contentAssets:[{id:'mask-content',kind:'raster',assetId:'mask-asset',formatVersion:1}]});
const mask=():LayerMask=>({id:'mask',kind:'raster',contentId:'mask-content',matrix:[3,0,0,4,7,9],coordinateSpace:'layerLocal',linked:true,enabled:true,inverted:false,density:.8,featherPx:2,channel:'alpha'});
const close=(actual:number[],expected:number[])=>actual.forEach((v,i)=>assert.ok(Math.abs(v-expected[i])<1e-8,`${actual} != ${expected}`));

test('professional properties use raw full matrices instead of lossy legacy projection geometry',()=>{
 const d=document();close(professionalWorldMatrix(d,'child'),multiply(matrix,d.layers[1].matrix!));assert.notEqual(professionalWorldMatrix(d,'child')[4],999);assert.throws(()=>professionalWorldMatrix(d,'missing'));
});
test('mask coordinate changes preserve world appearance through nonuniform and sheared parents',()=>{
 const d=document(),l=d.layers[1],m=mask(),world=professionalMaskWorld(d,l,m),inDocument=convertProfessionalMask(d,l,m,'document');close(inDocument.matrix,world);close(professionalMaskWorld(d,l,inDocument),world);const local=convertProfessionalMask(d,l,inDocument,'layerLocal');close(local.matrix,m.matrix);assert.equal(local.linked,true);assert.deepEqual(m.matrix,[3,0,0,4,7,9]);
});
test('changing only linked keeps matrix, coordinate basis, and current world pixels fixed',()=>{
 const d=document(),l=d.layers[1],m=mask(),unlinked={...m,linked:false};assert.deepEqual(unlinked.matrix,m.matrix);assert.equal(unlinked.coordinateSpace,m.coordinateSpace);close(professionalMaskWorld(d,l,unlinked),professionalMaskWorld(d,l,m));
});
test('noninvertible coordinate conversions explicitly fail instead of jumping the mask',()=>{
 const d=document(),l=d.layers[1];l.matrix=[0,0,0,0,0,0];const m={...mask(),coordinateSpace:'document' as const};assert.throws(()=>convertProfessionalMask(d,l,m,'layerLocal'),(error:unknown)=>(error as {code:string}).code==='NONINVERTIBLE_TRANSFORM');
});
test('saving and applying a selection preserves source identity, effects, channel, and document coordinates',()=>{
 const d=document(),l=d.layers[1],m=mask(),selection=professionalSelectionFromMask(d,l,m,'selection'),next=professionalMaskFromSelection(d,selection,'new-mask');assert.equal(next.contentId,m.contentId);assert.equal(next.linked,false);assert.equal(next.coordinateSpace,'document');assert.equal(next.featherPx,2);assert.equal(next.density,.8);close(next.matrix,professionalMaskWorld(d,l,m));assert.equal(next.kind,'raster');d.contentAssets![0].kind='svg';assert.equal(professionalMaskFromSelection(d,selection,'svg-mask').kind,'vector');d.contentAssets=[];assert.throws(()=>professionalMaskFromSelection(d,selection,'missing'));
});
test('SVG mask fitting maps nonzero source viewBox into original local bounds without pixel provenance crop',()=>{
 const l=layer('child'),asset={id:'asset',documentId:'doc',name:'mask.svg',mime:'image/svg+xml',hash:'hash',bytes:1,createdAt:0,width:8,height:6,metadata:{sourceViewBox:[-4,5,8,6]}};assert.deepEqual(professionalMaskFit(l,asset),[10,0,0,10,50,-30]);assert.deepEqual(professionalMaskFit(l,{...asset,metadata:{},mime:'image/png'}),[10,0,0,10,10,20]);assert.throws(()=>professionalMaskFit(l,{...asset,width:0,height:0,metadata:{}}));
});
