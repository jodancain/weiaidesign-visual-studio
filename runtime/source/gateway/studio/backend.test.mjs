import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createProject, applyOps, shotHash, protectedUpdate, validateProject, clone, reviewProject } from './domain.mjs';
import { StudioStore } from './store.mjs';
import { StudioJobs } from './jobs.mjs';
import { StudioProvider, SubmissionError } from './provider.mjs';
import { createStudioRouter } from './router.mjs';
import { glbMetadata } from './glb.mjs';

const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
function temp(t){const dir=mkdtempSync(join(tmpdir(),'studio-v3-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
function storeFixture(t){const store=new StudioStore(temp(t));t.after(()=>store.close());const p=store.createProject(createProject());return {store,p};}
function cameraOp(p,x=2){return {type:'camera.update',sceneId:p.scenes[0].id,cameraId:p.scenes[0].activeCameraId,patch:{position:[x,3,6]}};}
function modelGLB(){const json=JSON.stringify({asset:{version:'2.0'},nodes:[{name:'outer',children:[1]},{name:'arm',mesh:0,children:[2]},{name:'hand',mesh:0}],meshes:[{primitives:[]}]}),body=Buffer.from(json+' '.repeat((4-json.length%4)%4)),header=Buffer.alloc(20);header.writeUInt32LE(0x46546c67);header.writeUInt32LE(2,4);header.writeUInt32LE(20+body.length,8);header.writeUInt32LE(body.length,12);header.writeUInt32LE(0x4e4f534a,16);return Buffer.concat([header,body]);}

test('five-shot demo is exactly 240 frames and scene edits invalidate only content hashes',()=>{
  const p=createProject();assert.equal(p.shots.length,5);assert.equal(p.shots.at(-1).endFrame,240);assert.equal(p.scenes[0].objects.length,3);validateProject(p);
  const hash=shotHash(p,p.shots[0]);p.shots[0].approval={hash,at:new Date().toISOString()};
  const moved=clone(p);moved.nodes[0].x+=500;assert.equal(protectedUpdate(p,moved).shots[0].approval.hash,hash);
  moved.viewport={x:25,y:-50,zoom:0.5};assert.equal(protectedUpdate(p,moved).shots[0].approval.hash,hash);moved.viewport.zoom=5;assert.throws(()=>validateProject(moved),/viewport/);
  const changed=applyOps(p,[cameraOp(p)]);assert.equal(changed.shots[0].approval,undefined);assert.notEqual(shotHash(changed,changed.shots[0]),hash);
  const forged=clone(p);forged.shots[0].approval.hash='a'.repeat(64);assert.throws(()=>protectedUpdate(p,forged),/server owned/);
});

test('typed edits reject out-of-selection, locked objects, invalid quaternions and static animation',()=>{
  const p=createProject(),s=p.scenes[0],o=s.objects[0];
  assert.throws(()=>applyOps(p,[{type:'object.update',sceneId:s.id,objectId:s.objects[1].id,patch:{name:'outside'}}],{selectionIds:[o.id],ai:true}),/outside selection/);
  o.locked=true;assert.throws(()=>applyOps(p,[{type:'object.update',sceneId:s.id,objectId:o.id,patch:{name:'changed'}}]),/locked/);
  o.locked=false;assert.throws(()=>applyOps(p,[{type:'object.update',sceneId:s.id,objectId:o.id,patch:{transform:{position:[0,0,0],rotation:[0,0,0,0],scale:[1,1,1]}}}]),/transform/);
  const track={id:'track-1',targetId:o.id,property:'position',keys:[{frame:0,value:[0,0,0],interpolation:'linear'}]};
  assert.throws(()=>applyOps(p,[{type:'track.set',sceneId:s.id,track}],{ai:true,mode:'static'}),/static edit/);
  assert.equal(p.scenes[0].tracks.length,0);
});

test('dynamic AI can change only the current-frame key without modifying track identity or other keys',()=>{
  const p=createProject(),scene=p.scenes[0],objectId=scene.objects[0].id;
  const context={ai:true,mode:'dynamic',frame:12,sceneId:scene.id,selectionIds:[objectId]};
  assert.throws(()=>applyOps(p,[{type:'object.update',sceneId:scene.id,objectId,patch:{color:'#0000ff'}}],context),/只能通过 track.set/);
  const track={id:'position-keys',targetId:objectId,property:'position',keys:[{frame:0,value:[0,0,0],interpolation:'linear'},{frame:12,value:[1,0,0],interpolation:'linear'},{frame:24,value:[2,0,0],interpolation:'linear'}]};
  scene.tracks.push(track);const next=clone(track);next.keys[1].value=[3,0,0];
  assert.deepEqual(applyOps(p,[{type:'track.set',sceneId:scene.id,track:next}],context).scenes[0].tracks[0].keys[1].value,[3,0,0]);
  const other=clone(next);other.keys[0].value=[99,0,0];assert.throws(()=>applyOps(p,[{type:'track.set',sceneId:scene.id,track:other}],context),/其他帧/);
  const changedTarget=clone(next);changedTarget.property='scale';assert.throws(()=>applyOps(p,[{type:'track.set',sceneId:scene.id,track:changedTarget}],context),/已有轨道/);
  assert.throws(()=>applyOps(p,[{type:'track.set',sceneId:scene.id,track:{...next,id:'new-track'}}],context),/只能包含当前帧/);
});

test('joint limits reference actual rig bones and require finite ordered XYZ bounds',()=>{
  const p=createProject(),rig=p.scenes[0].objects[0].rig;
  assert.equal(Object.keys(rig.limits).length,16);assert.equal(rig.limits.Hips,undefined);
  rig.limits={Hips:{min:[-Math.PI,-1,0],max:[Math.PI,1,0]}};validateProject(p);
  rig.limits.UnknownBone={min:[0,0,0],max:[1,1,1]};assert.throws(()=>validateProject(p),/rig limits/);delete rig.limits.UnknownBone;
  rig.limits.Hips.min[1]=2;assert.throws(()=>validateProject(p),/bone limit range/);
  rig.limits.Hips.min[1]=-1;rig.limits.Hips.max[2]=Infinity;assert.throws(()=>validateProject(p),/bone limit range/);
  rig.limits.Hips.max[2]=0;rig.limits.Hips.extra=true;assert.throws(()=>validateProject(p),/bone limit/);
});

test('SQLite restart retains edits, revisions, undo/redo and idempotent command receipts',t=>{
  const dir=temp(t);let store=new StudioStore(dir),p=store.createProject(createProject());const op=cameraOp(p);
  p=store.change(p.id,0,c=>applyOps(c,[op]),{commandId:'command-a',request:{ops:[op]}});assert.equal(p.revision,1);
  const asset=store.addAsset(p.id,{name:'frame.png',kind:'image',mime:'image/png'},PNG).asset;store.close();store=new StudioStore(dir);t.after(()=>store.close());
  const live=store.getProject(p.id);assert.equal(live.revision,2);assert.equal(store.change(p.id,0,()=>{throw Error('must not execute');},{commandId:'command-a',request:{ops:[op]}}).revision,2);
  assert.throws(()=>store.change(p.id,0,c=>c),/reload/);
  const undone=store.history(p.id,live.revision,'undo');assert.deepEqual(undone.scenes[0].cameras[0].position,[0,2,6]);assert.ok(undone.assets.some(a=>a.id===asset.id));
  const redone=store.history(p.id,undone.revision,'redo');assert.deepEqual(redone.scenes[0].cameras[0].position,[2,3,6]);
  assert.throws(()=>store.change(p.id,redone.revision,c=>c,{commandId:'command-a',request:{ops:[]}}),/different content/);
});

test('atomic validation failure leaves project and history unchanged',t=>{
  const {store,p}=storeFixture(t);assert.throws(()=>store.change(p.id,0,c=>applyOps(c,[cameraOp(c),{type:'object.update',sceneId:c.scenes[0].id,objectId:'missing',patch:{name:'bad'}}])),/not found/);
  assert.equal(store.getProject(p.id).revision,0);assert.throws(()=>store.history(p.id,0,'undo'),/nothing/);
});

test('camera additions and clip weight targets match director wire contract; deleting a clip removes its weight track',()=>{
  let p=createProject(),s=p.scenes[0];
  const camera={...s.cameras[0],id:'second-camera',name:'侧机位'};
  p=applyOps(p,[{type:'scene.update',sceneId:s.id,patch:{cameras:[...s.cameras,camera],activeCameraId:camera.id}}]);
  const clip={id:'walk-clip',targetId:s.objects[0].id,clipName:'Walk',startFrame:0,endFrame:120,sourceIn:0,speed:1,weight:1,fadeIn:0,fadeOut:0,mask:'all'};
  p=applyOps(p,[{type:'clip.set',sceneId:s.id,clip},{type:'track.set',sceneId:s.id,track:{id:'weight-track',targetId:clip.id,property:'weight',keys:[{frame:0,value:0,interpolation:'linear'},{frame:24,value:1,interpolation:'linear'}]}}],{selectionIds:[s.objects[0].id]});
  assert.equal(p.scenes[0].tracks.length,1);
  assert.throws(()=>applyOps(p,[{type:'clip.set',sceneId:s.id,clip:{...clip,clipName:'invented'}}]),/does not exist/);
  p=applyOps(p,[{type:'clip.remove',sceneId:s.id,clipId:clip.id}]);assert.equal(p.scenes[0].tracks.length,0);assert.equal(p.scenes[0].clips.length,0);
});

test('Blender preview uses durable jobRef, resumes accepted job, and copies image/video/landmark receipts',async t=>{
  const {store,p}=storeFixture(t);const baked=store.addAsset(p.id,{name:'baked.glb',kind:'bake',mime:'model/gltf-binary'},Buffer.from('glTF-fixture')).asset;
  const requests=[];const fetchImpl=async(url,options={})=>{
    requests.push({url:String(url),options});
    const identity={id:job.id,jobRef:job.id,inputHash:store.job(job.id).private.inputHash};
    if(options.method==='POST'){const b=JSON.parse(options.body);assert.equal(b.jobRef,job.id);assert.equal(b.inputHash,identity.inputHash);return Response.json({...identity,state:'queued'});}
    if(String(url).endsWith(`/api/v3/render/${job.id}`))return Response.json({...identity,state:'complete',frames:240,fps:24,resolution:[1280,720],video_url:`/api/v3/render/${job.id}/assets/preview.mp4`,images:[{url:`/api/v3/render/${job.id}/assets/frame.png`,frame:0}],landmarks:[],landmarkValidation:{checked:1,maxPositionErrorMeters:0,maxRotationErrorDegrees:0}});
    return new Response(String(url).endsWith('.png')?PNG:Buffer.from('fixture-video'));
  };
  const jobs=new StudioJobs(store,{workerUrl:'http://worker.test',fetchImpl,validateMedia:async()=>({duration:10,width:1280,height:720})});t.after(()=>jobs.close());
  const job=store.createJob(p.id,'preview','preview-key',{scene:p.scenes[0],bakedAssetId:baked.id,frameStart:0,frameEnd:240,resolution:[1280,720]});
  await jobs.step(job.id);assert.equal(store.job(job.id).private.handle.id,job.id);
  store.recoverJobs();await jobs.step(job.id);const result=store.job(job.id).job;assert.equal(result.state,'complete');assert.equal(result.output.images.length,1);assert.equal(result.output.landmarkValidation.checked,1);assert.equal(requests.filter(r=>r.options.method==='POST').length,1);assert.equal(store.getProject(p.id).assets.length,3);
});

test('static Blender frame completes with the checkpointed PNG and no fabricated video',async t=>{
  const {store,p}=storeFixture(t);const baked=store.addAsset(p.id,{name:'bake.glb',kind:'bake',mime:'model/gltf-binary'},Buffer.from('glTF')).asset;
  const jobs=new StudioJobs(store,{workerUrl:'http://worker.test',fetchImpl:async(url,options={})=>{
    const identity={id:j.id,jobRef:j.id,inputHash:store.job(j.id).private.inputHash};
    return options.method==='POST'?Response.json({...identity,state:'queued'}):String(url).endsWith(`/api/v3/render/${j.id}`)?Response.json({...identity,state:'complete',frames:1,fps:24,resolution:[1280,720],images:[{url:`/api/v3/render/${j.id}/assets/frame.png`,frame:7}],landmarks:[],landmarkValidation:{checked:1}}):new Response(PNG);
  }});t.after(()=>jobs.close());
  const j=store.createJob(p.id,'preview','static-key',{scene:p.scenes[0],bakedAssetId:baked.id,frameStart:7,frameEnd:8});await jobs.step(j.id);await jobs.step(j.id);const result=store.job(j.id).job;
  assert.equal(result.state,'complete');assert.equal(result.outputAssetId,result.output.images[0].id);assert.equal(store.getAsset(result.outputAssetId).asset.kind,'image');assert.equal(store.getProject(p.id).assets.length,2);
});

test('subject identity/model bindings are validated, hashed for review and cleared when removing the object',t=>{
  const {store,p}=storeFixture(t),identity=store.addAsset(p.id,{name:'身份.png',kind:'image',mime:'image/png'},PNG).asset,model=store.addAsset(p.id,{name:'model.glb',kind:'model',mime:'model/gltf-binary'},Buffer.from('glTF')).asset;
  const before=store.getProject(p.id),node={id:'subject-node',type:'subject',x:1,y:2,label:'洛夜身份',sceneId:p.scenes[0].id,objectId:p.scenes[0].objects[0].id,assetId:identity.id,modelAssetId:model.id};
  const linked=clone(before);linked.nodes.push(node);validateProject(linked);assert.notEqual(shotHash(before,before.shots[0]),shotHash(linked,linked.shots[0]));
  const moved=clone(linked);moved.nodes.at(-1).x=500;assert.equal(shotHash(linked,linked.shots[0]),shotHash(moved,moved.shots[0]));assert.match(reviewProject(linked,()=>`data:image/png;base64,${PNG.toString('base64')}`).html,/人物身份图：洛夜/);
  const invalid=clone(linked);invalid.nodes.at(-1).modelAssetId=identity.id;assert.throws(()=>validateProject(invalid),/model asset/);
  const removed=applyOps(linked,[{type:'object.remove',sceneId:node.sceneId,objectId:node.objectId}]);assert.equal(removed.nodes.find(n=>n.id===node.id).objectId,undefined);
});

test('NAS archival resumes by stable task ID and does not turn a valid local output into failure',async t=>{
  const {store,p}=storeFixture(t),j=store.createJob(p.id,'export','archive-key',{project:p});store.completeJob(j.id,{name:'final.mp4',kind:'video',mime:'video/mp4'},Buffer.from('fixture-video'),{frames:240});let calls=0;
  const jobs=new StudioJobs(store,{archiveVideo:async(id)=>{calls++;assert.equal(id,j.id);const asset=store.getAsset(store.job(id).job.outputAssetId).asset;return {id:'nas-record',source_task_id:id,kind:'studio-v3-video',size:asset.bytes,metadata:{assetHash:asset.hash},public_url:'https://media.test/final.mp4',deduped:true};}});t.after(()=>jobs.close());
  assert.ok(store.pendingJobs().includes(j.id));await jobs.step(j.id);assert.equal(store.job(j.id).job.output.archive.state,'complete');assert.equal(calls,1);await jobs.step(j.id);assert.equal(calls,1);
  const failed=store.createJob(p.id,'export','archive-fails',{project:p,extra:true});store.completeJob(failed.id,{name:'local.mp4',kind:'video',mime:'video/mp4'},Buffer.from('fixture-video'));
  const broken=new StudioJobs(store,{archiveVideo:async()=>{throw new Error('offline');}});t.after(()=>broken.close());await broken.step(failed.id);await broken.step(failed.id);await broken.step(failed.id);const final=store.job(failed.id).job;assert.equal(final.state,'complete');assert.equal(final.output.archive.state,'failed');assert.ok(store.getAsset(final.outputAssetId));
});

test('LLM relay uses portable chat parameters and parses typed JSON from text blocks',async()=>{
  const provider=new StudioProvider({llm:{baseUrl:'https://relay.test/v1',apiKey:'fixture-key',model:'fixture'}},{fetchImpl:async(url,options)=>{const body=JSON.parse(options.body);assert.equal(body.response_format,undefined);assert.equal(body.temperature,undefined);return Response.json({choices:[{message:{content:[{type:'text',text:'```json\n{"message":"done","ops":[]}\n```'}]}}]});}});
  assert.deepEqual(await provider.edit({prompt:'test'},createProject()),{message:'done',ops:[]});
});

test('accepted provider ID survives restart, resumes polling and never submits twice',async t=>{
  const dir=temp(t);let store=new StudioStore(dir);const p=store.createProject(createProject()),input={shot:{...p.shots[0]},approvalHash:'approved',aspect:'16:9'};let submits=0,polls=0;
  const provider={submit:async()=>{submits++;return {id:'accepted-123',model:'fixture',referenceMode:'first_frame'};},poll:async handle=>{polls++;assert.equal(handle.id,'accepted-123');return {state:'complete',url:'https://fixture.invalid/output',model:'fixture'};},download:async()=>Buffer.from('mock-video')};
  let jobs=new StudioJobs(store,{provider,validateMedia:async()=>({duration:3}),pollIntervalMs:0});const job=store.createJob(p.id,'generation','submit-key',input);
  assert.equal(store.createJob(p.id,'generation','submit-key',input).id,job.id);assert.throws(()=>store.createJob(p.id,'generation','submit-key',{...input,aspect:'9:16'}),/different input/);
  await jobs.step(job.id);assert.equal(store.job(job.id).private.handle.id,'accepted-123');await jobs.close();store.close();
  store=new StudioStore(dir);jobs=new StudioJobs(store,{provider,validateMedia:async()=>({duration:3}),pollIntervalMs:0});t.after(async()=>{await jobs.close();store.close();});
  await jobs.step(job.id);assert.equal(store.job(job.id).job.state,'complete');assert.equal(submits,1);assert.equal(polls,1);
  const updated=store.getProject(p.id);assert.equal(updated.shots[0].takes.length,1);assert.equal(updated.assets.length,1);await jobs.step(job.id);assert.equal(updated.shots[0].takes.length,1);
});

test('uncertain submission and interrupted submission are durable and never resubmitted',async t=>{
  const {store,p}=storeFixture(t);let submits=0;const jobs=new StudioJobs(store,{provider:{submit:async()=>{submits++;throw new SubmissionError('connection dropped');}}});t.after(()=>jobs.close());
  const j=store.createJob(p.id,'generation','uncertain',{shot:p.shots[0]});await jobs.step(j.id);assert.equal(store.job(j.id).job.state,'uncertain');await jobs.step(j.id);assert.equal(submits,1);
  const interrupted=store.createJob(p.id,'generation','interrupted',{shot:p.shots[1]});store.updateJob(interrupted.id,{state:'running'},{phase:'submitting'});store.recoverJobs();assert.equal(store.job(interrupted.id).job.state,'uncertain');
});

test('coalesced idempotency keys survive completion and restart without another paid task',t=>{
  const dir=temp(t);let store=new StudioStore(dir),p=store.createProject(createProject());const input={shot:p.shots[0],approvalHash:'reviewed'};
  const first=store.createJob(p.id,'generation','first-click',input);assert.equal(store.createJob(p.id,'generation','second-click',input).id,first.id);
  store.updateJob(first.id,{state:'complete',progress:1},{phase:'complete'});store.close();store=new StudioStore(dir);t.after(()=>store.close());
  assert.equal(store.createJob(p.id,'generation','second-click',input).id,first.id);
  assert.throws(()=>store.createJob(p.id,'generation','second-click',{...input,approvalHash:'different'}),/different input/);
  assert.notEqual(store.createJob(p.id,'generation','intentional-new-take',input).id,first.id);
  store.change(p.id,p.revision,current=>applyOps(current,[cameraOp(current)]));
  assert.throws(()=>store.createJob(p.id,'generation','stale-review',input,{baseRevision:p.revision}),/before task submission/);
});

test('lost polling of an accepted paid operation becomes uncertain and cannot create a duplicate',async t=>{
  const {store,p}=storeFixture(t);let submits=0;const provider={submit:async()=>{submits++;return {id:'accepted-paid'};},poll:async()=>{throw Error('network unavailable');}};
  const jobs=new StudioJobs(store,{provider});t.after(()=>jobs.close());const input={shot:p.shots[0]},job=store.createJob(p.id,'generation','accepted-one',input);
  await jobs.step(job.id);store.updateJob(job.id,{}, {pollFailures:120});await jobs.step(job.id);
  assert.equal(store.job(job.id).job.state,'uncertain');assert.equal(store.job(job.id).private.handle.id,'accepted-paid');
  assert.equal(store.createJob(p.id,'generation','retry-click',input).id,job.id);await jobs.step(job.id);assert.equal(submits,1);
});

test('cross-project references fail validation and provider asset resolution before media is sent',async t=>{
  const {store,p}=storeFixture(t),other=store.createProject(createProject()),foreign=store.addAsset(other.id,{name:'foreign.png',kind:'image',mime:'image/png'},PNG).asset;
  const candidate=clone(p);candidate.shots[0].firstAssetId=foreign.id;assert.throws(()=>protectedUpdate(p,candidate),/reference must be an image/);
  candidate.assets.push(foreign);assert.throws(()=>protectedUpdate(p,candidate),/assets are immutable/);
  let sent=false;const jobs=new StudioJobs(store,{provider:{submit:async(input,resolve)=>{await resolve(input.shot.firstAssetId);sent=true;return {id:'must-not-send'};}}});t.after(()=>jobs.close());
  const job=store.createJob(p.id,'generation','foreign-reference',{shot:{...p.shots[0],firstAssetId:foreign.id}});await jobs.step(job.id);assert.equal(sent,false);assert.equal(store.job(job.id).job.state,'failed');
});

test('GLB parts have source-derived IDs, and selected-part edits cannot modify the enclosing object',t=>{
  const metadata=glbMetadata(modelGLB());assert.deepEqual(metadata.partNodes,[{id:'gltf-node-1',nodePath:'/nodes/1',name:'arm'},{id:'gltf-node-2',nodePath:'/nodes/2',name:'hand',parentId:'gltf-node-1'}]);
  assert.throws(()=>glbMetadata(Buffer.from('glTF')),/complete GLB/);
  const {store,p}=storeFixture(t),asset=store.addAsset(p.id,{name:'parts.glb',kind:'model',mime:'model/gltf-binary',metadata},modelGLB()).asset;
  const current=store.getProject(p.id),scene=current.scenes[0],object={id:'model-parts',name:'model',kind:'model',assetId:asset.id,transform:{position:[0,0,0],rotation:[0,0,0,1],scale:[1,1,1]},color:'#ffffff',visible:true,locked:false,parts:metadata.partNodes.map(n=>({id:n.id,transform:{position:[0,0,0],rotation:[0,0,0,1],scale:[1,1,1]},visible:true,locked:false}))};scene.objects.push(object);validateProject(current);
  const context={ai:true,mode:'static',sceneId:scene.id,partSelection:[{objectId:object.id,partId:'gltf-node-1'}]};
  const op={type:'part.update',sceneId:scene.id,objectId:object.id,partId:'gltf-node-1',patch:{color:'#ff0000'}};
  const changed=applyOps(current,[op],context);assert.equal(changed.scenes[0].objects.at(-1).parts[0].color,'#ff0000');assert.equal(changed.scenes[0].objects.at(-1).color,'#ffffff');
  assert.throws(()=>applyOps(current,[{...op,partId:'gltf-node-2'}],context),/outside selected model parts/);
  assert.throws(()=>applyOps(current,[{type:'object.update',sceneId:scene.id,objectId:object.id,patch:{visible:false}}],context),/outside selected model parts/);
  const track={id:'part-motion',targetId:object.id,partId:'gltf-node-1',property:'position',keys:[{frame:12,value:[1,0,0],interpolation:'linear'}]},dynamic={...context,mode:'dynamic',frame:12};
  assert.equal(applyOps(current,[{type:'track.set',sceneId:scene.id,track}],dynamic).scenes[0].tracks[0].partId,'gltf-node-1');
  assert.throws(()=>applyOps(current,[{type:'track.set',sceneId:scene.id,track:{...track,bone:'hip'}}],dynamic),/part track/);
  object.parts[0].locked=true;assert.throws(()=>applyOps(current,[op],context),/part is locked/);assert.throws(()=>applyOps(current,[{type:'track.set',sceneId:scene.id,track}],dynamic),/part is locked/);
  object.parts[0].locked=false;object.parts[0].id='invented-node';assert.throws(()=>validateProject(current),/does not exist in uploaded GLB/);
});

test('explicit provider rejection is failed without paid fallback',async t=>{
  const {store,p}=storeFixture(t);let submits=0;const jobs=new StudioJobs(store,{provider:{submit:async()=>{submits++;throw new SubmissionError('Provider HTTP 400',false);}}});t.after(()=>jobs.close());
  const j=store.createJob(p.id,'generation','rejected',{shot:p.shots[0]});await jobs.step(j.id);await jobs.step(j.id);assert.equal(store.job(j.id).job.state,'failed');assert.equal(submits,1);
});

test('provider step contract transmits first-frame-only mode and checks failure before result_url',async()=>{
  const calls=[];const provider=new StudioProvider({backend:'seedance',baseUrl:'https://provider.test/v1',apiKey:'fixture-key',model:'fixture'},{fetchImpl:async(url,options)=>{calls.push({url,options});return calls.length===1?Response.json({task_id:'t1'}):Response.json({data:{status:'FAILED',result_url:'upstream policy error'}});}});
  const handle=await provider.submit({shot:{prompt:'demo',startFrame:0,endFrame:58,firstAssetId:'first',lastAssetId:'last'},aspect:'16:9'},async()=>({bytes:PNG,mime:'image/png'}));
  assert.equal(handle.referenceMode,'first_frame');assert.match(handle.warning,/not transmitted/);const submitted=JSON.parse(calls[0].options.body);assert.deepEqual(Object.keys(submitted).sort(),['image','model','prompt']);assert.match(submitted.prompt,/--duration 3/);assert.equal(handle.prompt,submitted.prompt);assert.equal(handle.references[0].assetId,'first');assert.equal(handle.ignoredReferences[0].assetId,'last');assert.equal(handle.parameters.requestedFrames,58);assert.equal(handle.parameters.providerDuration,3);assert.equal(handle.actualModel,null);
  assert.equal((await provider.poll(handle)).state,'failed');assert.equal(calls.length,2);
});

test('provider downloads strip authorization on redirects to another origin',async()=>{
  const calls=[];const provider=new StudioProvider({backend:'seedance',baseUrl:'https://provider.test/v1',apiKey:'fixture-key'},{fetchImpl:async(url,options)=>{calls.push({url:String(url),headers:options.headers});return calls.length===1?new Response(null,{status:302,headers:{location:'https://cdn.test/output.mp4'}}):new Response('video');}});
  assert.equal((await provider.download({url:'https://provider.test/video',needsAuth:true},{baseUrl:'https://provider.test/v1',backend:'seedance'})).toString(),'video');
  assert.equal(calls[0].headers.authorization,'Bearer fixture-key');assert.equal(calls[1].headers.authorization,undefined);
});

test('HTTP API authenticates every v3 route, serves exact ranges, enforces review and rejects invalid AI atomically',async t=>{
  const dir=temp(t);let aiResult={message:'bad',ops:[{type:'shell.exec',sceneId:'unknown',command:'no'}]};
  const provider={capabilities:()=>({video:true,llm:true,model:'fixture',referenceMode:'first_frame'}),edit:async()=>aiResult};
  const router=createStudioRouter({dataDir:dir,token:'test-token',provider,startJobs:false});const server=createServer((req,res)=>router.handle(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await router.close();});
  const base=`http://127.0.0.1:${server.address().port}/api/v3`;
  async function call(path,{method='GET',body,headers={}}={}){return fetch(base+path,{method,headers:{authorization:'Bearer test-token',...(body?{'content-type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined});}
  assert.equal((await fetch(base+'/projects')).status,401);
  let p=(await (await call('/projects',{method:'POST',body:{}})).json()).data;
  const upload=await (await call(`/projects/${p.id}/assets`,{method:'POST',body:{name:'frame.png',kind:'image',mime:'image/png',base64:PNG.toString('base64')}})).json();assert.ok(upload.data,JSON.stringify(upload));p=upload.data.project;const asset=upload.data.asset;
  const partial=await call(`/assets/${asset.id}/content`,{headers:{range:'bytes=2-5'}});assert.equal(partial.status,206);assert.deepEqual(Buffer.from(await partial.arrayBuffer()),PNG.subarray(2,6));assert.equal(partial.headers.get('content-range'),`bytes 2-5/${PNG.length}`);
  const suffix=await call(`/assets/${asset.id}/content`,{headers:{range:'bytes=-4'}});assert.deepEqual(Buffer.from(await suffix.arrayBuffer()),PNG.subarray(-4));assert.equal((await call(`/assets/${asset.id}/content`,{headers:{range:'bytes=999-'}})).status,416);
  const saved=clone(p);saved.shots[0].firstAssetId=asset.id;p=(await (await call(`/projects/${p.id}`,{method:'PUT',body:{baseRevision:p.revision,project:saved}})).json()).data;
  const review=(await (await call(`/projects/${p.id}/review`)).json()).data;assert.match(review.html,/data:image\/png;base64/);assert.equal(review.shots.length,5);
  assert.equal((await call(`/projects/${p.id}/shots/${p.shots[0].id}/approve`,{method:'POST',body:{hash:'old'}})).status,409);
  const approved=await call(`/projects/${p.id}/shots/${p.shots[0].id}/approve`,{method:'POST',body:{hash:review.shots[0].hash}});p=(await approved.json()).data;assert.ok(p.shots[0].approval);
  const aiBody={baseRevision:p.revision,prompt:'move camera',sceneId:p.scenes[0].id,selectionIds:[],frame:0,mode:'static',scope:'scene'};
  const bad=await call(`/projects/${p.id}/ai`,{method:'POST',body:aiBody});assert.equal(bad.status,404);assert.equal(router.store.getProject(p.id).revision,p.revision);
  aiResult={message:'bypass dynamic',ops:[],storyboard:{shots:[]}};const dynamic=await call(`/projects/${p.id}/ai`,{method:'POST',body:{...aiBody,scope:'storyboard',mode:'dynamic'}});assert.equal(dynamic.status,422);assert.equal(router.store.getProject(p.id).revision,p.revision);
  aiResult={message:'camera moved',ops:[cameraOp(p)]};const good=await call(`/projects/${p.id}/ai`,{method:'POST',body:aiBody});assert.equal(good.status,200);const changed=(await good.json()).data.project;assert.equal(changed.shots[0].approval,undefined);
  const undone=await call(`/projects/${p.id}/history`,{method:'POST',body:{baseRevision:changed.revision,direction:'undo'}});assert.equal(undone.status,200);assert.deepEqual((await undone.json()).data.scenes[0].cameras[0].position,p.scenes[0].cameras[0].position);
  const modelUpload=await (await call(`/projects/${p.id}/assets`,{method:'POST',body:{name:'parts.glb',kind:'model',mime:'model/gltf-binary',base64:modelGLB().toString('base64'),metadata:{partNodes:[{id:'fake'}],skinCount:999}}})).json();assert.deepEqual(modelUpload.data.asset.metadata.partNodes.map(p=>p.id),['gltf-node-1','gltf-node-2']);assert.equal(modelUpload.data.asset.metadata.skinCount,0);
});
