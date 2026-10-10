/** Run in two separate, network-disabled Node containers sharing only /data/studio. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { StudioStore } from './store.mjs';
import { createProject, applyOps, digest, shotHash } from './domain.mjs';
import { createStudioRouter } from './router.mjs';

const mode=process.argv[2],directory=process.env.STUDIO_DATA_DIR||'/data/studio';
const markerPath=join(directory,'container-acceptance.json');
const bytes=Buffer.from('immutable-container-persistence-fixture');
const token='isolated-container-test-capability';
if(mode==='seed'){
  const store=new StudioStore(directory);let p=store.createProject(createProject({name:'isolated container persistence',demo:true}));
  const asset=store.addAsset(p.id,{name:'fixture.png',kind:'image',mime:'image/png'},bytes).asset;
  p=store.getProject(p.id);const scene=p.scenes[0],op={type:'camera.update',sceneId:scene.id,cameraId:scene.activeCameraId,patch:{position:[2,3,6]}};
  p=store.change(p.id,p.revision,c=>applyOps(c,[op]),{commandId:'container-command',request:{ops:[op]}});
  p=store.change(p.id,p.revision,c=>{c.shots[0].approval={hash:shotHash(c,c.shots[0]),at:new Date().toISOString()};return c;},{undoable:false});
  const accepted=store.createJob(p.id,'generation','accepted-provider',{fixture:'accepted'});
  assert.equal(store.createJob(p.id,'generation','accepted-alias',{fixture:'accepted'}).id,accepted.id);
  store.updateJob(accepted.id,{state:'running',progress:.2},{phase:'accepted',handle:{id:'accepted-fixture-operation',backend:'fixture'}});
  const ambiguous=store.createJob(p.id,'generation','interrupted-provider',{fixture:'ambiguous'});
  store.updateJob(ambiguous.id,{state:'running'},{phase:'submitting'});
  writeFileSync(markerPath,JSON.stringify({projectId:p.id,assetId:asset.id,assetHash:digest(bytes),revision:p.revision,acceptedId:accepted.id,ambiguousId:ambiguous.id,op}));
  const schemaVersion=store.db.prepare('PRAGMA user_version').get().user_version;assert.equal(schemaVersion,2);store.close();
  console.log(JSON.stringify({phase:'seed',passed:true,schemaVersion,projectId:p.id,revision:p.revision,assets:1,jobRecords:2,containerHostname:process.env.HOSTNAME||null}));
}else if(mode==='restore'){
  const expected=JSON.parse(readFileSync(markerPath,'utf8'));
  const provider={capabilities:()=>({video:false,llm:false,model:'fixture-disabled',referenceMode:'first_frame'})};
  const router=createStudioRouter({dataDir:directory,token,provider,startJobs:false});
  const p=router.store.getProject(expected.projectId);assert.equal(p.revision,expected.revision);assert.equal(p.shots[0].approval.hash,shotHash(p,p.shots[0]));
  assert.equal(digest(router.store.assetBytes(expected.assetId)),expected.assetHash);
  assert.equal(router.store.job(expected.acceptedId).private.handle.id,'accepted-fixture-operation');assert.equal(router.store.job(expected.acceptedId).job.state,'running');
  const schemaVersion=router.store.db.prepare('PRAGMA user_version').get().user_version;assert.equal(schemaVersion,2);
  router.store.updateJob(expected.acceptedId,{state:'complete'},{phase:'complete'});
  assert.equal(router.store.createJob(p.id,'generation','accepted-alias',{fixture:'accepted'}).id,expected.acceptedId);
  assert.equal(router.store.job(expected.ambiguousId).job.state,'uncertain');
  const undo=router.store.history(p.id,p.revision,'undo');assert.deepEqual(undo.scenes[0].cameras[0].position,[0,2,6]);assert.equal(undo.assets[0].id,expected.assetId);
  const redo=router.store.history(p.id,undo.revision,'redo');assert.deepEqual(redo.scenes[0].cameras[0].position,[2,3,6]);
  const duplicate=router.store.change(p.id,0,()=>{throw Error('duplicate command replayed');},{commandId:'container-command',request:{ops:[expected.op]}});assert.equal(duplicate.revision,redo.revision);
  const server=createServer((req,res)=>router.handle(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const base=`http://127.0.0.1:${server.address().port}/api/v3`;
    assert.equal((await fetch(`${base}/projects`)).status,401);
    const response=await fetch(`${base}/assets/${expected.assetId}/content`,{headers:{authorization:`Bearer ${token}`,range:'bytes=2-8'}});
    assert.equal(response.status,206);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes.subarray(2,9));
    console.log(JSON.stringify({phase:'restore',passed:true,schemaVersion,projectId:p.id,restoredRevision:p.revision,afterUndoRedoRevision:redo.revision,assetHashVerified:true,rangeVerified:true,authenticationVerified:true,acceptedIdPreserved:true,completedAliasPreserved:true,ambiguousMarkedUncertain:true,duplicateCommandNotReplayed:true,containerHostname:process.env.HOSTNAME||null}));
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await router.close();}
}else throw new Error('usage: node container-persistence.mjs seed|restore');
