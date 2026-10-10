import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioProvider } from './provider.mjs';
import { createProject } from './domain.mjs';
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
function fixture(count=2){const project=createProject();project.assets=Array.from({length:count},(_,i)=>({id:`image-${i}`,kind:'image',mime:'image/png',name:`reference ${i}`,hash:`hash-${i}`,url:`/api/v3/assets/image-${i}/content`}));project.nodes=project.assets.map((a,i)=>({id:`node-${i}`,type:'image',assetId:a.id,x:i*300,y:0,label:a.name}));return project;}
test('selected canvas images are sent as actual bytes with stable identity, unselected images are not read',async()=>{
 const project=fixture(),reads=[];let payload;
 const provider=new StudioProvider({llm:{baseUrl:'https://example.invalid/v1',apiKey:'fixture-key',model:'fixture-model'}},{fetchImpl:async(url,options)=>{payload=JSON.parse(options.body);return Response.json({choices:[{message:{content:JSON.stringify({message:'Edited',ops:[]})}}]});}});
 const result=await provider.edit({selectedNodeIds:['node-0'],scope:'storyboard'},project,async id=>{reads.push(id);return {mime:'image/png',bytes:PNG};});
 assert.deepEqual(reads,['image-0']); const images=payload.messages[1].content.filter(part=>part.type==='image_url');assert.equal(images.length,1);
 assert.deepEqual(Buffer.from(images[0].image_url.url.split(',')[1],'base64'),PNG);
 assert.match(payload.messages[1].content[0].text,/image-0/);
 assert.match(result.message,/实际发送 1 张/);assert.equal(JSON.stringify(payload).includes('fixture-key'),false);
});
test('oversized or too many explicit image references fail before calling the model',async()=>{
 let calls=0;const provider=new StudioProvider({llm:{baseUrl:'https://example.invalid/v1',apiKey:'fixture-key'}},{fetchImpl:async()=>{calls++;throw Error('must not submit');}});
 const project=fixture(5);
 await assert.rejects(()=>provider.edit({selectedNodeIds:project.nodes.map(n=>n.id)},project,async()=>({mime:'image/png',bytes:PNG})),/最多 4 张/);
 await assert.rejects(()=>provider.edit({selectedNodeIds:['node-0']},project,async()=>({mime:'image/png',bytes:Buffer.alloc(8*1024*1024+1)})),/超过 8 MB/);
 assert.equal(calls,0);
});
