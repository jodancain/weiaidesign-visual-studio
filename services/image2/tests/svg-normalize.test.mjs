import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {XMLParser} from 'fast-xml-parser';
import {normalizeSvg,inspectDrawingNodes} from '../svg-normalize.mjs';
import {decodeRGBA,encodePNG,inspectAsset} from '../processors.mjs';
import {documentPng,documentSvg,documentPdf} from '../exports.mjs';

const rgba=(raw,x,y)=>[...raw.data.subarray((y*raw.width+x)*4,(y*raw.width+x)*4+4)];
const xml=svg=>new XMLParser({ignoreAttributes:false,preserveOrder:true}).parse(svg);
function elements(svg){const found=[];function walk(nodes){for(const node of nodes){const tag=Object.keys(node).find(k=>k!==':@'&&Array.isArray(node[k]));if(!tag)continue;found.push({tag,attrs:node[':@']||{}});walk(node[tag]);}}walk(xml(svg));return found;}
const fullPath='<path d="M0 0H8V6H0Z" fill="#000000"/>';
const masked=`<svg xmlns="http://www.w3.org/2000/svg" width="8" height="6"><defs><clipPath id="clip"><path d="M0 0H4V6H0Z" fill="#ffffff"/></clipPath><mask id="mask" maskUnits="userSpaceOnUse" x="0" y="0" width="8" height="6"><rect width="8" height="6" fill="#ffffff"/></mask></defs><g clip-path="url(#clip)" mask="url(#mask)">${fullPath}</g></svg>`;

test('source physical units create the missing viewBox before responsive sizing or display scaling',async()=>{
  const source='<svg xmlns="http://www.w3.org/2000/svg" width="1in" height="72pt"><rect x="0" y="0" width="96" height="96" fill="#ff0000"/></svg>';
  const intrinsic=normalizeSvg(source,{fallbackWidth:300,fallbackHeight:500});assert.equal(intrinsic.width,96);assert.equal(intrinsic.height,96);assert.deepEqual(intrinsic.viewBox,[0,0,96,96]);
  const responsive=normalizeSvg(source,{responsive:true,preserveAspectRatio:'none',fallbackWidth:300,fallbackHeight:500});assert.equal(responsive.width,96);assert.deepEqual(responsive.viewBox,intrinsic.viewBox);assert.match(responsive.svg,/width="100%" height="100%"/);assert.match(responsive.svg,/viewBox="0 0 96 96"/);
  const raw=await decodeRGBA(Buffer.from(intrinsic.svg),'image/svg+xml');assert.deepEqual([raw.width,raw.height],[96,96]);assert.deepEqual(rgba(raw,95,95),[255,0,0,255]);
  for(const [unit,size] of [['25.4mm',96],['2.54cm',96],['6pc',96],['101.6q',96],['96px',96]]){const result=normalizeSvg(`<svg width="${unit}" height="${unit}">${fullPath}</svg>`);assert.ok(Math.abs(result.width-size)<1e-8);assert.ok(Math.abs(result.height-size)<1e-8);}
});
test('existing nonzero viewBox remains authoritative and known viewport fallback resolves percentages',()=>{
  const normalized=normalizeSvg('<svg width="100%" height="100%" viewBox="-10 -20 40 30"><path d="M-10 -20H30V10H-10Z"/></svg>',{fallbackWidth:80,fallbackHeight:60});
  assert.deepEqual(normalized.viewBox,[-10,-20,40,30]);assert.deepEqual([normalized.width,normalized.height],[80,60]);
  assert.deepEqual(normalizeSvg('<svg width="80" viewBox="0 0 40 30"/>').viewBox,[0,0,40,30]);assert.equal(normalizeSvg('<svg width="80" viewBox="0 0 40 30"/>').height,60);
  assert.throws(()=>normalizeSvg('<svg><path d="M0 0H8V6H0Z"/></svg>'),e=>e.code==='SVG_VIEWPORT_REQUIRED');
  assert.throws(()=>normalizeSvg('<svg width="0" height="6"/>'),e=>e.code==='SVG_VIEWPORT');
});
test('resource descendants never become drawing nodes, and old resource path-0 cannot repaint a new drawing path',async()=>{
  const normalized=normalizeSvg(masked,{styles:{'path-0':{fill:'#ff0000'},'rect-0':{fill:'#000000'}}});
  assert.deepEqual(normalized.drawingNodes,[{id:'i2-draw-path-0',tag:'path',legacyIds:['path-1']}]);assert.equal(normalized.legacyAliases['path-0'],null);assert.equal(normalized.legacyAliases['rect-0'],null);assert.equal(normalized.legacyAliases['path-1'],'i2-draw-path-0');
  assert.deepEqual(inspectDrawingNodes(masked),normalized.drawingNodes);
  const source=await decodeRGBA(Buffer.from(masked),'image/svg+xml'),rendered=await decodeRGBA(Buffer.from(normalized.svg),'image/svg+xml');assert.deepEqual(rendered.data,source.data);
  const coloured=normalizeSvg(masked,{scope:'canvas-logo',styles:{'*':{fill:'#00ff00'},'path-1':{fill:'#ee2222'}}}),raw=await decodeRGBA(Buffer.from(coloured.svg),'image/svg+xml');
  assert.deepEqual(rgba(raw,1,2),[238,34,34,255]);assert.equal(rgba(raw,6,2)[3],0);
  const resourcePath=elements(coloured.svg).find(element=>element.tag==='path'&&element.attrs['@_id']===undefined);assert.equal(resourcePath.attrs['@_fill'],'#ffffff');
  assert.equal(elements(coloured.svg).find(element=>element.tag==='rect').attrs['@_fill'],'#ffffff');
});
test('stable anonymous drawing IDs survive added resources and normalized SVG round trips',()=>{
  const plain=`<svg width="8" height="6">${fullPath}</svg>`,first=normalizeSvg(plain),withResources=normalizeSvg(masked);
  assert.equal(first.drawingNodes[0].id,withResources.drawingNodes[0].id);assert.equal(first.legacyAliases['path-0'],'i2-draw-path-0');assert.equal(withResources.legacyAliases['path-0'],null);
  assert.equal(normalizeSvg(first.svg).svg,first.svg);assert.equal(normalizeSvg(first.svg).drawingNodes[0].id,first.drawingNodes[0].id);
});
test('duplicate resource IDs resolve in their nearest nested viewport and remain isolated between clones',async()=>{
  const nested=(x,color)=>`<svg x="${x}" width="4" height="6" viewBox="0 0 4 6"><defs><linearGradient id="paint"><stop offset="0" stop-color="${color}"/><stop offset="1" stop-color="${color}"/></linearGradient></defs><rect width="4" height="6" fill="url(#paint)"/></svg>`;
  const source=`<svg width="8" height="6">${nested(0,'#ff0000')}${nested(4,'#0000ff')}</svg>`,normalized=normalizeSvg(source,{scope:'clone-a'});
  assert.ok(normalized.warnings.some(warning=>warning.includes('Duplicate SVG ID paint')));
  const allIds=elements(normalized.svg).map(element=>element.attrs['@_id']).filter(Boolean);assert.equal(new Set(allIds).size,allIds.length);
  const raw=await decodeRGBA(Buffer.from(normalized.svg),'image/svg+xml');assert.deepEqual(rgba(raw,1,2),[255,0,0,255]);assert.deepEqual(rgba(raw,6,2),[0,0,255,255]);
  const second=normalizeSvg(source,{scope:'clone-b'});const secondIds=elements(second.svg).map(element=>element.attrs['@_id']).filter(Boolean);assert.ok(secondIds.every(id=>!allIds.includes(id)));
  assert.deepEqual(second.drawingNodes.map(node=>node.id),normalized.drawingNodes.map(node=>node.id));
});
test('root ID selectors, internal labels, CSS URLs and class selectors survive namespacing without leaking',async()=>{
  const source='<svg id="logo" width="8" height="6" aria-labelledby="logo"><style>#logo > path{fill:#ee2222} path{stroke:none} :root{color:#000000}</style><path id="primary" d="M0 0H8V6H0Z"/></svg>';
  const result=normalizeSvg(source,{scope:'logo-a'});assert.match(result.svg,/aria-labelledby="logo-a"/);assert.match(result.svg,/#logo-a>path\[data-i2-svg-scope="logo-a"\]/);assert.match(result.svg,/id="logo-a__primary"/);assert.equal(result.drawingNodes[0].id,'primary');
  const raw=await decodeRGBA(Buffer.from(result.svg),'image/svg+xml');assert.deepEqual(rgba(raw,3,3),[238,34,34,255]);
  const overridden=normalizeSvg(source,{scope:'logo-a',styles:{primary:{fill:'#00ff00'}}});assert.deepEqual(rgba(await decodeRGBA(Buffer.from(overridden.svg),'image/svg+xml'),3,3),[0,255,0,255]);
});
test('root attribute and inline opacity composite once without losing direct-child CSS paints',async()=>{
  for(const opacity of ['opacity="0.5"','style="opacity:0.5"']){
    const source=`<svg id="logo" width="8" height="6" ${opacity}><style>#logo > path{fill:#ee2222}</style>${fullPath}</svg>`,normalized=normalizeSvg(source,{scope:'opacity-logo'});
    const raw=await decodeRGBA(Buffer.from(normalized.svg),'image/svg+xml');assert.deepEqual(rgba(raw,3,3),[237,34,34,128]);assert.doesNotMatch(normalized.svg,/i2_root_opacity/);
  }
});
test('embedded safe bitmap data renders but active elements, encoded URLs and external CSS are rejected',async()=>{
  const bytes=await encodePNG({width:2,height:2,data:Buffer.from(Array.from({length:4},()=>[20,40,60,255]).flat())});
  const source=`<svg width="2" height="2"><image width="2" height="2" href="data:image/png;base64,${bytes.toString('base64')}"/></svg>`;
  const normalized=normalizeSvg(source);assert.equal(normalized.drawingNodes[0].tag,'image');assert.deepEqual(rgba(await decodeRGBA(Buffer.from(normalized.svg),'image/svg+xml'),1,1),[20,40,60,255]);
  for(const body of ['<script/>','<foreignObject/>','<FoReIgNoBjEcT/>','<path onload="alert(1)"/>','<use href="jav&#97;script:alert(1)"/>','<image href="data:image/svg+xml;base64,PHN2Zy8+"/>','<style>@import url(https://example.invalid/x.css);</style>','<path fill="url(https://example.invalid/image.svg)"/>'])assert.throws(()=>normalizeSvg(`<svg width="8" height="6">${body}</svg>`),e=>e.code==='SVG_UNSAFE');
  assert.throws(()=>normalizeSvg('<!DOCTYPE svg [<!ENTITY x "hello">]><svg width="8" height="6"/>'),e=>e.code==='SVG_UNSAFE');
  assert.throws(()=>normalizeSvg(`<svg width="8" height="6">${fullPath}</svg>`,{styles:{'*':{fill:'url(#other)'}}}),e=>e.code==='SVG_PAINT');
});
test('compiled embedded bitmap data URI folds only ASCII Base64 whitespace and still exports the same PNG pixels',async()=>{
  const data=Buffer.from(Array.from({length:12*8},()=>[52,119,162,255]).flat()),image=await encodePNG({width:12,height:8,data});
  const folded=` \t${image.toString('base64').slice(0,24)}\n${image.toString('base64').slice(24)}\r `,source=`<svg width="24" height="16"><image width="24" height="16" href="data:image/png;base64,${folded}"/></svg>`,normalized=normalizeSvg(source);
  assert.match(normalized.svg,new RegExp(`href="data:image/png;base64,${image.toString('base64').replace(/[+]/g,'\\+')}"`));
  const bytes=Buffer.from(source),asset={asset:{id:'embedded',mime:'image/svg+xml',width:24,height:16},bytes},doc={id:'compiled-image',width:24,height:16,layers:[{id:'embedded',type:'vector',assetId:'embedded',width:24,height:16,x:0,y:0,opacity:1,visible:true,z:0}]};
  const png=await decodeRGBA(await documentPng(doc,async()=>asset),'image/png');assert.deepEqual(rgba(png,12,8),[52,119,162,255]);assert.deepEqual(asset.bytes,bytes);
  for(const href of ['data:image/svg+xml;base64, PHN2Zy8+','data:image/png;base64, iVB\u00a0OR','data:font/woff2;base64, AAAA','https://outside.example.invalid/image.png'])assert.throws(()=>normalizeSvg(`<svg width="2" height="2"><image href="${href}"/></svg>`),e=>e.code==='SVG_UNSAFE');
});
test('normalizer has no Node or DOM dependency and no renderer-specific import',async()=>{
  const source=await readFile(new URL('../svg-normalize.mjs',import.meta.url),'utf8');assert.doesNotMatch(source,/from\s+['"](?:node:|sharp|@resvg|fontkit)/);assert.doesNotMatch(source,/\b(?:DOMParser|document\.createElement|Buffer\.)/);
});
test('CSS escapes and custom properties cannot bypass embedded-resource validation',async()=>{
  for(const body of ['<style>@\\69mport "https://example.invalid/x.css";</style>','<style>path{--paint:url(https://example.invalid/x.svg);fill:var(--paint)}</style>','<style>path{fill:u\\72l("https://example.invalid/x.svg")}</style>','<path fill="u\\72l(&quot;https://example.invalid/x.svg&quot;)"/>'])assert.throws(()=>normalizeSvg(`<svg width="8" height="6">${body}</svg>`),e=>['SVG_UNSAFE','SVG_CSS'].includes(e.code));
  const local=normalizeSvg('<svg width="8" height="6"><defs><linearGradient id="paint"><stop offset="0" stop-color="#ff0000"/></linearGradient></defs><path d="M0 0H8V6H0Z" fill="u\\72l(&quot;#paint&quot;)"/></svg>',{scope:'local'});assert.match(local.svg,/fill="url\(#local__paint\)"/);
  const escapedRoot=normalizeSvg(`<svg id="logo" width="8" height="6"><style>#lo\\67o > path{fill:#ee2222}</style>${fullPath}</svg>`,{scope:'escaped'});assert.deepEqual(rgba(await decodeRGBA(Buffer.from(escapedRoot.svg),'image/svg+xml'),3,3),[238,34,34,255]);
});
test('server inspection and scaled SVG/PNG/PDF exports share source viewport and leave clip/mask resources white',async()=>{
  const source=masked.replace('width="8" height="6"','width="8px" height="6px"'),bytes=Buffer.from(source),info=await inspectAsset(bytes,'image/svg+xml');assert.deepEqual(info.metadata.sourceViewBox,[0,0,8,6]);assert.equal(info.metadata.svgNormalizationVersion,1);
  const asset={asset:{id:'logo',mime:'image/svg+xml',width:8,height:6},bytes},load=async()=>asset;
  const doc={id:'shared-svg',name:'shared-svg',width:24,height:18,updatedAt:'2026-10-13T00:00:00Z',layers:[{id:'logo',type:'vector',assetId:'logo',x:0,y:0,width:24,height:18,opacity:1,visible:true,rotation:0,z:0,metadata:{pathStyles:{'path-1':{fill:'#00ff00'}}}}]};
  const png=await decodeRGBA(await documentPng(doc,load),'image/png');assert.deepEqual(rgba(png,4,8),[0,255,0,255]);assert.equal(rgba(png,20,8)[3],0);
  const svg=(await documentSvg(doc,load)).svg;assert.match(svg,/scale\(3 3\)/);assert.match(svg,/viewBox="0 0 8 6"/);assert.doesNotMatch(svg,/data:image/);
  const pdf=await documentPdf(doc,load);assert.equal(pdf.subarray(0,5).toString(),'%PDF-');assert.deepEqual(asset.bytes,bytes);
});
test('stylesheet root opacity and its original cascade render once in PNG, including shared child classes',async()=>{
  const variants=[
    '<svg width="8" height="6" class="logo"><style>.logo{opacity:.5}</style><path d="M0 0H8V6H0Z"/></svg>',
    '<svg width="8" height="6" class="logo"><style>.logo{opacity:.5}</style><path class="logo" d="M0 0H8V6H0Z"/></svg>',
    '<svg width="8" height="6" id="logo" class="logo" opacity=".2"><style>svg{opacity:.3}.logo{opacity:.5}#logo{opacity:.7}.logo{opacity:.6!important}</style><path d="M0 0H8V6H0Z"/></svg>',
    '<svg width="8" height="6" id="logo" class="logo" style="opacity:.75!important"><style>#logo{opacity:.4!important}#logo > path{fill:red}</style><path d="M0 0H8V6H0Z"/></svg>',
  ];
  for(const source of variants){
    const bytes=Buffer.from(source),asset={asset:{id:'logo',mime:'image/svg+xml',width:8,height:6},bytes},doc={id:'op',width:8,height:6,layers:[{id:'logo',type:'vector',assetId:'logo',width:8,height:6,x:0,y:0,rotation:0,opacity:1,visible:true,z:0}]};
    const before=await decodeRGBA(bytes,'image/svg+xml'),png=await decodeRGBA(await documentPng(doc,async()=>asset),'image/png');assert.deepEqual(png.data,before.data,source);assert.deepEqual(asset.bytes,bytes);
  }
});
test('attribute selector identity and exact classes survive normalization and every rendering scope',async()=>{
  const source='<svg width="8" height="6"><style>path[id="a:b"][class="logo"]{fill:#ee2222}path[id^="a:"]{stroke:none}use[href="#a:b"]{opacity:.5}</style><defs><path id="a:b" class="logo" d="M0 0H4V6H0Z"/></defs><use href="#a:b"/><use href="#a:b" x="4"/></svg>';
  const baseline=await decodeRGBA(Buffer.from(source),'image/svg+xml');let normalized=normalizeSvg(source);
  const ids=normalized.drawingNodes.map(node=>node.id),aliases={...normalized.legacyAliases};
  for(const scope of [undefined,'canvas','export',undefined]){
    normalized=normalizeSvg(normalized.svg,scope?{scope}:{});const decoded=await decodeRGBA(Buffer.from(normalized.svg),'image/svg+xml');assert.deepEqual(decoded.data,baseline.data);assert.deepEqual(normalized.drawingNodes.map(node=>node.id),ids);assert.deepEqual({...normalized.legacyAliases},aliases);
    assert.equal(elements(normalized.svg).find(node=>node.tag==='path').attrs['@_class'],'logo');
  }
});
test('numeric drawing IDs remain canonical while serialized rendering selectors always use legal IDs',async()=>{
  const source='<svg width="8" height="6"><style>#\\31 23{fill:#ee2222}</style><path id="123" d="M0 0H8V6H0Z"/></svg>';let normalized=normalizeSvg(source);const aliases={...normalized.legacyAliases};
  for(const scope of [undefined,'canvas','export',undefined]){normalized=normalizeSvg(normalized.svg,scope?{scope}:{});assert.equal(normalized.drawingNodes[0].id,'123');assert.equal(normalized.drawingNodes[0].originalId,'123');assert.deepEqual({...normalized.legacyAliases},aliases);assert.doesNotMatch(normalized.svg,/#123\b/);assert.deepEqual(rgba(await decodeRGBA(Buffer.from(normalized.svg),'image/svg+xml'),3,3),[238,34,34,255]);}
});
test('normalization is byte-idempotent and rescoping preserves mask, root selectors and reference identities',async()=>{
  const source=masked.replace('<g clip-path=', '<style>:root{color:black} path[id^="missing"]{fill:red}</style><g clip-path=');let result=normalizeSvg(source,{scope:'canvas'});
  assert.equal(normalizeSvg(result.svg).svg,result.svg);const drawing=result.drawingNodes,aliases={...result.legacyAliases},before=await decodeRGBA(Buffer.from(result.svg),'image/svg+xml');
  for(const scope of ['export','canvas','export']){result=normalizeSvg(result.svg,{scope});assert.deepEqual(result.drawingNodes,drawing);assert.deepEqual({...result.legacyAliases},aliases);assert.deepEqual((await decodeRGBA(Buffer.from(result.svg),'image/svg+xml')).data,before.data);assert.equal(normalizeSvg(result.svg).svg,result.svg);}
});
test('native viewport percentage coordinates, gradients, clipping and physical units retain PNG display geometry',async()=>{
  const source='<svg width="1in" height="48px" viewBox="-10 -20 40 20"><defs><linearGradient id="paint" gradientUnits="userSpaceOnUse" x1="0%" x2="100%"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient><clipPath id="clip"><rect x="-10" y="-20" width="50%" height="100%"/></clipPath></defs><rect x="-10" y="-20" width="100%" height="100%" fill="url(#paint)" clip-path="url(#clip)"/></svg>',bytes=Buffer.from(source);
  const asset={asset:{id:'logo',mime:'image/svg+xml',width:96,height:48},bytes},doc={id:'vp',width:192,height:96,layers:[{id:'logo',type:'vector',assetId:'logo',width:192,height:96,x:0,y:0,opacity:1,visible:true,z:0}]};
  const png=await decodeRGBA(await documentPng(doc,async()=>asset),'image/png');assert.equal(rgba(png,130,40)[3],0);assert.equal(rgba(png,30,40)[3],255);assert.ok(rgba(png,30,40)[0]>rgba(png,30,40)[2]);assert.deepEqual(asset.bytes,bytes);
});
test('xml:base and explicitly visible viewport overflow are rejected at every relevant nesting level',()=>{
  for(const source of ['<svg width="8" height="6" xml:base="https://outside.example.invalid/"/>','<svg width="8" height="6"><g xml:base="https://outside.example.invalid/"/></svg>','<svg width="8" height="6" xmlns:z="http://www.w3.org/XML/1998/namespace"><g z:base="https://outside.example.invalid/"/></svg>'])assert.throws(()=>normalizeSvg(source),e=>e.code==='SVG_UNSAFE');
  for(const source of ['<svg width="8" height="6" overflow="visible"><circle cx="0" cy="3" r="2"/></svg>','<svg width="8" height="6"><svg width="4" height="2" overflow="visible"/></svg>','<svg width="8" height="6"><style>svg{overflow:visible}</style></svg>'])assert.throws(()=>normalizeSvg(source),e=>e.code==='SVG_OVERFLOW_UNSUPPORTED'&&e.status===422);
});
test('source root placement and percentage CSS sizing never depend on the exported parent viewport',async()=>{
  const source='<svg x="50" y="40" width="8" height="6" viewBox="0 0 8 6" style="width:50%;height:50%"><style>svg[x="50"] > path{fill:red}</style><path d="M0 0H8V6H0Z"/></svg>',bytes=Buffer.from(source),asset={asset:{id:'logo',mime:'image/svg+xml',width:8,height:6},bytes};
  const normalized=normalizeSvg(source);assert.doesNotMatch(normalized.svg,/<svg[^>]+\s[xy]="/);assert.match(normalized.svg,/width:8px !important/);assert.match(normalized.svg,/height:6px !important/);assert.equal(normalizeSvg(normalized.svg).svg,normalized.svg);
  const doc={id:'placement',width:32,height:20,layers:[{id:'logo',type:'vector',assetId:'logo',x:2,y:3,width:8,height:6,opacity:1,visible:true,z:0}]},get=async()=>asset;
  const png=await decodeRGBA(await documentPng(doc,get),'image/png'),svg=await decodeRGBA(Buffer.from((await documentSvg(doc,get)).svg),'image/svg+xml');assert.deepEqual(rgba(png,5,5),[255,0,0,255]);assert.deepEqual(svg.data,png.data);assert.deepEqual(asset.bytes,bytes);
});
