import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { StudioProvider } from './provider.mjs';
import { createStudioRouter } from './router.mjs';
import { createProject, applyOps } from './domain.mjs';

const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
async function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'studio-ai-capture-'));let calls=0,lastBody,waitForModel;
  const provider=new StudioProvider({llm:{baseUrl:'https://fixture.invalid/v1',apiKey:'synthetic',model:'fixture'}},{fetchImpl:async(_url,options)=>{calls++;lastBody=JSON.parse(options.body);if(waitForModel)await waitForModel;const content=lastBody.messages[1].content,request=JSON.parse(Array.isArray(content)?content[0].text:content);const scene=request.project.scenes.find(s=>s.id===request.request.sceneId)||request.project.scenes[0];const op=request.request.mode==='dynamic'?{type:'track.set',sceneId:scene.id,track:{id:'capture-edit',targetId:scene.objects[0].id,property:'position',keys:[{frame:request.request.frame,value:[1,0,0],interpolation:'linear'}]}}:{type:'object.update',sceneId:scene.id,objectId:scene.objects[0].id,patch:{color:'#123456'}};return Response.json({choices:[{message:{content:JSON.stringify({message:'Edited',ops:[op]})}}]});}});
  const router=createStudioRouter({dataDir:dir,token:'synthetic',provider,startJobs:false}),server=createServer((req,res)=>router.handle(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await router.close();rmSync(dir,{recursive:true,force:true});});
  async function call(path,body){const response=await fetch(`http://127.0.0.1:${server.address().port}/api/v3${path}`,{method:body?'POST':'GET',headers:{authorization:'Bearer synthetic','content-type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:response.status,...await response.json()};}
  function project(changeMetadata=()=>{},changeProject=()=>{}){
    let p=router.store.createProject(createProject()),scene=p.scenes[0];
    const metadata={provenance:'three-scene-capture',schemaVersion:1,captureView:'selected-camera',sceneId:scene.id,sceneRevision:scene.revision,cameraId:scene.activeCameraId,frame:12,mode:'static',aspect:p.aspect,objectIds:[scene.objects[0].id],objectMapping:[{objectId:scene.objects[0].id,assetId:null,name:scene.objects[0].name,center:[.5,.5]}],partIds:[],partMapping:[]};changeMetadata(metadata,p);
    const asset=router.store.addAsset(p.id,{name:'capture.png',kind:'image',mime:'image/png',metadata},PNG).asset;p=router.store.getProject(p.id);
    p=router.store.change(p.id,p.revision,c=>{c.nodes.push({id:'capture-node',type:'image',assetId:asset.id,x:0,y:0,label:'capture'});changeProject(c,asset);return c;},{undoable:false});
    const body={baseRevision:p.revision,prompt:'Change the selected object color',sceneId:scene.id,scope:'scene',mode:'static',frame:12,cameraId:scene.activeCameraId,shotView:true,selectionIds:[scene.objects[0].id],selectedNodeIds:['capture-node'],partSelection:[]};
    return {p,asset,body};
  }
  return {router,call,project,calls:()=>calls,body:()=>lastBody,delay:promise=>{waitForModel=promise;}};
}

test('valid capture is sent as image bytes, applies one typed edit, and a single undo restores it',async t=>{
  const f=await fixture(t),{p,body}=f.project(),original=p.scenes[0].objects[0].color;
  const changed=await f.call(`/projects/${p.id}/ai`,body);assert.equal(changed.status,200);assert.equal(f.calls(),1);assert.equal(changed.data.project.scenes[0].objects[0].color,'#123456');
  const messages=f.body().messages[1].content,images=messages.filter(p=>p.type==='image_url');assert.equal(images.length,1);assert.deepEqual(Buffer.from(images[0].image_url.url.split(',')[1],'base64'),PNG);
  const undone=await f.call(`/projects/${p.id}/history`,{baseRevision:changed.data.project.revision,direction:'undo'});assert.equal(undone.status,200);assert.equal(undone.data.scenes[0].objects[0].color,original);assert.equal(f.router.store.db.prepare('SELECT count(*) AS n FROM history WHERE project_id=?').get(p.id).n,1);
});

test('dynamic capture and a saved observation camera are both valid screenshot editing contexts',async t=>{
  const f=await fixture(t);
  for(const [mode,captureView] of [['dynamic','selected-camera'],['static','observation']]){
    const {p,body}=f.project(m=>{m.mode=mode;m.captureView=captureView;});body.mode=mode;
    const response=await f.call(`/projects/${p.id}/ai`,body);assert.equal(response.status,200);
    if(mode==='dynamic')assert.equal(response.data.project.scenes[0].tracks[0].keys[0].frame,12);
    else assert.equal(response.data.project.scenes[0].objects[0].color,'#123456');
  }
  assert.equal(f.calls(),2);
});

test('capture context and mapping mismatches are rejected before any LLM call',async t=>{
  const f=await fixture(t);
  const cases={
    'scene mismatch':{metadata:m=>{m.sceneId='another-scene';}},
    'stale scene revision':{metadata:m=>{m.sceneRevision++;}},
    'frame mismatch':{body:b=>{b.frame++;}},
    'mode mismatch':{body:b=>{b.mode='dynamic';}},
    'aspect mismatch':{metadata:m=>{m.aspect='9:16';}},
    'capture view malformed':{metadata:m=>{m.captureView='unknown';}},
    'missing schema':{metadata:m=>{delete m.schemaVersion;}},
    'camera removed':{metadata:m=>{m.cameraId='removed-camera';}},
    'camera mismatch':{body:b=>{b.cameraId='another-camera';}},
    'missing request camera':{body:b=>{delete b.cameraId;}},
    'orbit view differs':{body:b=>{b.shotView=false;}},
    'object removed':{metadata:m=>{m.objectIds.push('removed-object');}},
    'object mapping differs':{metadata:m=>{m.objectMapping[0].objectId='unknown-object';}},
    'model binding changed':{metadata:m=>{m.objectMapping[0].assetId='foreign-model';}},
    'part mapping removed':{metadata:m=>{m.partIds=[{objectId:m.objectIds[0],partId:'removed-part'}];}},
    'selected object not pictured':{body:(b,p)=>{b.selectionIds=[p.scenes[0].objects[1].id];}},
    'unknown object selected':{body:b=>{b.selectionIds=['unknown-object'];}},
    'image node also carries shot references':{project:p=>{p.nodes.find(n=>n.id==='capture-node').shotId=p.shots[0].id;}},
    'capture mixed with another node':{body:(b,p)=>{b.selectedNodeIds.push(p.nodes[0].id);}},
    'capture indirectly referenced through shot':{project:(p,asset)=>{p.shots[0].firstAssetId=asset.id;},body:(b,p)=>{b.selectedNodeIds=[p.nodes.find(n=>n.shotId===p.shots[0].id).id];}},
  };
  for(const [name,change] of Object.entries(cases))await t.test(name,async()=>{
    const {p,body}=f.project(change.metadata,change.project);change.body?.(body,p);const before=f.calls();
    const response=await f.call(`/projects/${p.id}/ai`,body);assert.ok([400,404,409,422].includes(response.status),JSON.stringify(response));assert.equal(f.calls(),before,'invalid capture must not consume an LLM call');assert.equal(f.router.store.getProject(p.id).revision,p.revision);assert.equal(f.router.store.db.prepare('SELECT count(*) AS n FROM history WHERE project_id=?').get(p.id).n,0);
  });
});

test('ordinary image references and storyboard captures retain their prior behavior',async t=>{
  const f=await fixture(t);
  for(const [name,change,scope] of [
    ['ordinary scene image',m=>{for(const key of Object.keys(m))delete m[key];m.sceneId='descriptive-not-a-capture';},'scene'],
    ['ordinary storyboard image',m=>{for(const key of Object.keys(m))delete m[key];},'storyboard'],
    ['stale capture as storyboard reference',m=>{m.sceneRevision=999;},'storyboard'],
  ]){
    const {p,body}=f.project(change);body.scope=scope;delete body.cameraId;delete body.shotView;
    const result=await f.call(`/projects/${p.id}/ai`,body);assert.equal(result.status,200,name);
  }
  assert.equal(f.calls(),3);
});

test('unknown object selection is rejected before the model even without screenshot references',async t=>{
  const f=await fixture(t),{p,body}=f.project();body.selectedNodeIds=[];body.selectionIds=['missing'];
  const result=await f.call(`/projects/${p.id}/ai`,body);assert.notEqual(result.status,200);assert.equal(f.calls(),0);
});

test('capture AI response still loses CAS to a newer user edit without adding stale history',async t=>{
  const f=await fixture(t),{p,body}=f.project();let release;f.delay(new Promise(r=>{release=r;}));
  const response=f.call(`/projects/${p.id}/ai`,body);for(let i=0;i<100&&f.calls()===0;i++)await new Promise(r=>setTimeout(r,5));assert.equal(f.calls(),1);
  f.router.store.change(p.id,p.revision,current=>applyOps(current,[{type:'object.update',sceneId:body.sceneId,objectId:body.selectionIds[0],patch:{color:'#abcdef'}}]));release();
  assert.equal((await response).status,409);assert.equal(f.router.store.getProject(p.id).scenes[0].objects[0].color,'#abcdef');assert.equal(f.router.store.db.prepare('SELECT count(*) AS n FROM history WHERE project_id=?').get(p.id).n,1);
});
