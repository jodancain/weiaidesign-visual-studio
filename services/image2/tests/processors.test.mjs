import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {readFile} from 'node:fs/promises';
import {executeOperation,decodeRGBA,encodePNG,effectiveMask,inspectAsset} from '../processors.mjs';
import {generateImages,runComfy,providerCapabilities,imageFrameFor} from '../providers.mjs';
import {documentPng,documentSvg,documentPdf} from '../exports.mjs';
import {normalizeLayer,createImageDocument,applyCommands} from '../domain.mjs';
import {createFontCandidateFitter,sourceGlyphGeometry} from '../font-candidates.mjs';
import {Resvg} from '@resvg/resvg-js';
import {fileURLToPath} from 'node:url';

async function image(width=8,height=6,fn=(x,y)=>[x*23,y*29,100,255]){
  const data=Buffer.alloc(width*height*4);for(let y=0;y<height;y++)for(let x=0;x<width;x++)data.set(fn(x,y),(y*width+x)*4);
  return encodePNG({width,height,data});
}
async function fixture(bytes){
  bytes ||= await image();
  const info=await inspectAsset(bytes,'image/png'),assets=new Map([['base',{asset:{id:'base',name:'source',...info},bytes}]]);
  const checkpoints=[],calls=[];let seq=0;
  const ctx={document:{id:'doc',width:info.width,height:info.height,layers:[{id:'layer',type:'raster',assetId:'base',x:0,y:0,width:info.width,height:info.height,z:0}]},config:{},
    getAsset:async(id)=>{assert.ok(assets.has(id),`asset ${id}`);return assets.get(id);},
    saveAsset:async(key,d,b)=>{const asset={id:`saved-${++seq}`,...d};assets.set(asset.id,{asset,bytes:Buffer.from(b)});return asset;},
    checkpoint:async(p)=>{checkpoints.push(p);if(p.providerReceipt)ctx.providerReceipt=p.providerReceipt;},cancelled:()=>false};
  const run=(op,params={},inputs=[])=>executeOperation({operation:op,params,inputs,targetLayerId:'layer',idempotencyKey:'test-key'},ctx);
  return {ctx,assets,checkpoints,calls,run};
}
test('edit minus protect and inward feather preserve protected/outside RGBA exactly in PNG',async()=>{
  const f=await fixture(),original=await decodeRGBA(f.assets.get('base').bytes,'image/png');
  const edit=await image(8,6,(x,y)=>[x>=2&&x<7&&y>=1&&y<5?255:0,0,0,255]);
  // White mask conventions; use equal RGB channels rather than a red overlay.
  const editRaw=await decodeRGBA(edit,'image/png');for(let i=0;i<48;i++)editRaw.data[i*4+1]=editRaw.data[i*4+2]=editRaw.data[i*4];
  f.assets.set('edit',{asset:{id:'edit',mime:'image/png'},bytes:await encodePNG(editRaw)});
  f.assets.set('protect',{asset:{id:'protect',mime:'image/png'},bytes:await image(8,6,x=>x===4?[255,255,255,255]:[0,0,0,255])});
  const out=await f.run('erase',{feather:2},[{role:'edit_mask',assetId:'edit'},{role:'protect_mask',assetId:'protect'}]);
  const actual=await decodeRGBA(f.assets.get(out.output.assetId).bytes,'image/png');let changed=0;
  for(let y=0;y<6;y++)for(let x=0;x<8;x++){
    const j=(y*8+x)*4;
    if(x===4||x<2||x>=7||y<1||y>=5)assert.deepEqual(actual.data.subarray(j,j+4),original.data.subarray(j,j+4));
    else if(actual.data[j+3]!==original.data[j+3])changed++;
  }
  assert.ok(changed>0);assert.equal(out.output.metadata.protectedPixelsExact,true);
});
test('soft protection always wins and feather never expands mask',()=>{
  const edit=new Uint8Array(25);edit[12]=255;const protect=new Uint8Array(25);protect[12]=1;
  assert.deepEqual(effectiveMask(5,5,edit,protect,4),new Uint8Array(25));
  const m=effectiveMask(5,5,edit,null,2);assert.ok(m[12]>0&&m[12]<255);assert.equal(m.reduce((s,v)=>s+(v>0),0),1);
});
test('resize, crop, pad, rotation and flip operate actual source pixels/dimensions',async()=>{
  const f=await fixture();
  for(const [op,p,size] of [['resize',{width:16,height:9},[16,9]],['crop',{x:1,y:2,width:3,height:2},[3,2]],['pad',{width:12,height:10,fill:'#ffffff'},[12,10]],['rotate',{degrees:90},[6,8]]]){
    const result=await f.run(op,p);assert.deepEqual([result.output.width,result.output.height],size);
  }
  const flipped=await f.run('flip',{axis:'horizontal'});const raw=await decodeRGBA(f.assets.get(flipped.output.assetId).bytes,'image/png');
  assert.deepEqual([...raw.data.subarray(0,4)],[7*23,0,100,255]);
  await assert.rejects(f.run('crop',{x:7,y:0,width:2,height:1}),/outside/);
});
test('pixel outputs without a selected target add a valid new layer with absent IDs omitted',async()=>{
  const f=await fixture();
  const result=await executeOperation({operation:'resize',inputs:[{role:'base',assetId:'base'}],params:{width:16,height:12},idempotencyKey:'new-layer'},f.ctx);
  assert.equal(result.commands[0].type,'layer.add');const layer=result.commands[0].layer;
  assert.equal(layer.maskAssetId,undefined);assert.doesNotThrow(()=>normalizeLayer(layer));assert.deepEqual([layer.width,layer.height],[16,12]);
  assert.equal(f.ctx.document.layers[0].assetId,'base');assert.deepEqual([f.ctx.document.layers[0].width,f.ctx.document.layers[0].height],[8,6]);
});
test('real Noto source glyphs receive bounded geometry candidates without confirming fonts or altering restored RGBA',async()=>{
  const fontPath=fileURLToPath(new URL('../fonts/NotoSansCJKsc-Regular.otf',import.meta.url)),fontBytes=await readFile(fontPath);
  const text='中文 MAI',size=48,width=520,height=120;
  const bytes=Buffer.from(new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#ffffff"/><text x="20" y="78" font-family="Noto Sans CJK SC" font-size="${size}" fill="#000000">${text}</text></svg>`,{font:{fontFiles:[fontPath],loadSystemFonts:false,defaultFontFamily:'Noto Sans CJK SC'}}).render().asPng());
  const f=await fixture(bytes),raw=await decodeRGBA(bytes,'image/png');f.ctx.document.assetIds=['base','registered-font','bad-font'];
  f.assets.set('registered-font',{asset:{id:'registered-font',name:'uploaded-real.otf',mime:'font/otf'},bytes:fontBytes});f.assets.set('bad-font',{asset:{id:'bad-font',name:'invalid.otf',mime:'font/otf'},bytes:Buffer.from('not a font')});
  const measurement=sourceGlyphGeometry(raw);assert.equal(measurement.measurement,'source_glyph_bounds');assert.ok(measurement.width<width);assert.ok(measurement.height<height);
  const fit=await createFontCandidateFitter(f.ctx),candidates=await fit(text,raw);assert.equal(candidates.length,1,'same registered and bundled bytes must be deduplicated');
  const candidate=candidates[0];assert.equal(candidate.family,'Noto Sans CJK SC');assert.equal(candidate.originalFont,'unknown');assert.equal(candidate.requiresManualConfirmation,true);assert.equal(candidate.glyphCoverage.ratio,1);assert.equal(candidate.geometryFit.measurement,'source_glyph_bounds');assert.ok(Math.abs(candidate.estimatedFontSize-size)<1.5,JSON.stringify(candidate));assert.ok(candidate.geometryFit.sizeError<.02);assert.equal(candidate.originalFontConfidence,undefined);assert.deepEqual(f.assets.get(candidate.fontAssetId).bytes,fontBytes);
  const calls=f.assets.size;assert.deepEqual(await fit(`中文${String.fromCodePoint(0x10ffff)}`,raw),[]);assert.equal(f.assets.size,calls,'missing glyphs cannot register a misleading candidate');
  f.ctx.checkpoints={restoreOCR:{items:[{text,confidence:1,bbox:[0,0,width,height]}],models:{fixture:'actual-Noto-source'}}};f.ctx.fetchImpl=async()=>{throw Error('No generation, GPU or remote OCR is permitted');};
  const result=await f.run('restore_layers',{segment:false,connected:false});const layer=result.commands.find(c=>c.type==='layer.add'&&c.layer.type==='text').layer;
  assert.equal(layer.metadata.fontConfirmed,false);assert.equal(layer.metadata.fontStatus,'unknown');assert.equal(layer.metadata.originalFont,'unknown');assert.ok(layer.metadata.fontCandidates.length>0&&layer.metadata.fontCandidates.length<=3);assert.equal(layer.fontAssetId,undefined);assert.equal(layer.assetId,layer.metadata.sourcePatchAssetId);assert.equal(result.output.differentChannels,0);assert.equal(result.output.coverage,1);
  const restoredDoc=applyCommands(createImageDocument({width,height,layers:f.ctx.document.layers,assetIds:[...f.assets.keys()]}),result.commands);
  const rendered=await decodeRGBA(await documentPng(restoredDoc,f.ctx.getAsset),'image/png');
  assert.ok(rendered.data.equals(raw.data),'rendering the complete restored group must preserve every original RGBA channel');
  assert.ok(f.assets.get('base').bytes.equals(bytes),'candidate fitting must not alter original source bytes');
});
test('restoring transparent and partially transparent pixels retains the original canvas rendering and source bytes',async()=>{
  const source=await image(4,3,(x,y)=>[73+x+y*4,119+x+y*4,201-x-y*4,[0,64,128,255][x]]),f=await fixture(source);
  const before=createImageDocument({width:4,height:3,layers:f.ctx.document.layers,assetIds:['base']});
  const originalRender=await decodeRGBA(await documentPng(before,f.ctx.getAsset),'image/png');
  const result=await f.run('restore_layers',{ocr:false,segment:false,connected:false});
  const after=applyCommands({...before,assetIds:[...f.assets.keys()]},result.commands);
  const restoredRender=await decodeRGBA(await documentPng(after,f.ctx.getAsset),'image/png');
  assert.equal(result.output.differentChannels,0);
  assert.ok(restoredRender.data.equals(originalRender.data),'ownership slicing must not add changes to alpha compositing');
  assert.ok(f.assets.get('base').bytes.equals(source),'hidden RGB and source alpha remain in the immutable source asset');
});
test('color key changes matching alpha, recolor retains alpha, masked geometry rejected',async()=>{
  const f=await fixture(await image(3,1,x=>x===0?[255,255,255,255]:[10,20,30,128]));
  let r=await f.run('color_key',{color:'#ffffff',tolerance:0});let d=await decodeRGBA(f.assets.get(r.output.assetId).bytes,'image/png');assert.equal(d.data[3],0);assert.equal(d.data[7],128);
  r=await f.run('recolor',{color:'#fe0102',mode:'flatten'});d=await decodeRGBA(f.assets.get(r.output.assetId).bytes,'image/png');assert.deepEqual([...d.data.subarray(4,8)],[254,1,2,128]);
  f.assets.set('mask',{asset:{mime:'image/png'},bytes:await image(3,1,()=>[255,255,255,255])});
  await assert.rejects(f.run('resize',{width:6,height:2},[{role:'protect_mask',assetId:'mask'}]),e=>e.code==='MASK_GEOMETRY');
});
test('ImageTracer produces genuine SVG paths and resvg renders actual dimensions',async()=>{
  const f=await fixture(await image(12,10,(x,y)=>x<6?[255,0,0,255]:[0,0,255,255]));
  const r=await f.run('trace',{preset:'logo',colors:2,pathomit:0});const a=f.assets.get(r.output.assetId);
  assert.match(a.bytes.toString(),/<path /);assert.equal(a.asset.mime,'image/svg+xml');assert.equal(a.asset.width,12);assert.equal(a.asset.height,10);assert.equal(r.commands[0].patch.type,'vector');
  assert.equal((await decodeRGBA(a.bytes,a.asset.mime)).data.length,12*10*4);
  await assert.rejects(inspectAsset(Buffer.from('<svg width="1" height="1"><script>alert(1)</script></svg>'),'image/svg+xml'),/active/);
});
test('restore with OCR, SAM2 and connected regions gives full original pixel partition and unknown fonts',async()=>{
  const f=await fixture(await image(10,8,(x,y)=>x<4&&y<3?[0,0,0,255]:x>=7?[255,0,0,255]:[255,255,255,255]));
  const segmentation=await image(10,8,x=>x>=7?[255,255,255,255]:[0,0,0,255]);
  f.ctx.config={ocrUrl:'http://ocr',comfyBaseUrl:'http://comfy',comfyPollMs:0,comfyPollAttempts:1};
  f.ctx.fetchImpl=async(url,opts={})=>{
    f.calls.push(url);
    if(url==='http://ocr/health')return Response.json({ready:true});
    if(url==='http://ocr/ocr')return Response.json({models:{rec:'PP-OCRv5_server_rec'},items:[{text:'中文',confidence:.95,bbox:[0,0,4,3]}]});
    if(url.endsWith('/upload/image'))return Response.json({name:'source.png'});
    if(url.endsWith('/prompt')){assert.equal(JSON.parse(opts.body).prompt['2'].inputs.model,'sam2.1_hiera_small.safetensors');return Response.json({prompt_id:'p1'});}
    if(url.endsWith('/history/p1'))return Response.json({p1:{outputs:{'5':{images:[{filename:'image2_segment_mask_0001.png'}]}}}});
    if(url.includes('/view?'))return new Response(segmentation);
    throw Error('unexpected request');
  };
  const r=await f.run('restore_layers');assert.equal(r.output.coverage,1);assert.equal(r.output.differentChannels,0);assert.equal(r.needsReview,true);
  const layers=r.commands.filter(x=>x.type==='layer.add').map(x=>x.layer);
  const text=layers.find(x=>x.type==='text');assert.equal(text.text,'中文');assert.equal(text.metadata.fontStatus,'unknown');assert.equal(text.metadata.fontConfirmed,false);assert.equal(text.assetId,text.metadata.sourcePatchAssetId);
  assert.equal(layers.reduce((s,l)=>s+l.metadata.ownedPixelCount,0),80);
  const composite=await sharp({create:{width:10,height:8,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).composite(layers.map(l=>({input:f.assets.get(l.assetId).bytes,left:l.x,top:l.y}))).png().toBuffer();
  assert.deepEqual((await decodeRGBA(composite,'image/png')).data,(await decodeRGBA(f.assets.get('base').bytes,'image/png')).data);
  const accepted=f.checkpoints.find(x=>x.providerReceipt?.promptId);assert.equal(accepted.providerReceipt.promptId,'p1');
});
test('restore ML unavailable retains pixels, residual coverage and explicit review',async()=>{
  const f=await fixture();const r=await f.run('restore_layers');assert.equal(r.output.coverage,1);assert.equal(r.output.differentChannels,0);assert.ok(r.output.warnings.length>=2);assert.equal(r.needsReview,true);assert.ok(r.commands.some(c=>c.layer?.metadata.role==='residual'));
});
test('unknown generation acceptance is uncertain and never automatically resubmitted',async()=>{
  const f=await fixture();let charged=0;f.ctx.config={imageBaseUrl:'https://images.test/v1',imageApiKey:'mock'};f.ctx.fetchImpl=async()=>{charged++;throw Error('socket closed');};
  const request={operation:'generate',params:{prompt:'mock'},idempotencyKey:'same'};
  await assert.rejects(generateImages(request,f.ctx),e=>e.uncertain===true);
  await assert.rejects(generateImages(request,f.ctx),e=>e.uncertain===true);assert.equal(charged,1);
});
test('Comfy prompt acknowledgement checkpoint survives pending state and resumes without resubmit',async()=>{
  const f=await fixture();let submissions=0;f.ctx.config={comfyBaseUrl:'http://comfy',comfyPollMs:0,comfyPollAttempts:1};
  f.ctx.fetchImpl=async(url)=>{
    if(url.endsWith('/upload/image'))return Response.json({name:'x.png'});
    if(url.endsWith('/prompt')){submissions++;return Response.json({prompt_id:'p2'});}
    if(url.includes('/history/')){assert.equal(f.ctx.providerReceipt.promptId,'p2');return Response.json({});}
    throw Error('unexpected');
  };
  const request={params:{scale:2},base:f.assets.get('base')};
  await assert.rejects(runComfy('super_resolution',request,f.ctx),e=>e.uncertain===true);
  await assert.rejects(runComfy('super_resolution',request,f.ctx),e=>e.uncertain===true);assert.equal(submissions,1);
});
test('RealESRGAN uses actual model workflow and rejects wrong output dimensions',async()=>{
  const f=await fixture();f.ctx.config={comfyBaseUrl:'http://comfy',comfyPollMs:0,comfyPollAttempts:1};let wrong=false;
  f.ctx.fetchImpl=async(url,opts={})=>{
    if(url.endsWith('/upload/image'))return Response.json({name:'x.png'});
    if(url.endsWith('/prompt')){assert.equal(JSON.parse(opts.body).prompt['2'].inputs.model_name,'RealESRGAN_x2plus.pth');return Response.json({prompt_id:'sr'});}
    if(url.includes('/history/'))return Response.json({sr:{outputs:{4:{images:[{filename:'sr.png'}]}}}});
    if(url.includes('/view?'))return new Response(await image(wrong?8:16,wrong?6:12));
    throw Error('unexpected');
  };
  const r=await f.run('super_resolution',{scale:2});assert.equal(r.output.width,16);assert.equal(r.output.height,12);
  wrong=true;await assert.rejects(f.run('super_resolution',{scale:2}),e=>e.code==='UPSTREAM_DIMENSIONS');
});
test('inpaint sends effective alpha mask and composites protect pixels after mocked image edit',async()=>{
  const f=await fixture();f.assets.set('edit',{asset:{mime:'image/png'},bytes:await image(8,6,()=>[255,255,255,255])});
  f.assets.set('protect',{asset:{mime:'image/png'},bytes:await image(8,6,x=>x===2?[255,255,255,255]:[0,0,0,255])});
  f.ctx.config={imageBaseUrl:'https://images.test/v1',imageApiKey:'mock'};
  f.ctx.fetchImpl=async(url,opts)=>{
    assert.equal(url,'https://images.test/v1/images/edits');const blob=opts.body.get('mask');const mask=await decodeRGBA(Buffer.from(await blob.arrayBuffer()),'image/png');
    const [width,height]=opts.body.get('size').split('x').map(Number);assert.equal(mask.width,width);assert.equal(mask.height,height);
    // 8:6 source letterboxed into 1536:1024, scale 1024/6; protected x=2 maps inside that stripe.
    const y=512,protectedX=512,editableX=180;assert.equal(mask.data[(y*width+protectedX)*4+3],255);assert.equal(mask.data[(y*width+editableX)*4+3],0);
    return Response.json({data:[{b64_json:(await image(width,height,()=>[255,0,0,255])).toString('base64')}]});
  };
  const r=await f.run('inpaint',{prompt:'mock'},[{role:'edit_mask',assetId:'edit'},{role:'protect_mask',assetId:'protect'}]);const actual=await decodeRGBA(f.assets.get(r.output.assetId).bytes,'image/png');const source=await decodeRGBA(f.assets.get('base').bytes,'image/png');
  for(let y=0;y<6;y++){const i=(y*8+2)*4;assert.deepEqual(actual.data.subarray(i,i+4),source.data.subarray(i,i+4));}
  assert.deepEqual([...actual.data.subarray(0,4)],[255,0,0,255]);
});
test('capabilities distinguish model configuration from actual worker readiness',async()=>{
  const c=await providerCapabilities({imageBaseUrl:'',imageApiKey:'',ocrUrl:'http://ocr',comfyBaseUrl:'http://comfy'},async(url)=>url.endsWith('/health')?Response.json({ready:false,reason:'model_manifest_missing'}):Response.json({}));
  assert.equal(c.generate.ready,false);assert.equal(c.ocr.ready,false);assert.equal(c.segment.ready,false);assert.equal(c.restore_layers.degraded,true);
});
test('real pinned font metadata, PDF and ZIP magic inspection',async()=>{
  const font=await inspectAsset(await readFile(new URL('../fonts/NotoSansCJKsc-Regular.otf',import.meta.url)),'font/otf');
  assert.equal(font.mime,'font/otf');assert.equal(font.metadata.family,'Noto Sans CJK SC');assert.equal(font.metadata.postscriptName,'NotoSansCJKsc-Regular');assert.ok(font.metadata.numGlyphs>10000);
  assert.equal((await inspectAsset(Buffer.from('%PDF-1.7\n'),'application/pdf')).mime,'application/pdf');
  assert.equal((await inspectAsset(Buffer.from([0x50,0x4b,0x03,0x04]),'application/zip')).mime,'application/zip');
});
test('processor checkpoint restores identical layer IDs without recomputing assets',async()=>{
  const f=await fixture();const r=await f.run('restore_layers',{ocr:false,segment:false});
  f.ctx.checkpoints={processorResult:r};let reads=0;f.ctx.getAsset=async()=>{reads++;throw Error('must not read');};
  const recovered=await f.run('restore_layers');assert.deepEqual(recovered,r);assert.equal(reads,0);
});
test('selected raster restores in place as a scaled group without changing adjacent native text or Logo',async()=>{
  const f=await fixture(await image(8,6,x=>x<4?[255,255,255,255]:[255,0,0,255]));
  const target={...f.ctx.document.layers[0],parentId:'parent',x:30,y:40,width:16,height:18,rotation:37,z:5,opacity:.7,visible:true,locked:false};
  const text={id:'native-text',type:'text',parentId:'parent',text:'保留文字',fontFamily:'Noto Sans CJK SC',metadata:{fontConfirmed:true},x:100,y:40,width:200,height:50,z:6};
  const logo={id:'logo',type:'vector',assetId:'logo-source',parentId:'parent',x:100,y:100,width:80,height:80,z:7,metadata:{pathStyles:{0:{fill:'#fe0000'}}}};
  f.ctx.document.layers=[{id:'parent',type:'group',x:0,y:0,width:400,height:400,z:0},target,text,logo];const before=structuredClone(f.ctx.document);
  const r=await f.run('restore_layers',{ocr:false,segment:false});assert.equal(r.output.targetGroupId,target.id);
  assert.equal(r.commands.filter(c=>c.type==='layer.remove').length,0);assert.equal(r.commands.filter(c=>c.type==='document.update').length,0);
  const update=r.commands.find(c=>c.type==='layer.update');assert.equal(update.layerId,target.id);assert.equal(update.patch.type,'group');
  for(const key of ['id','parentId','x','y','width','height','rotation','z','opacity','visible','locked'])assert.equal(update.patch[key],undefined);
  for(const c of r.commands.filter(c=>c.type==='layer.add')){const l=c.layer;assert.equal(l.parentId,target.id);assert.equal(l.x,l.sourceRect[0]*2);assert.equal(l.y,l.sourceRect[1]*3);assert.equal(l.width,l.sourceRect[2]*2);assert.equal(l.height,l.sourceRect[3]*3);}
  assert.deepEqual(f.ctx.document,before);assert.ok(r.commands.every(c=>c.layerId!=='logo'&&c.layerId!=='native-text'));
});
test('whole-document restore requires a new flat import and refuses mixed native documents',async()=>{
  const f=await fixture();let r=await executeOperation({operation:'restore_layers',params:{ocr:false,segment:false},inputs:[{role:'base',assetId:'base'}]},f.ctx);
  assert.deepEqual(r.commands.filter(c=>c.type==='layer.remove').map(c=>c.layerId),['layer']);assert.ok(r.commands.some(c=>c.type==='document.update'));
  f.ctx.document.layers.push({id:'native',type:'text',text:'保留',metadata:{fontConfirmed:true}});
  await assert.rejects(executeOperation({operation:'restore_layers',params:{ocr:false,segment:false},inputs:[{role:'base',assetId:'base'}]},f.ctx),e=>e.code==='RESTORE_SCOPE'&&e.status===422);
});
test('model frames are explicit per-model and unknown sizes fail before submitting',()=>{
  assert.deepEqual(imageFrameFor('gpt-image-1.5',1200,600),{width:1536,height:1024});
  assert.deepEqual(imageFrameFor('gpt-image-2',600,1200),{width:1024,height:1536});
  assert.throws(()=>imageFrameFor('unknown-image-model',600,400),e=>e.code==='INPAINT_SIZE_UNSUPPORTED');
  assert.deepEqual(imageFrameFor('custom',1,1,{imageFrames:{custom:[{width:2048,height:2048}]}}),{width:2048,height:2048});
});
test('luminance recolor retains source texture while flatten is explicit',async()=>{
  const f=await fixture(await image(4,1,x=>[30+x*45,30+x*45,30+x*45,255]));
  const r=await f.run('recolor',{color:'#f00000'}),d=await decodeRGBA(f.assets.get(r.output.assetId).bytes,'image/png');
  const lin=v=>v/255<=.04045?v/255/12.92:((v/255+.055)/1.055)**2.4;
  for(let x=0;x<4;x++){const y=.2126*lin(d.data[x*4])+.7152*lin(d.data[x*4+1])+.0722*lin(d.data[x*4+2]);assert.ok(Math.abs(y-lin(30+x*45))<.005);}
  assert.notDeepEqual([...d.data.subarray(0,3)],[...d.data.subarray(12,15)]);
});
test('traditional repair and solid fill modify only effective region with exact protection',async()=>{
  const f=await fixture(await image(8,6,(x,y)=>x>=2&&x<=4&&y>=2&&y<=3?[255,0,0,255]:[40,80,120,255]));
  f.assets.set('edit',{asset:{mime:'image/png'},bytes:await image(8,6,(x,y)=>x>=2&&x<=4&&y>=2&&y<=3?[255,255,255,255]:[0,0,0,255])});
  f.assets.set('protect',{asset:{mime:'image/png'},bytes:await image(8,6,(x,y)=>x===4?[255,255,255,255]:[0,0,0,255])});
  const inputs=[{role:'edit_mask',assetId:'edit'},{role:'protect_mask',assetId:'protect'}];
  const r=await f.run('repair',{iterations:12},inputs),d=await decodeRGBA(f.assets.get(r.output.assetId).bytes,'image/png'),src=await decodeRGBA(f.assets.get('base').bytes,'image/png');
  assert.equal(r.output.metadata.method,'boundary_propagation_harmonic');assert.equal(r.needsReview,true);
  for(let y=0;y<6;y++)for(let x=0;x<8;x++){const i=(y*8+x)*4;if(x<2||x>3||y<2||y>3)assert.deepEqual(d.data.subarray(i,i+4),src.data.subarray(i,i+4));}
  const filled=await f.run('fill',{color:'#00ff00'},inputs);const fd=await decodeRGBA(f.assets.get(filled.output.assetId).bytes,'image/png');assert.deepEqual([...fd.data.subarray((2*8+2)*4,(2*8+2)*4+4)],[0,255,0,255]);
});
test('RealESRGAN x4 reports actual fourfold dimensions and carries source transparency',async()=>{
  const f=await fixture(await image(8,6,x=>[20,40,60,x===0?0:255]));f.ctx.config={comfyBaseUrl:'http://comfy',comfyPollMs:0,comfyPollAttempts:1};
  f.ctx.fetchImpl=async(url,opts={})=>{
    if(url.endsWith('/upload/image'))return Response.json({name:'x.png'});
    if(url.endsWith('/prompt')){assert.equal(JSON.parse(opts.body).prompt['2'].inputs.model_name,'RealESRGAN_x4plus.pth');return Response.json({prompt_id:'sr4'});}
    if(url.includes('/history/'))return Response.json({sr4:{outputs:{4:{images:[{filename:'sr4.png'}]}}}});
    if(url.includes('/view?'))return new Response(await image(32,24,()=>[40,80,120,255]));
    throw Error('unexpected');
  };
  const r=await f.run('super_resolution',{scale:4}),d=await decodeRGBA(f.assets.get(r.output.assetId).bytes,'image/png');
  assert.deepEqual([r.output.width,r.output.height],[32,24]);assert.equal(r.output.metadata.alphaResampledFromSource,true);assert.equal(d.data[3],0);
});
test('EXIF6 source uses canonical dimensions, normalized masks and lossless protected pixels',async()=>{
  const unrotated=await image(4,2,(x,y)=>[20+x*45,40+y*110,100+x*15,255]);
  const jpeg=await sharp(unrotated).jpeg({quality:100,chromaSubsampling:'4:4:4'}).withMetadata({orientation:6}).toBuffer();
  const info=await inspectAsset(jpeg,'image/jpeg');assert.deepEqual([info.width,info.height],[2,4]);assert.equal(info.metadata.originalOrientation,6);assert.equal(info.metadata.originalWidth,4);assert.equal(info.metadata.originalHeight,2);assert.equal(info.metadata.normalizedOrientation,1);
  const source=await decodeRGBA(jpeg,'image/jpeg'),expected=await sharp(jpeg).autoOrient().toColourspace('srgb').ensureAlpha().raw().toBuffer();assert.deepEqual(source.data,expected);assert.deepEqual([source.width,source.height],[2,4]);
  const f=await fixture(jpeg);
  f.assets.set('edit',{asset:{mime:'image/png'},bytes:await image(2,4,()=>[255,255,255,255])});
  f.assets.set('protect',{asset:{mime:'image/png'},bytes:await image(2,4,x=>x===0?[255,255,255,255]:[0,0,0,255])});
  const r=await f.run('recolor',{color:'#00ff00',mode:'flatten'},[{role:'edit_mask',assetId:'edit'},{role:'protect_mask',assetId:'protect'}]);
  const actual=await decodeRGBA(f.assets.get(r.output.assetId).bytes,'image/png');
  for(let y=0;y<4;y++){const j=y*2*4;assert.deepEqual(actual.data.subarray(j,j+4),source.data.subarray(j,j+4));assert.deepEqual([...actual.data.subarray(j+4,j+8)],[0,255,0,255]);}
  assert.deepEqual(f.assets.get('base').bytes,jpeg); // immutable uploaded EXIF-bearing original
  assert.equal((await inspectAsset(f.assets.get(r.output.assetId).bytes,'image/png')).metadata.originalOrientation,1);
  f.assets.set('wrong',{asset:{mime:'image/png'},bytes:await image(4,2,()=>[255,255,255,255])});await assert.rejects(f.run('erase',{},[{role:'edit_mask',assetId:'wrong'}]),e=>e.code==='MASK_SIZE');
});
test('EXIF6 raster export is canonical PNG with zero RGBA difference',async()=>{
  const sourcePng=await image(4,2,(x,y)=>[40+x*40,30+y*130,90+x*20,255]);
  const jpeg=await sharp(sourcePng).jpeg({quality:100,chromaSubsampling:'4:4:4'}).withMetadata({orientation:6}).toBuffer(),f=await fixture(jpeg);
  const document={width:2,height:4,layers:[{...f.ctx.document.layers[0],width:2,height:4,opacity:1,rotation:0,visible:true,locked:false}]};
  const exported=await documentPng(document,f.ctx.getAsset),actual=await decodeRGBA(exported,'image/png'),normalized=await decodeRGBA(jpeg,'image/jpeg');
  assert.deepEqual([actual.width,actual.height],[2,4]);assert.deepEqual(actual.data,normalized.data);assert.deepEqual(f.assets.get('base').bytes,jpeg);
});
function textPatchFixture(f){
  f.ctx.document.layers[0]={...f.ctx.document.layers[0],type:'text',text:'旧文字',metadata:{role:'sourcePatch',sourcePatchAssetId:'base',fontConfirmed:false,fontStatus:'unknown'}};
  return f;
}
test('prepare_text clears white-background glyph pixels but retains visible original sourcePatch and unknown font',async()=>{
  const f=textPatchFixture(await fixture(await image(24,12,(x,y)=>x>=6&&x<18&&y>=4&&y<8?[0,0,0,255]:[255,255,255,255])));
  const original=f.assets.get('base').bytes,r=await f.run('prepare_text');assert.equal(r.needsReview,false);assert.ok(r.output.cleanBackgroundAssetId);assert.equal(r.output.glyphPixels,48);
  const patch=r.commands[0].patch;assert.equal(patch.type,undefined);assert.equal(patch.assetId,undefined);assert.equal(patch.text,undefined);assert.equal(patch.metadata.fontConfirmed,false);assert.equal(patch.metadata.fontStatus,'unknown');assert.equal(patch.metadata.sourcePatchAssetId,'base');
  const clean=await decodeRGBA(f.assets.get(r.output.cleanBackgroundAssetId).bytes,'image/png');for(let i=0;i<clean.data.length;i+=4)assert.deepEqual([...clean.data.subarray(i,i+4)],[255,255,255,255]);
  const mask=await decodeRGBA(f.assets.get(r.output.glyphMaskAssetId).bytes,'image/png');assert.equal(mask.data[(4*24+6)*4],255);assert.equal(mask.data[0],0);assert.deepEqual(f.assets.get('base').bytes,original);assert.equal(f.ctx.document.layers[0].assetId,'base');
});
test('prepare_text rejects complex backgrounds with 422 and leaves the original layer/assets untouched',async()=>{
  const f=textPatchFixture(await fixture(await image(24,12,(x,y)=>[x*10,y*20,(x+y)*6,255]))),before=structuredClone(f.ctx.document),bytes=f.assets.get('base').bytes;
  await assert.rejects(f.run('prepare_text'),e=>e.code==='TEXT_BACKGROUND_REQUIRED'&&e.status===422&&e.needsReview===true);
  assert.deepEqual(f.ctx.document,before);assert.deepEqual(f.assets.get('base').bytes,bytes);assert.equal(f.assets.size,1);
});
test('fill/repair text_background save a clean asset while preserving text type and original crop until font confirmation',async()=>{
  const f=textPatchFixture(await fixture(await image(24,12,(x,y)=>x>=6&&x<18&&y>=4&&y<8?[0,0,0,255]:[240,240,240,255])));
  f.assets.set('edit',{asset:{mime:'image/png'},bytes:await image(24,12,(x,y)=>x>=6&&x<18&&y>=4&&y<8?[255,255,255,255]:[0,0,0,255])});
  const inputs=[{role:'edit_mask',assetId:'edit'}];
  for(const op of ['fill','repair']){
    const r=await f.run(op,{color:'#f0f0f0',purpose:'text_background'},inputs),patch=r.commands[0].patch;
    assert.ok(r.output.cleanBackgroundAssetId);assert.equal(patch.assetId,undefined);assert.equal(patch.type,undefined);assert.equal(patch.text,undefined);assert.equal(patch.metadata.sourcePatchAssetId,'base');assert.equal(patch.metadata.fontConfirmed,false);
    const d=await decodeRGBA(f.assets.get(r.output.cleanBackgroundAssetId).bytes,'image/png');assert.deepEqual([...d.data.subarray((4*24+6)*4,(4*24+6)*4+4)],[240,240,240,255]);
  }
});
test('inpaint text_background keeps original sourcePatch text visible until a font is confirmed',async()=>{
  const f=textPatchFixture(await fixture(await image(24,12,(x,y)=>x>=6&&x<18&&y>=4&&y<8?[0,0,0,255]:[255,255,255,255])));
  f.assets.set('edit',{asset:{mime:'image/png'},bytes:await image(24,12,(x,y)=>x>=6&&x<18&&y>=4&&y<8?[255,255,255,255]:[0,0,0,255])});
  f.ctx.config={imageBaseUrl:'https://images.test/v1',imageApiKey:'mock'};
  f.ctx.fetchImpl=async(_url,options)=>{const [width,height]=options.body.get('size').split('x').map(Number);return Response.json({data:[{b64_json:(await image(width,height,()=>[255,255,255,255])).toString('base64')}]});};
  const r=await f.run('inpaint',{purpose:'text_background',prompt:'Remove the old glyphs only'},[{role:'edit_mask',assetId:'edit'}]),patch=r.commands[0].patch;
  assert.equal(patch.assetId,undefined);assert.equal(patch.type,undefined);assert.equal(patch.text,undefined);assert.equal(patch.metadata.sourcePatchAssetId,'base');assert.equal(patch.metadata.fontConfirmed,false);assert.ok(patch.metadata.cleanBackgroundAssetId);
  assert.equal(f.ctx.document.layers[0].assetId,'base');const bg=await decodeRGBA(f.assets.get(r.output.cleanBackgroundAssetId).bytes,'image/png');assert.deepEqual([...bg.data.subarray((5*24+8)*4,(5*24+8)*4+4)],[255,255,255,255]);
});
test('active masks bake into normalized visible alpha and become audited inactive outputs',async()=>{
  const f=await fixture(await image(4,4,()=>[120,80,40,128]));
  f.assets.set('active',{asset:{id:'active',mime:'image/png'},bytes:await image(4,4,x=>x<2?[128,128,128,255]:[0,0,0,255])});
  f.assets.set('protect',{asset:{id:'protect',mime:'image/png'},bytes:await image(4,4,()=>[255,255,255,255])});
  f.ctx.document.layers[0].maskAssetId='active';f.ctx.document.layers[0].metadata={fontStatus:'unknown',textConfidence:.93,sourceRect:[10,20,4,4]};
  const r=await f.run('recolor',{color:'#00ff00',mode:'flatten'},[{role:'protect_mask',assetId:'protect'}]),out=f.assets.get(r.output.assetId),raw=await decodeRGBA(out.bytes,'image/png');
  for(let y=0;y<4;y++)for(let x=0;x<4;x++)assert.deepEqual([...raw.data.subarray((y*4+x)*4,(y*4+x)*4+4)],x<2?[120,80,40,64]:[0,0,0,0]);
  const patch=r.commands[0].patch;assert.equal(patch.maskAssetId,null);assert.equal(patch.metadata.sourceMaskAssetId,'active');assert.equal(patch.metadata.fontStatus,'unknown');assert.equal(patch.metadata.textConfidence,.93);assert.deepEqual(patch.metadata.sourceRect,[10,20,4,4]);
  assert.ok(out.asset.inputs.some(i=>i.role==='active_mask'&&i.assetId==='active'&&i.hash.length===64));
});
test('mask to resize to SVG/PNG/PDF renders without stale dimensions while logical layout stays fixed',async()=>{
  const f=await fixture(await image(4,4,()=>[240,20,20,255]));f.assets.set('active',{asset:{id:'active',mime:'image/png'},bytes:await image(4,4,x=>x<2?[255,255,255,255]:[0,0,0,255])});
  f.ctx.document.layers[0]={...f.ctx.document.layers[0],maskAssetId:'active',opacity:1,rotation:0,visible:true,locked:false,metadata:{sourceMaskAssetId:'prior'}};
  const r=await f.run('resize',{width:8,height:8}),patch=r.commands[0].patch;assert.deepEqual([r.output.width,r.output.height],[8,8]);assert.deepEqual([patch.width,patch.height],[4,4]);assert.equal(patch.maskAssetId,null);
  const doc={...f.ctx.document,name:'Mask resize export',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),layers:[{...f.ctx.document.layers[0],...patch}]};
  const {svg}=await documentSvg(doc,f.ctx.getAsset);assert.doesNotMatch(svg,/<mask /);
  const png=await documentPng(doc,f.ctx.getAsset),pixels=await decodeRGBA(png,'image/png');assert.deepEqual([pixels.width,pixels.height],[4,4]);assert.equal(pixels.data[(3)*4+3],0);assert.ok(pixels.data[3]>200);
  const pdf=await documentPdf(doc,f.ctx.getAsset);assert.equal(pdf.subarray(0,5).toString(),'%PDF-');assert.match(pdf.toString('latin1'),/\/SMask/);
});
test('resize/SR keep raster and adjacent native text/Logo geometry unless resizeLayout is explicit',async()=>{
  const f=await fixture(),target={...f.ctx.document.layers[0],x:30,y:40,width:160,height:120,rotation:23,z:4,parentId:'parent',metadata:{sourceRect:[1,2,8,6]}},text={id:'native',type:'text',text:'独立文字',x:220,y:50,width:160,height:60,z:5},logo={id:'logo',type:'vector',x:220,y:130,width:80,height:80,z:6,assetId:'logo'};
  f.ctx.document.layers=[target,text,logo];const before=structuredClone(f.ctx.document);
  let r=await f.run('resize',{width:16,height:12}),patch=r.commands[0].patch;assert.deepEqual([patch.width,patch.height],[160,120]);for(const key of ['x','y','rotation','z','parentId'])assert.equal(patch[key],undefined);assert.deepEqual(f.ctx.document,before);assert.deepEqual(patch.metadata.sourceRect,[1,2,8,6]);
  r=await f.run('resize',{width:16,height:12,resizeLayout:true});assert.deepEqual([r.commands[0].patch.width,r.commands[0].patch.height],[16,12]);
  f.ctx.config={comfyBaseUrl:'http://comfy',comfyPollMs:0,comfyPollAttempts:1};f.ctx.fetchImpl=async url=>url.endsWith('/upload/image')?Response.json({name:'x.png'}):url.endsWith('/prompt')?Response.json({prompt_id:'layout-sr'}):url.includes('/history/')?Response.json({'layout-sr':{outputs:{4:{images:[{filename:'sr.png'}]}}}}):new Response(await image(16,12));
  r=await f.run('super_resolution',{scale:2});assert.deepEqual([r.commands[0].patch.width,r.commands[0].patch.height],[160,120]);assert.deepEqual(f.ctx.document,before);
});
test('refine mask recovers only original visible pixels inside sourceRect and protects current transparency',async()=>{
  const original=await image(12,10,(x,y)=>[x*15,y*20,80,255]),cropped=await sharp(original).extract({left:2,top:2,width:6,height:4}).png().toBuffer(),raw=await decodeRGBA(cropped,'image/png');
  for(let y=0;y<4;y++)for(let x=0;x<6;x++)if(x>=3)raw.data.fill(0,(y*6+x)*4,(y*6+x)*4+4);
  const f=await fixture(await encodePNG(raw));f.assets.set('original',{asset:{id:'original',mime:'image/png'},bytes:original});f.ctx.document.layers[0]={...f.ctx.document.layers[0],sourceAssetId:'original',sourceRect:[2,2,6,4],x:30,y:40,width:120,height:80,rotation:23,metadata:{fontStatus:'unknown',textConfidence:.9}};
  f.assets.set('edit',{asset:{id:'edit',mime:'image/png'},bytes:await image(6,4,()=>[255,255,255,255])});f.assets.set('protect',{asset:{id:'protect',mime:'image/png'},bytes:await image(6,4,x=>x===5?[255,255,255,255]:[0,0,0,255])});
  const r=await f.run('refine_mask',{},[{role:'edit',assetId:'edit'},{role:'protect',assetId:'protect'}]),actual=await decodeRGBA(f.assets.get(r.output.assetId).bytes,'image/png'),expected=await decodeRGBA(cropped,'image/png');
  for(let y=0;y<4;y++)for(let x=0;x<6;x++){const j=(y*6+x)*4;assert.deepEqual(actual.data.subarray(j,j+4),x===5?Buffer.alloc(4):expected.data.subarray(j,j+4));}
  assert.equal(r.output.canExpandWithinSourceRect,true);assert.equal(r.output.hiddenContent,'not_reconstructed');assert.deepEqual(f.assets.get('original').bytes,original);assert.deepEqual(f.assets.get('base').bytes,await encodePNG(raw));
  const patch=r.commands[0].patch;for(const key of ['type','text','x','y','width','height','rotation','sourceAssetId','sourceRect'])assert.equal(patch[key],undefined);assert.equal(patch.metadata.textConfidence,.9);
});
test('refine sourcePatch keeps text editable and without an original never invents transparent pixels',async()=>{
  const f=textPatchFixture(await fixture(await image(6,4,x=>x<3?[0,0,0,255]:[0,0,0,0])));f.assets.set('edit',{asset:{mime:'image/png'},bytes:await image(6,4,()=>[255,255,255,255])});
  const r=await f.run('refine_mask',{},[{role:'edit',assetId:'edit'}]),actual=await decodeRGBA(f.assets.get(r.output.assetId).bytes,'image/png');
  assert.equal(actual.data[(5)*4+3],0);assert.equal(r.output.canExpandWithinSourceRect,false);assert.equal(r.needsReview,true);const patch=r.commands[0].patch;assert.equal(patch.type,undefined);assert.equal(patch.text,undefined);assert.equal(patch.metadata.sourcePatchAssetId,r.output.assetId);assert.equal(patch.metadata.originalSourcePatchAssetId,'base');assert.equal(patch.metadata.fontConfirmed,false);assert.equal(f.ctx.document.layers[0].type,'text');
});
test('refine after pixel resize resamples the original sourceRect into current mask coordinates',async()=>{
  const original=await image(12,10,(x,y)=>[x*14,y*18,80,255]),crop=await sharp(original).extract({left:2,top:2,width:6,height:4}).resize(3,2).png().toBuffer(),raw=await decodeRGBA(crop,'image/png');
  const damaged={...raw,data:Buffer.from(raw.data)};damaged.data.fill(0,8,12);damaged.data.fill(0,20,24);
  const f=await fixture(await encodePNG(damaged));f.assets.set('original',{asset:{id:'original',mime:'image/png'},bytes:original});f.ctx.document.layers[0]={...f.ctx.document.layers[0],sourceAssetId:'original',sourceRect:[2,2,6,4],width:120,height:80};
  f.assets.set('edit',{asset:{mime:'image/png'},bytes:await image(3,2,()=>[255,255,255,255])});const r=await f.run('refine_mask',{},[{role:'edit',assetId:'edit'}]);
  assert.deepEqual([r.output.width,r.output.height],[3,2]);assert.deepEqual((await decodeRGBA(f.assets.get(r.output.assetId).bytes,'image/png')).data,raw.data);assert.ok(f.assets.get(r.output.assetId).asset.inputs.some(x=>x.role==='original_source'&&x.assetId==='original'));
  assert.equal(r.commands[0].patch.width,undefined);assert.equal(r.commands[0].patch.height,undefined);
});
