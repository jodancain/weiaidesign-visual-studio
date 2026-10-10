import { fail } from './domain.mjs';

// Part identity comes from the uploaded GLB, never the caller's metadata.
export function glbMetadata(bytes) {
  fail(bytes.length>=20&&bytes.readUInt32LE(0)===0x46546c67&&bytes.readUInt32LE(4)===2&&bytes.readUInt32LE(8)===bytes.length,'model must be a complete GLB 2.0 file',422);
  let json;
  for(let offset=12;offset<bytes.length;){
    fail(offset+8<=bytes.length,'invalid GLB chunk header',422);
    const size=bytes.readUInt32LE(offset),type=bytes.readUInt32LE(offset+4);offset+=8;
    fail(size%4===0&&offset+size<=bytes.length,'invalid GLB chunk size',422);
    if(type===0x4e4f534a){fail(!json&&size<=20000000,'invalid GLB JSON chunk',422);try{json=JSON.parse(bytes.subarray(offset,offset+size).toString('utf8').trim());}catch{fail(false,'invalid GLB JSON',422);}}
    offset+=size;
  }
  fail(json?.asset?.version==='2.0'&&Array.isArray(json.nodes)&&json.nodes.length<=10000,'GLB requires a bounded node hierarchy',422);
  const nodes=json.nodes,parents=new Map();
  for(const [index,node] of nodes.entries()){
    fail(node&&typeof node==='object'&&!Array.isArray(node),'invalid GLB node',422);
    if(node.mesh!==undefined)fail(Number.isInteger(node.mesh)&&node.mesh>=0&&Array.isArray(json.meshes)&&node.mesh<json.meshes.length,'invalid GLB mesh reference',422);
    if(node.children!==undefined)fail(Array.isArray(node.children),'invalid GLB children',422);
    for(const child of node.children||[]){fail(Number.isInteger(child)&&child>=0&&child<nodes.length&&child!==index&&!parents.has(child),'invalid GLB parent hierarchy',422);parents.set(child,index);}
  }
  const partNodes=[];
  for(const [index,node] of nodes.entries()){
    let parent=parents.get(index),parentId;const seen=new Set([index]);
    while(parent!==undefined){fail(!seen.has(parent),'cyclic GLB node hierarchy',422);seen.add(parent);if(parentId===undefined&&nodes[parent].mesh!==undefined)parentId=`gltf-node-${parent}`;parent=parents.get(parent);}
    if(node.mesh!==undefined)partNodes.push({id:`gltf-node-${index}`,nodePath:`/nodes/${index}`,name:typeof node.name==='string'?node.name.slice(0,500):`部件 ${index+1}`,...(parentId?{parentId}:{})});
  }
  const skins=Array.isArray(json.skins)?json.skins:[],bones=new Set(skins.flatMap(s=>Array.isArray(s.joints)?s.joints:[]));
  const clips=(Array.isArray(json.animations)?json.animations:[]).map((a,index)=>({name:typeof a.name==='string'?a.name:`animation_${index}`,duration:Math.max(0,...(a.samplers||[]).map(s=>Number(json.accessors?.[s.input]?.max?.[0])||0))}));
  return {partNodes,boneCount:bones.size,skinCount:skins.length,clips};
}
