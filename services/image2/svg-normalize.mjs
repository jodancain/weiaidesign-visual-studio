import { XMLParser, XMLBuilder, XMLValidator } from 'fast-xml-parser';
import * as cssTree from 'css-tree';

// This module deliberately has no Node or DOM imports. Canvas previews and exports
// must use the same viewport, drawing identities, paint overrides and references.
const DRAWING_TAGS=new Set(['path','polygon','polyline','rect','circle','ellipse','line','text','image','use']);
const RESOURCE_TAGS=new Set(['defs','clippath','mask','pattern','marker','symbol','lineargradient','radialgradient','filter']);
const CSS_VALUE_ATTRIBUTES=new Set(['fill','stroke','clip-path','mask','filter','marker','marker-start','marker-mid','marker-end','cursor','color','flood-color','lighting-color','stop-color']);
const BLOCKED_TAGS=new Set(['script','foreignobject','iframe','object','embed','audio','video','animate','animatemotion','animatetransform','set','discard']);
const localName=name=>name.split(':').at(-1);
const error=(message,code='SVG_INVALID')=>Object.assign(new Error(message),{status:422,code});
const identifier=value=>{const id=String(value).replace(/[^a-zA-Z0-9_-]/gu,char=>`_${char.codePointAt(0).toString(16)}_`);return /^(?:[a-zA-Z_]|-(?:[a-zA-Z_-]))/.test(id)?id:`i2-id-${id}`;};
const sourceAttribute=name=>`data-i2-source-attr-${identifier(name.replace('|',':').toLowerCase())}`;
const XML_NAMESPACE='http://www.w3.org/XML/1998/namespace';
const finitePositive=value=>Number.isFinite(Number(value))&&Number(value)>0?Number(value):undefined;
const units={px:1,in:96,cm:96/2.54,mm:96/25.4,q:96/101.6,pt:96/72,pc:16};

function length(value){
  if(value===undefined||value===null||value==='')return undefined;
  const match=/^\s*([+-]?(?:\d*\.\d+|\d+\.?\d*)(?:e[+-]?\d+)?)\s*(px|in|cm|mm|q|pt|pc)?\s*$/i.exec(String(value));
  if(!match)return undefined;const number=Number(match[1])*(units[(match[2]||'px').toLowerCase()]||1);
  if(!Number.isFinite(number)||number<=0)throw error('SVG width and height must be positive finite lengths','SVG_VIEWPORT');
  return number;
}
function reference(value,kind){
  const text=(kind==='css'?cssTree.ident.decode(String(value)):String(value)).replace(/^[\x09-\x0d\x20]+|[\x09-\x0d\x20]+$/g,'');
  if(/^#[^\s]+$/.test(text))return text;
  // usvg's compiled image URI has a space after the comma. Only fold ASCII
  // whitespace in an explicitly allowed Base64 payload, never MIME/URI syntax.
  const embedded=/^(data:(image\/(?:png|jpeg|webp)|font\/(?:ttf|otf|woff2?));base64,)([\s\S]*)$/.exec(text);
  if(embedded&&(embedded[2].startsWith('image/')||kind==='css')){
    const payload=embedded[3].replace(/[\x09-\x0d\x20]/g,'');
    if(/^[A-Za-z0-9+/]+={0,2}$/.test(payload))return `${embedded[1]}${payload}`;
  }
  throw error('SVG references must be internal IDs or embedded safe image/font data','SVG_UNSAFE');
}
function cssAst(text,context){
  let ast;try{ast=cssTree.parse(String(text),{...(context?{context}:{}),parseCustomProperty:true});}catch{throw error('SVG contains invalid CSS','SVG_CSS');}
  cssTree.walk(ast,node=>{
    if(['Function','Atrule','PseudoClassSelector','IdSelector'].includes(node.type))node.name=cssTree.ident.decode(node.name);
    if(node.type==='Declaration')node.property=cssTree.ident.decode(node.property);
    if(node.type==='Url')node.value=reference(node.value,'css');
    if(node.type==='Function'&&node.name.toLowerCase()==='url'){
      const children=node.children.toArray(),value=children.length===1&&children[0].type==='String'?children[0].value:children.map(child=>cssTree.generate(child)).join('');
      node.type='Url';node.value=reference(value,'css');delete node.name;delete node.children;
    }
  });
  return ast;
}
function checkCss(ast){
  cssTree.walk(ast,node=>{
    if(node.type==='Atrule'&&['import','namespace','document'].includes(node.name.toLowerCase()))throw error('SVG CSS imports are unavailable','SVG_UNSAFE');
    if(node.type==='Function'&&['expression','-moz-binding'].includes(node.name.toLowerCase()))throw error('SVG CSS contains active content','SVG_UNSAFE');
    if(node.type==='Url')reference(node.value,'css');
    if(node.type==='Declaration'&&['behavior','-moz-binding'].includes(node.property.toLowerCase()))throw error('SVG CSS contains active content','SVG_UNSAFE');
    if(node.type==='Declaration'&&node.property.toLowerCase()==='overflow'&&cssTree.generate(node.value).trim().toLowerCase()==='visible')throw error('SVG 使用了可视溢出，当前无法保证跨格式保真。请扩大原 SVG 的 viewBox，或使用边界明确的素材；原始文件保留。','SVG_OVERFLOW_UNSUPPORTED');
  });
}
function styleText(children){return children.map(item=>item['#text']??(Array.isArray(item['#cdata'])?item['#cdata'].map(text=>text['#text']||'').join(''):'')).join('');}
function paintValue(key,value){
  const text=String(value);
  if(!text||/[{}<>]/.test(text))throw error('Invalid SVG drawing paint','SVG_PAINT');
  const ast=cssAst(text,'value');checkCss(ast);let hasUrl=false;
  cssTree.walk(ast,node=>{if(node.type==='Url')hasUrl=true;});
  if(hasUrl||cssTree.lexer.matchProperty(key,ast).error)throw error('Invalid SVG drawing paint','SVG_PAINT');
  return cssTree.generate(ast);
}

/** Normalize one immutable source SVG. width/height options are source viewport
 * fallbacks, never the canvas display box. responsive only changes root output sizing. */
export function normalizeSvg(markup,options={}){
  if(typeof markup!=='string'||markup.length>64*1024*1024)throw error('SVG source is missing or too large');
  if(/<!DOCTYPE|<!ENTITY/i.test(markup))throw error('SVG entity declarations are unavailable','SVG_UNSAFE');
  if(XMLValidator.validate(markup)!==true)throw error('SVG XML is invalid');
  const parser=new XMLParser({ignoreAttributes:false,preserveOrder:true,processEntities:true,cdataPropName:'#cdata'});
  const tree=parser.parse(markup),roots=tree.filter(node=>Object.keys(node).some(key=>key!==':@'&&Array.isArray(node[key])&&!key.startsWith('?')));
  if(roots.length!==1)throw error('A single SVG root is required');
  const root=roots[0],rootTag=Object.keys(root).find(key=>key!==':@'&&Array.isArray(root[key]));
  if(localName(rootTag)!=='svg')throw error('An SVG root is required');
  const normalizedInput=root[':@']?.['@_data-i2-normalized-version']==='1';
  const records=[],byNode=new Map(),originals=new Map(),warnings=[],legacyAliases=Object.create(null),legacyCounts=new Map(),drawCounts=new Map(),attributeSelectors=new Set();
  let sequence=0;
  function visit(nodes,parent,resource=false,viewport){
    for(const node of nodes){
      const key=Object.keys(node).find(name=>name!==':@'&&Array.isArray(node[name])&&!name.startsWith('?'));
      if(!key)continue;const tag=localName(key);
      if(++sequence>100000)throw error('SVG exceeds the node budget','SVG_BUDGET');
      if(BLOCKED_TAGS.has(tag.toLowerCase()))throw error('SVG contains active elements','SVG_UNSAFE');
      node[':@']||={};const attrs=node[':@'];
      const namespaces=new Map(parent?.namespaces||[['xml',XML_NAMESPACE]]);
      for(const [name,value] of Object.entries(attrs))if(name.startsWith('@_xmlns:'))namespaces.set(name.slice(8),String(value));
      const record={node,key,tag,attrs,sourceAttrs:{...attrs},namespaces,parent,resource:resource||RESOURCE_TAGS.has(tag.toLowerCase()),index:records.length,viewport:null,depth:(parent?.depth||0)+1};
      if(record.depth>256)throw error('SVG nesting exceeds the depth budget','SVG_BUDGET');
      record.viewport=tag==='svg'?record:viewport;records.push(record);byNode.set(node,record);
      for(const [name,value] of Object.entries(attrs)){
        const attr=localName(name.slice(2));
        if(attr==='base'&&(name==='@_xml:base'||namespaces.get(name.slice(2).split(':')[0])===XML_NAMESPACE))throw error('SVG xml:base is unavailable; fragment references must remain internal','SVG_UNSAFE');
        if(tag==='svg'&&attr==='overflow'&&String(value).trim().toLowerCase()==='visible')throw error('SVG 使用了可视溢出，当前无法保证跨格式保真。请扩大原 SVG 的 viewBox，或使用边界明确的素材；原始文件保留。','SVG_OVERFLOW_UNSUPPORTED');
        if(/^on/i.test(attr))throw error('SVG event handlers are unavailable','SVG_UNSAFE');
        if(attr==='href')attrs[name]=reference(value,'href');
        if(attr==='style'){const ast=cssAst(value,'declarationList');checkCss(ast);}
        else if(CSS_VALUE_ATTRIBUTES.has(attr)||/url\s*\(/i.test(String(value))){const ast=cssAst(value,'value');checkCss(ast);}
      }
      if(tag==='style'){const text=styleText(node[key]);if(text.includes(']]>'))throw error('SVG CSS contains an unsafe CDATA delimiter','SVG_UNSAFE');const ast=cssAst(text);checkCss(ast);cssTree.walk(ast,{visit:'AttributeSelector',enter(selector){const name=cssTree.ident.decode(selector.name.name).replace('|',':');if(!name.startsWith('data-i2-source-attr-')&&!(normalizedInput&&['data-i2-svg-scope','data-i2-root'].includes(name)))attributeSelectors.add(name);}});}
      const inputId=attrs['@_id'];
      if(inputId!==undefined){record.inputId=String(inputId);const list=originals.get(record.inputId)||[];list.push(record);originals.set(record.inputId,list);}
      record.canonicalId=attrs['@_data-i2-canonical-id'];
      if(attrs['@_data-i2-original-id']!==undefined)record.originalId=String(attrs['@_data-i2-original-id']);
      else if(inputId!==undefined&&attrs['@_data-i2-generated-id']!=='1')record.originalId=String(inputId);
      if(DRAWING_TAGS.has(tag)){
        const oldIndex=legacyCounts.get(tag)||0;legacyCounts.set(tag,oldIndex+1);record.legacyId=`${tag}-${oldIndex}`;
        if(!record.resource){record.drawingIndex=drawCounts.get(tag)||0;drawCounts.set(tag,record.drawingIndex+1);}
      }
      visit(node[key],record,record.resource,record.viewport);
    }
  }
  visit([root],null);
  const rootRecord=byNode.get(root),attrs=root[':@'];
  const priorScope=attrs['@_data-i2-svg-scope'],normalizedSource=attrs['@_data-i2-normalized-version']==='1';
  const rootStyle=attrs['@_style']?cssAst(attrs['@_style'],'declarationList'):null,styleDimensions={};
  rootStyle?.children.forEach(node=>{if(node.type==='Declaration'&&['width','height'].includes(node.property))styleDimensions[node.property]=cssTree.generate(node.value);});
  let viewBox;if(attrs['@_viewBox']!==undefined){
    const values=String(attrs['@_viewBox']).trim().split(/[\s,]+/).map(Number);
    if(values.length!==4||!values.every(Number.isFinite)||values[2]<=0||values[3]<=0)throw error('SVG viewBox must contain four finite numbers with positive size','SVG_VIEWPORT');viewBox=values;
  }
  let width=length(styleDimensions.width??attrs['@_width'])??finitePositive(options.width)??finitePositive(options.fallbackWidth);
  let height=length(styleDimensions.height??attrs['@_height'])??finitePositive(options.height)??finitePositive(options.fallbackHeight);
  if(normalizedSource){width=finitePositive(attrs['@_data-i2-intrinsic-width'])??width;height=finitePositive(attrs['@_data-i2-intrinsic-height'])??height;}
  if(viewBox){if(width&&!height)height=width*viewBox[3]/viewBox[2];else if(height&&!width)width=height*viewBox[2]/viewBox[3];else {width??=viewBox[2];height??=viewBox[3];}}
  if(!width||!height)throw error('SVG requires a source width/height or viewBox; provide known intrinsic dimensions','SVG_VIEWPORT_REQUIRED');
  viewBox??=[0,0,width,height];
  const used=new Set([...originals.keys(),...records.map(record=>record.canonicalId).filter(Boolean)]),assigned=new Set(),renderedIds=new Set(),scope=options.scope?identifier(options.scope):normalizedSource&&priorScope?identifier(priorScope):'';
  function unique(preferred){let id=preferred,index=1;while(assigned.has(id))id=`${preferred}__duplicate_${index++}`;assigned.add(id);return id;}
  for(const record of records){
    let canonical=record.canonicalId||record.originalId;
    if(!canonical){const prefix=record===rootRecord?'i2-svg-root':record.drawingIndex!==undefined?`i2-draw-${record.tag}-${record.drawingIndex}`:null;
      if(prefix){canonical=prefix;let index=1;while(used.has(canonical))canonical=`${prefix}__generated_${index++}`;used.add(canonical);}
    }
    if(canonical){record.id=unique(canonical);const preferred=record===rootRecord&&scope?scope:scope?`${scope}__${identifier(record.id)}`:identifier(record.id);let rendered=preferred,index=1;while(renderedIds.has(rendered))rendered=`${preferred}__render_${index++}`;renderedIds.add(rendered);record.renderId=rendered;record.attrs['@_id']=record.renderId;record.attrs['@_data-i2-canonical-id']=record.id;if(record.originalId!==undefined)record.attrs['@_data-i2-original-id']=record.originalId;else record.attrs['@_data-i2-generated-id']='1';}
    if(record.legacyId)legacyAliases[record.legacyId]=record.drawingIndex===undefined?null:record.id;
  }
  for(const [id,list] of originals)if(list.length>1)warnings.push(`Duplicate SVG ID ${id} was namespaced; references use the nearest source subtree.`);
  function commonDepth(left,right){const lineage=new Set();for(let n=left;n;n=n.parent)lineage.add(n);for(let n=right;n;n=n.parent)if(lineage.has(n))return n.depth;return 0;}
  function resolve(id,from){
    let list=originals.get(id);if(!list)list=records.filter(record=>record.id===id);
    if(!list.length)return scope?`${scope}__unresolved_${identifier(id)}`:identifier(id);
    let viewport=from.viewport;
    while(viewport){const local=list.filter(record=>record.viewport===viewport);if(local.length){list=local;break;}viewport=viewport.parent?.viewport;}
    return [...list].sort((a,b)=>commonDepth(from,b)-commonDepth(from,a)||a.index-b.index)[0].renderId;
  }
  function rewriteCss(ast,record,stylesheet){
    if(stylesheet&&normalizedSource&&priorScope)cssTree.walk(ast,{visit:'AttributeSelector',enter(node,item,list){if(node.name.name==='data-i2-svg-scope'&&node.matcher==='='&&node.value?.value===priorScope&&list)list.remove(item);}});
    cssTree.walk(ast,node=>{
      if(node.type==='Url'&&String(node.value).startsWith('#'))node.value=`#${resolve(String(node.value).slice(1),record)}`;
      if(node.type==='IdSelector')node.name=resolve(node.name,record);
      if(node.type==='AttributeSelector'&&!node.name.name.startsWith('data-i2-source-attr-')&&!(normalizedSource&&['data-i2-svg-scope','data-i2-root'].includes(node.name.name)))node.name.name=sourceAttribute(cssTree.ident.decode(node.name.name));
      if(node.type==='PseudoClassSelector'&&node.name==='root'){
        for(const key of Object.keys(node))delete node[key];
        Object.assign(node,{type:'AttributeSelector',loc:null,name:{type:'Identifier',loc:null,name:'data-i2-root'},matcher:'=',value:{type:'String',loc:null,value:'1'},flags:null});
      }
    });
    if(stylesheet&&scope)cssTree.walk(ast,{visit:'Rule',enter(rule){
      if(rule.prelude?.type!=='SelectorList')return;
      const selectors=[];rule.prelude.children.forEach(selector=>{
        const cloned=cssTree.clone(selector),nodes=cloned.children.toArray();
        const scoped=cssTree.parse(`[data-i2-svg-scope="${scope}"]`,{context:'selectorList'}).children.first.children.first;
        const index=nodes.findIndex(node=>node.type==='PseudoElementSelector');nodes.splice(index<0?nodes.length:index,0,scoped);cloned.children=new cssTree.List().fromArray(nodes);
        selectors.push(cssTree.generate(cloned));
      });rule.prelude=cssTree.parse(selectors.join(','),{context:'selectorList'});
    }});
    return cssTree.generate(ast);
  }
  const drawingNodes=[];
  for(const record of records){
    for(const [name,value] of Object.entries(record.attrs)){
      const attr=localName(name.slice(2));
      if(attr==='id')continue;
      if(attr==='href'&&String(value).startsWith('#'))record.attrs[name]=`#${resolve(String(value).slice(1),record)}`;
      else if(['aria-labelledby','aria-describedby'].includes(attr))record.attrs[name]=String(value).split(/\s+/).map(id=>resolve(id,record)).join(' ');
      else if(attr==='style')record.attrs[name]=rewriteCss(cssAst(value,'declarationList'),record,false);
      else if(CSS_VALUE_ATTRIBUTES.has(attr)||/url\s*\(/i.test(String(value)))record.attrs[name]=rewriteCss(cssAst(value,'value'),record,false);
    }
    if(record.tag==='style')record.node[record.key]=[{'#cdata':[{'#text':rewriteCss(cssAst(styleText(record.node[record.key])),record,true)}]}];
    if(scope)record.attrs['@_data-i2-svg-scope']=scope;
    for(const name of attributeSelectors){const value=record.sourceAttrs[`@_${name}`];if(value!==undefined)record.attrs[`@_${sourceAttribute(name)}`]=value;}
    if(record!==rootRecord&&record.attrs['@_data-i2-root']!==undefined)delete record.attrs['@_data-i2-root'];
    if(record.drawingIndex===undefined)continue;
    const legacyIds=record.legacyId?[record.legacyId]:[];
    const legacy=Object.assign({},...legacyIds.filter(id=>legacyAliases[id]===record.id).map(id=>options.styles?.[id]||{}));
    const paint={...(options.fill!==undefined?{fill:options.fill}:{}),...options.styles?.['*'],...legacy,...options.styles?.[record.id]};
    const declarations=[];
    for(const key of ['fill','stroke','stroke-width'])if(paint[key]!==undefined){const value=paintValue(key,paint[key]);record.attrs[`@_${key}`]=value;declarations.push(`${key}:${value} !important`);}
    if(declarations.length){const ast=cssAst(record.attrs['@_style']||'','declarationList');ast.children=ast.children.filter(node=>node.type!=='Declaration'||paint[node.property]===undefined);record.attrs['@_style']=[cssTree.generate(ast),...declarations].filter(Boolean).join(';');}
    drawingNodes.push({id:record.id,tag:record.tag,...(record.originalId!==undefined?{originalId:record.originalId}:{}),legacyIds});
  }
  attrs['@_xmlns']||='http://www.w3.org/2000/svg';attrs['@_width']=options.responsive?'100%':width;attrs['@_height']=options.responsive?'100%':height;attrs['@_viewBox']=viewBox.join(' ');
  attrs['@_data-i2-normalized-version']='1';
  attrs['@_data-i2-root']='1';
  attrs['@_data-i2-intrinsic-width']=width;attrs['@_data-i2-intrinsic-height']=height;
  delete attrs['@_x'];delete attrs['@_y'];
  const placement=cssAst(attrs['@_style']||'','declarationList');placement.children=placement.children.filter(node=>node.type!=='Declaration'||!['x','y','width','height'].includes(node.property));attrs['@_style']=[cssTree.generate(placement),'x:0px !important','y:0px !important',`width:${options.responsive?'100%':`${width}px`} !important`,`height:${options.responsive?'100%':`${height}px`} !important`].filter(Boolean).join(';');
  if(options.preserveAspectRatio!==undefined)attrs['@_preserveAspectRatio']=String(options.preserveAspectRatio);
  if(options.responsive){const ast=cssAst(attrs['@_style']||'','declarationList');ast.children=ast.children.filter(node=>node.type!=='Declaration'||!['width','height'].includes(node.property));attrs['@_style']=[cssTree.generate(ast),'width:100% !important','height:100% !important'].filter(Boolean).join(';');}
  const svg=new XMLBuilder({ignoreAttributes:false,preserveOrder:true,suppressEmptyNode:true,cdataPropName:'#cdata'}).build([root]);
  return {svg,width,height,viewBox,drawingNodes,legacyAliases,warnings};
}

export function inspectDrawingNodes(markup,options={}){return normalizeSvg(markup,options).drawingNodes;}
