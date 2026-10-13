'use client';

import {useState} from 'react';
import type {CSSProperties} from 'react';
import type {ContentDescriptor,DocumentCommand,ImageAsset,ImageDocument,ImageLayer,LayerMask,Matrix2D} from '../../lib/image2/types';
import {inverse,multiply} from '../../services/image2/core/matrix.mjs';
import {parseLiteralColor} from '../../services/image2/core/paints.mjs';

type Selection=NonNullable<ImageDocument['savedSelections']>[number];
type Artboard=NonNullable<ImageDocument['artboards']>[number];
type Guide=NonNullable<ImageDocument['guides']>[number];
export interface ProfessionalPropertiesBridge {
  submitCommands(commands:DocumentCommand[]):Promise<unknown>;
  uploadFile(file:Blob,name:string,role?:string):Promise<ImageAsset>;
  rawDocument?:ImageDocument|null;
}
export interface ProfessionalPropertiesProps {
  document:ImageDocument;
  selected?:ImageLayer;
  busy:boolean;
  bridge:ProfessionalPropertiesBridge;
  onError:(message:string)=>void;
  onShowSelection?:(selectionId:string)=>void;
  onShowArtboard?:(artboardId:string)=>void;
}
const grid:CSSProperties={display:'grid',gridTemplateColumns:'repeat(2,minmax(0,1fr))',gap:8};
const section:CSSProperties={borderTop:'1px solid #e8e8ec',padding:'10px 0'};
const BLENDS=[['normal','正常'],['multiply','正片叠底'],['screen','滤色'],['overlay','叠加'],['darken','变暗'],['lighten','变亮'],['difference','差值'],['exclusion','排除']];
const finite=(value:string)=>{if(value.trim()===''||!Number.isFinite(Number(value)))throw Error('请输入有效数字');return Number(value);};

/** All geometry here reads raw v3 matrices, never projected x/y/rotation. */
export function professionalWorldMatrix(document:ImageDocument,layerId:string):Matrix2D {
  const byId=new Map(document.layers.map(layer=>[layer.id,layer]));
  const visit=(id:string,seen=new Set<string>()):Matrix2D=>{
    const layer=byId.get(id);if(!layer?.matrix||seen.has(id))throw Error('图层矩阵或父组不可读取');
    const next=new Set([...seen,id]);return layer.parentId?multiply(visit(layer.parentId,next),layer.matrix):[...layer.matrix];
  };
  return visit(layerId);
}
export function professionalMaskWorld(document:ImageDocument,layer:ImageLayer,mask:LayerMask):Matrix2D {
  return mask.coordinateSpace==='document'?[...mask.matrix]:multiply(professionalWorldMatrix(document,layer.id),mask.matrix);
}
export function convertProfessionalMask(document:ImageDocument,layer:ImageLayer,mask:LayerMask,space:'layerLocal'|'document',linked=mask.linked):LayerMask {
  const world=professionalMaskWorld(document,layer,mask);
  return {...mask,coordinateSpace:space,linked,matrix:space==='document'?world:multiply(inverse(professionalWorldMatrix(document,layer.id)),world)};
}
export function professionalSelectionFromMask(document:ImageDocument,layer:ImageLayer,mask:LayerMask,id:string):Selection {
  return {id,name:`${layer.name} · 蒙版选区`,contentId:mask.contentId,matrix:professionalMaskWorld(document,layer,mask),channel:mask.channel,inverted:mask.inverted,density:mask.density,featherPx:mask.featherPx};
}
export function professionalMaskFromSelection(document:ImageDocument,selection:Selection,id:string):LayerMask {
  const content=document.contentAssets?.find(c=>c.id===selection.contentId);
  if(!content||!['raster','svg','vector'].includes(content.kind))throw Error('选区素材尚不可用');
  return {id,kind:content.kind==='raster'?'raster':'vector',contentId:selection.contentId,matrix:[...selection.matrix],coordinateSpace:'document',linked:false,enabled:true,channel:selection.channel,inverted:selection.inverted,density:selection.density,featherPx:selection.featherPx};
}
export function professionalMaskFit(layer:ImageLayer,asset:ImageAsset):Matrix2D {
  const b=layer.localBounds;if(!b||b.width<=0||b.height<=0)throw Error('请先设置图层的有效尺寸');
  const v=asset.metadata?.sourceViewBox;
  const source=Array.isArray(v)&&v.length===4&&v.every(n=>typeof n==='number'&&Number.isFinite(n))?v as number[]:[0,0,asset.width||0,asset.height||0];
  if(source[2]<=0||source[3]<=0)throw Error('蒙版真实尺寸尚不可读取');
  const sx=b.width/source[2],sy=b.height/source[3];return [sx,0,0,sy,b.x-source[0]*sx,b.y-source[1]*sy];
}
function inheritedLock(document:ImageDocument,layer?:ImageLayer){const seen=new Set<string>();while(layer){if(layer.locked||seen.has(layer.id))return true;seen.add(layer.id);layer=document.layers.find(l=>l.id===layer?.parentId);}return false;}

function NumberCommit({label,value,disabled,min,max,onCommit}:{label:string;value:number;disabled:boolean;min?:number;max?:number;onCommit:(value:number)=>void}) {
  return <label>{label}<input key={value} aria-label={label} type="number" step="any" defaultValue={value} disabled={disabled} min={min} max={max} onBlur={event=>{const n=Number(event.target.value);if(event.target.value.trim()===''||!Number.isFinite(n)||(min!==undefined&&n<min)||(max!==undefined&&n>max)){event.target.value=String(value);return;}if(n!==value)onCommit(n);}}/></label>;
}
function MatrixEditor({label,matrix,disabled,onApply,onError}:{label:string;matrix:Matrix2D;disabled:boolean;onApply:(matrix:Matrix2D)=>void;onError:(message:string)=>void}) {
  const [values,setValues]=useState(matrix.map(String));
  return <form onSubmit={event=>{event.preventDefault();try{const next=values.map(finite);if(next.some(n=>Math.abs(n)>1e10))throw Error('矩阵数值超过支持范围');onApply(next as Matrix2D);}catch(error){onError((error as Error).message);}}}>
    <div style={{...grid,gridTemplateColumns:'repeat(3,minmax(0,1fr))'}}>{['a · 横向缩放','b · 纵向剪切','c · 横向剪切','d · 纵向缩放','e · 横向位移','f · 纵向位移'].map((name,index)=><label key={index}>{name}<input aria-label={`${label} ${name.split(' · ')[0]}`} type="number" step="any" disabled={disabled} value={values[index]} onChange={event=>setValues(current=>current.map((v,i)=>i===index?event.target.value:v))}/></label>)}</div>
    <button className="ghostButton" type="submit" disabled={disabled}>应用{label}</button>
  </form>;
}

function BoardForm({board,disabled,onApply,onError}:{board:Artboard;disabled:boolean;onApply:(board:Artboard)=>void;onError:(message:string)=>void}) {
  const [name,setName]=useState(board.name),[coords,setCoords]=useState([board.bounds.x,board.bounds.y,board.bounds.width,board.bounds.height].map(String)),[background,setBackground]=useState(board.background||'');
  return <form onSubmit={event=>{event.preventDefault();try{const [x,y,width,height]=coords.map(finite);if(width<=0||height<=0||!name.trim())throw Error('画板名和尺寸必须有效');if(background.trim()&&!parseLiteralColor(background))throw Error('画板背景请使用实际颜色值');const next={...board,name,bounds:{x,y,width,height}};if(background.trim())next.background=background.trim();else delete next.background;onApply(next);}catch(error){onError((error as Error).message);}}}>
    <label>画板名<input aria-label={`画板名 ${board.id}`} value={name} disabled={disabled} onChange={event=>setName(event.target.value)}/></label><div style={grid}>{['横向位置','纵向位置','宽度','高度'].map((label,index)=><label key={label}>{label}<input aria-label={`画板${label} ${board.id}`} type="number" step="any" value={coords[index]} disabled={disabled} onChange={event=>setCoords(current=>current.map((v,i)=>i===index?event.target.value:v))}/></label>)}</div><label>参考纸底颜色（不会导出）<input aria-label={`画板背景 ${board.id}`} value={background} disabled={disabled} onChange={event=>setBackground(event.target.value)}/></label><button className="ghostButton" type="submit" disabled={disabled}>保存画板</button>
  </form>;
}

/** Folded properties inside the existing layers dialog; every action is a non-AI command. */
export function ProfessionalProperties({document,selected,busy,bridge,onError,onShowSelection,onShowArtboard}:ProfessionalPropertiesProps) {
  const [working,setWorking]=useState(false),[shearX,setShearX]=useState('0'),[shearY,setShearY]=useState('0');
  const doc=bridge.rawDocument||document,layer=doc.layers.find(l=>l.id===selected?.id),disabled=busy||working,layerDisabled=disabled||inheritedLock(doc,layer);
  const act=async(fn:()=>Promise<unknown>)=>{if(disabled)return;setWorking(true);try{await fn();}catch(error){onError((error as Error).message);}finally{setWorking(false);}};
  const commands=(value:DocumentCommand[])=>void act(()=>bridge.submitCommands(value));
  const patch=(value:Partial<ImageLayer>)=>layer&&commands([{type:'layer.update',layerId:layer.id,patch:value}]);
  const maskPatch=(mask:LayerMask,value:Partial<LayerMask>)=>layer&&commands([{type:'mask.upsert',layerId:layer.id,mask:{...mask,...value}}]);
  const selectionPatch=(selection:Selection,value:Partial<Selection>)=>commands([{type:'selection.upsert',selection:{...selection,...value}}]);
  const guidePatch=(guide:Guide,value:Partial<Guide>)=>commands([{type:'guide.upsert',guide:{...guide,...value}}]);
  if(doc.schemaVersion!==3)return <p>完整矩阵、独立蒙版、画板和选区在工程升级后可用。</p>;
  const clipCandidates=layer?doc.layers.filter(l=>l.id!==layer.id&&l.parentId===layer.parentId&&l.z<layer.z&&!['mask','adjustment'].includes(l.type)):[];
  const passAvailable=layer?.opacity===1&&(layer.blendMode||'normal')==='normal'&&!layer.masks?.some(m=>m.enabled)&&!layer.effects?.some(e=>e.enabled);
  return <div aria-label="专业设计属性">
    {layer?.matrix&&<details style={section}><summary>矩阵、剪切与混合</summary>
      <p>矩阵以父组为坐标基准，支持非等比缩放、旋转和剪切。</p>
      <MatrixEditor key={`${layer.id}:${layer.matrix.join(',')}`} label="图层矩阵" matrix={layer.matrix} disabled={layerDisabled} onApply={matrix=>patch({matrix})} onError={onError}/>
      <div style={grid}><label>水平剪切角度<input aria-label="水平剪切角度" type="number" value={shearX} disabled={layerDisabled} onChange={event=>setShearX(event.target.value)}/></label><label>垂直剪切角度<input aria-label="垂直剪切角度" type="number" value={shearY} disabled={layerDisabled} onChange={event=>setShearY(event.target.value)}/></label></div>
      <button className="ghostButton" disabled={layerDisabled} onClick={()=>{try{const x=finite(shearX),y=finite(shearY);if(Math.abs(x)>=89||Math.abs(y)>=89)throw Error('剪切角度需在 -89° 与 89° 之间');patch({matrix:multiply(layer.matrix!,[1,Math.tan(y*Math.PI/180),Math.tan(x*Math.PI/180),1,0,0])});}catch(error){onError((error as Error).message);}}}>应用局部剪切</button>
      <label>混合模式<select aria-label="专业混合模式" value={layer.blendMode||'normal'} disabled={layerDisabled} onChange={event=>patch({blendMode:event.target.value})}>{BLENDS.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
      {layer.type==='group'&&<><label>组的合成方式<select aria-label="组合成方式" value={layer.compositeMode||'isolated'} disabled={layerDisabled} onChange={event=>patch({compositeMode:event.target.value as 'isolated'|'passthrough'})}><option value="isolated">隔离合成</option><option value="passthrough" disabled={!passAvailable}>穿透到下方图层</option></select></label>{!passAvailable&&<p>穿透组需要正常混合、完全不透明，并关闭组蒙版和效果。</p>}</>}
      <label>剪贴到下方图层<select aria-label="剪贴基底" value={layer.clipToLayerId||''} disabled={layerDisabled} onChange={event=>patch({clipToLayerId:(event.target.value||null) as unknown as string})}><option value="">无剪贴</option>{clipCandidates.map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
      {layerDisabled&&!disabled&&<p>图层或父组已锁定，先解锁再修改。</p>}
    </details>}
    {layer&&<details style={section}><summary>图层蒙版（{layer.masks?.length||0}）</summary>
      <label>上传 PNG / 路径 SVG 蒙版<input aria-label="上传专业蒙版" type="file" accept="image/png,.png,image/svg+xml,.svg" disabled={layerDisabled} onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)void act(async()=>{
        const isSvg=file.type==='image/svg+xml'||/\.svg$/i.test(file.name),blob=isSvg?new Blob([file],{type:'image/svg+xml'}):file,asset=await bridge.uploadFile(blob,file.name,'layer_mask');
        if(!['image/png','image/svg+xml'].includes(asset.mime))throw Error('蒙版请使用 PNG 或路径 SVG');if(asset.metadata?.requiresFont)throw Error('SVG 文字蒙版需先转换为路径');
        const content:ContentDescriptor={id:crypto.randomUUID(),kind:asset.mime==='image/svg+xml'?'svg':'raster',assetId:asset.id,formatVersion:1};const mask:LayerMask={id:crypto.randomUUID(),kind:content.kind==='raster'?'raster':'vector',contentId:content.id,matrix:professionalMaskFit(layer,asset),coordinateSpace:'layerLocal',linked:true,enabled:true,inverted:false,density:1,featherPx:0,channel:content.kind==='raster'?'luminance':'alpha'};
        await bridge.submitCommands([{type:'content.add',content},{type:'mask.upsert',layerId:layer.id,mask}]);
      });}}/></label>
      <p>PNG 可按灰度或透明度遮罩；SVG 保留路径。上传后适配原图层范围，可再独立调整矩阵。</p>
      {(layer.masks||[]).map((mask,index)=><div key={mask.id} style={section}>
        <strong>蒙版 {index+1}</strong><div className="inlineOptions"><label><input aria-label={`显示蒙版 ${mask.id}`} type="checkbox" checked={mask.enabled} disabled={layerDisabled} onChange={event=>maskPatch(mask,{enabled:event.target.checked})}/>启用</label><label><input aria-label={`链接蒙版 ${mask.id}`} type="checkbox" checked={mask.linked} disabled={layerDisabled} onChange={event=>maskPatch(mask,{linked:event.target.checked})}/>随图层移动</label><label><input aria-label={`反相蒙版 ${mask.id}`} type="checkbox" checked={mask.inverted} disabled={layerDisabled} onChange={event=>maskPatch(mask,{inverted:event.target.checked})}/>反相</label></div>
        <div style={grid}><label>遮罩通道<select aria-label={`蒙版通道 ${mask.id}`} disabled={layerDisabled} value={mask.channel} onChange={event=>maskPatch(mask,{channel:event.target.value as 'alpha'|'luminance'})}><option value="alpha">透明度</option><option value="luminance">亮度</option></select></label><label>坐标基准<select aria-label={`蒙版坐标 ${mask.id}`} disabled={layerDisabled} value={mask.coordinateSpace} onChange={event=>{try{maskPatch(mask,convertProfessionalMask(doc,layer,mask,event.target.value as 'layerLocal'|'document'));}catch(error){onError((error as Error).message);}}}><option value="layerLocal">图层局部</option><option value="document">工程坐标</option></select></label><NumberCommit label={`蒙版密度 ${mask.id}`} value={mask.density} min={0} max={1} disabled={layerDisabled} onCommit={density=>maskPatch(mask,{density})}/><NumberCommit label={`蒙版羽化 ${mask.id}`} value={mask.featherPx} min={0} max={256} disabled={layerDisabled} onCommit={featherPx=>maskPatch(mask,{featherPx})}/></div>
        <MatrixEditor key={`${mask.id}:${mask.matrix.join(',')}`} label={`蒙版矩阵 ${index+1}`} matrix={mask.matrix} disabled={layerDisabled} onApply={matrix=>maskPatch(mask,{matrix})} onError={onError}/>
        <div className="inlineOptions"><button disabled={disabled} onClick={()=>commands([{type:'selection.upsert',selection:professionalSelectionFromMask(doc,layer,mask,crypto.randomUUID())}])}>保存为选区</button><button disabled={layerDisabled||index===0} onClick={()=>{const ids=layer.masks!.map(m=>m.id);[ids[index-1],ids[index]]=[ids[index],ids[index-1]];commands([{type:'mask.reorder',layerId:layer.id,maskIds:ids}]);}}>上移</button><button disabled={layerDisabled||index===(layer.masks?.length||0)-1} onClick={()=>{const ids=layer.masks!.map(m=>m.id);[ids[index],ids[index+1]]=[ids[index+1],ids[index]];commands([{type:'mask.reorder',layerId:layer.id,maskIds:ids}]);}}>下移</button><button disabled={layerDisabled} onClick={()=>commands([{type:'mask.remove',layerId:layer.id,maskId:mask.id}])}>移除蒙版</button></div>
      </div>)}
    </details>}
    <details style={section}><summary>保存的选区（{doc.savedSelections?.length||0}）</summary>
      {!doc.savedSelections?.length&&<p>可将图层蒙版保存为工程选区，再应用到其他图层。</p>}
      {(doc.savedSelections||[]).map(selection=><div key={selection.id} style={section}>
        <label>选区名<input key={selection.name} aria-label={`选区名 ${selection.id}`} defaultValue={selection.name} disabled={disabled} onBlur={event=>{if(event.target.value.trim()&&event.target.value!==selection.name)selectionPatch(selection,{name:event.target.value});}}/></label>
        <MatrixEditor key={`${selection.id}:${selection.matrix.join(',')}`} label={`选区矩阵 ${selection.id}`} matrix={selection.matrix} disabled={disabled} onApply={matrix=>selectionPatch(selection,{matrix})} onError={onError}/>
        <label>选区通道<select aria-label={`选区通道 ${selection.id}`} value={selection.channel} disabled={disabled} onChange={event=>selectionPatch(selection,{channel:event.target.value as 'alpha'|'luminance'})}><option value="alpha">透明度</option><option value="luminance">亮度</option></select></label>
        <div style={grid}><NumberCommit label={`选区密度 ${selection.id}`} value={selection.density} min={0} max={1} disabled={disabled} onCommit={density=>selectionPatch(selection,{density})}/><NumberCommit label={`选区羽化 ${selection.id}`} value={selection.featherPx} min={0} max={256} disabled={disabled} onCommit={featherPx=>selectionPatch(selection,{featherPx})}/></div>
        <label><input aria-label={`反相选区 ${selection.id}`} type="checkbox" checked={selection.inverted} disabled={disabled} onChange={event=>selectionPatch(selection,{inverted:event.target.checked})}/>反相选区</label>
        <div className="inlineOptions">{onShowSelection&&<button disabled={disabled} onClick={()=>onShowSelection(selection.id)}>查看选区</button>}<button disabled={layerDisabled||!layer} onClick={()=>{if(layer)try{commands([{type:'mask.upsert',layerId:layer.id,mask:professionalMaskFromSelection(doc,selection,crypto.randomUUID())}]);}catch(error){onError((error as Error).message);}}}>应用到所选图层</button><button disabled={disabled} onClick={()=>commands([{type:'selection.remove',selectionId:selection.id}])}>删除选区</button></div>
      </div>)}
    </details>
    <details style={section}><summary>画板与 DPI</summary>
      <div style={grid}><NumberCommit label="工程横向 DPI" value={doc.resolution?.dpiX||300} min={1} max={9600} disabled={disabled} onCommit={dpiX=>commands([{type:'document.update',patch:{resolution:{...(doc.resolution||{dpiX:300,dpiY:300,unit:'px'}),dpiX}}}])}/><NumberCommit label="工程纵向 DPI" value={doc.resolution?.dpiY||300} min={1} max={9600} disabled={disabled} onCommit={dpiY=>commands([{type:'document.update',patch:{resolution:{...(doc.resolution||{dpiX:300,dpiY:300,unit:'px'}),dpiY}}}])}/></div>
      <label>工程单位（记录）<select aria-label="工程尺寸单位" value={doc.resolution?.unit||'px'} disabled={disabled} onChange={event=>commands([{type:'document.update',patch:{resolution:{...(doc.resolution||{dpiX:300,dpiY:300,unit:'px'}),unit:event.target.value as 'px'|'mm'|'in'}}}])}><option value="px">像素</option><option value="mm">毫米</option><option value="in">英寸</option></select></label><p>DPI 与显示单位不会自动重采样像素。当前色彩基准为 8 位 sRGB。图层和画板的几何值仍以像素输入。画板边界、参考纸底和参考线只用于工作区，不进入作品像素；透明背景由实际图层决定。</p>
      <button disabled={disabled} className="ghostButton" onClick={()=>commands([{type:'artboard.upsert',artboard:{id:crypto.randomUUID(),name:`画板 ${(doc.artboards?.length||0)+1}`,bounds:{x:0,y:0,width:doc.width,height:doc.height},visible:true}}])}>添加画板</button>
      {(doc.artboards||[]).map(board=><div key={board.id} style={section}>
        <BoardForm key={JSON.stringify(board)} board={board} disabled={disabled} onApply={artboard=>commands([{type:'artboard.upsert',artboard}])} onError={onError}/>
        <div className="inlineOptions"><button disabled={disabled} onClick={()=>commands([{type:'artboard.upsert',artboard:{...board,visible:!board.visible}}])}>{board.visible?'隐藏画板':'显示画板'}</button>{onShowArtboard&&<button disabled={disabled} onClick={()=>onShowArtboard(board.id)}>查看画板</button>}<button disabled={disabled||doc.guides?.some(g=>g.artboardId===board.id&&g.locked)} onClick={()=>commands([...(doc.guides||[]).filter(g=>g.artboardId===board.id).map(g=>({type:'guide.remove' as const,guideId:g.id})),{type:'artboard.remove',artboardId:board.id}])}>删除画板</button></div>
        {doc.guides?.some(g=>g.artboardId===board.id&&g.locked)&&<p>删除前先解锁此画板的参考线。</p>}
      </div>)}
    </details>
    <details style={section}><summary>参考线（{doc.guides?.length||0}）</summary>
      <div className="inlineOptions"><button disabled={disabled} onClick={()=>commands([{type:'guide.upsert',guide:{id:crypto.randomUUID(),axis:'x',position:doc.width/2,visible:true,locked:false}}])}>添加竖参考线</button><button disabled={disabled} onClick={()=>commands([{type:'guide.upsert',guide:{id:crypto.randomUUID(),axis:'y',position:doc.height/2,visible:true,locked:false}}])}>添加横参考线</button></div>
      {(doc.guides||[]).map(guide=><div key={guide.id} style={section}>
        <div style={grid}><label>方向<select aria-label={`参考线方向 ${guide.id}`} value={guide.axis} disabled={disabled||guide.locked} onChange={event=>guidePatch(guide,{axis:event.target.value as 'x'|'y'})}><option value="x">竖线</option><option value="y">横线</option></select></label><NumberCommit label={`参考线位置 ${guide.id}`} value={guide.position} disabled={disabled||guide.locked} onCommit={position=>guidePatch(guide,{position})}/></div>
        <label>所属画板<select aria-label={`参考线画板 ${guide.id}`} value={guide.artboardId||''} disabled={disabled||guide.locked} onChange={event=>{const next={...guide};if(event.target.value)next.artboardId=event.target.value;else delete next.artboardId;commands([{type:'guide.upsert',guide:next}]);}}><option value="">工程全局</option>{(doc.artboards||[]).map(board=><option value={board.id} key={board.id}>{board.name}</option>)}</select></label>
        <div className="inlineOptions"><button disabled={disabled||guide.locked} onClick={()=>guidePatch(guide,{visible:!guide.visible})}>{guide.visible?'隐藏参考线':'显示参考线'}</button><button disabled={disabled} onClick={()=>guidePatch(guide,{locked:!guide.locked})}>{guide.locked?'解锁参考线':'锁定参考线'}</button><button disabled={disabled||guide.locked} onClick={()=>commands([{type:'guide.remove',guideId:guide.id}])}>删除参考线</button></div>
      </div>)}
    </details>
    <p>这里的操作不调用生成模型。调整图层、分块图像与高级文字排版尚不可用。</p>
    {working&&<p role="status">正在保存设计属性…</p>}
  </div>;
}
