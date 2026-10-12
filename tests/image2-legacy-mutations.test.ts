import test from 'node:test';
import assert from 'node:assert/strict';
import { getMutationsStorage, LEGACY_MUTATION_PREFIX, LegacyDocumentMutationManager } from '../lib/image2/legacy-mutations';
import type { SubmissionAttempt, SubmissionStorage } from '../lib/image2/submissions';
import type { ImageDocument } from '../lib/image2/types';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

class MemorySubmissions implements SubmissionStorage {
  records=new Map<string,SubmissionAttempt>();
  async getOrCreate(proposed:SubmissionAttempt){if(!this.records.has(proposed.intent))this.records.set(proposed.intent,structuredClone(proposed));return structuredClone(this.records.get(proposed.intent)!);}
  async remove(intent:string){this.records.delete(intent);}
  async list(){return [...this.records.values()].map(attempt=>structuredClone(attempt));}
}
const document = (revision:number):ImageDocument => ({id:'original-doc',name:'Original',schemaVersion:2,revision,width:500,height:400,layers:[],assetIds:[],createdAt:0,updatedAt:0});
const path='/documents/original-doc/history',intent={documentId:'original-doc',direction:'undo' as const};

test('lost undo response preserves first baseRevision and commandId after the server advances',async()=>{
  const base=new MemorySubmissions(),storage=getMutationsStorage(base),seen:Record<string,unknown>[]=[],receipts=new Map<string,ImageDocument>();let serverRevision=7,commits=0;
  const transport=async(_path:string,body:Record<string,unknown>)=>{seen.push(structuredClone(body));const id=String(body.commandId);if(!receipts.has(id)){assert.equal(body.baseRevision,serverRevision);serverRevision++;commits++;receipts.set(id,document(serverRevision));throw new Error('lost after commit');}return document(serverRevision);};
  await assert.rejects(new LegacyDocumentMutationManager(storage,transport).submit(path,intent,{baseRevision:7,direction:'undo',commandId:'frozen-undo'}),/lost/);
  serverRevision=9;
  const result=await new LegacyDocumentMutationManager(storage,transport).submit(path,intent,{baseRevision:9,direction:'undo',commandId:'must-not-replace'});
  assert.equal(result.revision,9);assert.deepEqual(seen[0],seen[1]);assert.equal(seen[1].commandId,'frozen-undo');assert.equal(commits,1);assert.equal((await storage.list()).length,0);
});

test('malformed/wrong-document/stale acknowledgements retain the frozen accept request',async()=>{
  const storage=getMutationsStorage(new MemorySubmissions());let result:unknown={};
  const manager=new LegacyDocumentMutationManager(storage,async()=>result),submit=()=>manager.submit('/documents/original-doc/accept',{documentId:'original-doc',branchId:'candidate'},{baseRevision:7,branchDocumentId:'candidate',commandId:'accept-once'});
  for(result of [{},{...document(8),id:'foreign-doc'},document(6),{...document(8),layers:null}]){await assert.rejects(submit(),/回执/);assert.equal((await storage.list()).length,1);}
  result={document:document(8)};assert.equal((await submit()).revision,8);assert.equal((await storage.list()).length,0);
});

test('duplicate clicks share one in-flight mutation while a later successful user action is distinct',async()=>{
  const storage=getMutationsStorage(new MemorySubmissions());let resolve!:(value:unknown)=>void,calls=0;
  const manager=new LegacyDocumentMutationManager(storage,async()=>{calls++;return new Promise(done=>{resolve=done;});});
  const first=manager.submit(path,intent,{baseRevision:7,direction:'undo'}),second=manager.submit(path,intent,{baseRevision:99,direction:'undo'});
  await new Promise(done=>setTimeout(done,0));assert.equal(calls,1);resolve(document(8));assert.deepEqual(await first,await second);
  const redo=manager.submit(path,{documentId:'original-doc',direction:'redo'},{baseRevision:8,direction:'redo'});
  await new Promise(done=>setTimeout(done,0));assert.equal(calls,2);resolve(document(9));assert.equal((await redo).revision,9);
});

test('recovery filters its namespace/document and preserves exact stored mutation bodies',async()=>{
  const base=new MemorySubmissions(),storage=getMutationsStorage(base),seen:Record<string,unknown>[]=[],manager=new LegacyDocumentMutationManager(storage,async()=>{throw new Error('offline');});
  await base.getOrCreate({intent:'paid-job',path:'/operations',documentId:'original-doc',body:{idempotencyKey:'paid-stays'},createdAt:0});
  await assert.rejects(manager.submit(path,intent,{baseRevision:7,direction:'undo',commandId:'resume-command'}),/offline/);
  const saved=(await manager.pending('original-doc'))[0];assert.ok(saved.intent.startsWith(LEGACY_MUTATION_PREFIX));assert.equal((await manager.pending('other')).length,0);
  await new LegacyDocumentMutationManager(storage,async(_path,body)=>{seen.push(body);return document(8);}).recover('original-doc',doc=>assert.equal(doc.revision,8));
  assert.deepEqual(seen,[saved.body]);assert.equal((await storage.list()).length,0);assert.equal((await base.list())[0].intent,'paid-job');
});

test('definite rejection releases the intent; unknown timeout does not; contradictory mutations are rejected locally',async()=>{
  const storage=getMutationsStorage(new MemorySubmissions());let status=408;
  const manager=new LegacyDocumentMutationManager(storage,async()=>{throw Object.assign(new Error('request outcome'),{status});});
  await assert.rejects(manager.submit(path,intent,{baseRevision:7,direction:'undo'}));assert.equal((await storage.list()).length,1);
  status=409;await assert.rejects(manager.submit(path,intent,{baseRevision:7,direction:'undo'}));assert.equal((await storage.list()).length,0);
  await assert.rejects(manager.submit(path,intent,{baseRevision:7,direction:'redo'}),/不一致/);
  await assert.rejects(manager.submit('/documents/other/history',intent,{baseRevision:7,direction:'undo'}),/目标/);
});

test('real SQLite history and branch receipts survive a lost acknowledgement without executing twice',async()=>{
  const {ImageStore}=await import(new URL('../services/image2/store.mjs',import.meta.url).href);
  const directory=await mkdtemp(join(tmpdir(),'image2-legacy-mutation-')),store=new ImageStore(directory),owner=crypto.randomUUID(),storage=getMutationsStorage(new MemorySubmissions());
  const seen:Record<string,unknown>[]=[];let dropped=true;
  const transport=async(route:string,body:Record<string,unknown>)=>{seen.push(structuredClone(body));const id=route.split('/')[2],result=route.endsWith('/history')?store.history(id,owner,body):store.acceptBranch(id,owner,body);if(dropped){dropped=false;throw new Error('lost real receipt');}return result;};
  try{
    let live=store.createDocument(owner,{layers:[{id:'native-group',type:'group',x:0,y:0,width:20,height:20}]});
    live=store.command(live.id,owner,{baseRevision:0,commandId:'move-one',commands:[{type:'layer.update',layerId:'native-group',patch:{x:10}}]});
    live=store.command(live.id,owner,{baseRevision:1,commandId:'move-two',commands:[{type:'layer.update',layerId:'native-group',patch:{x:20}}]});
    const historyPath=`/documents/${live.id}/history`,historyIntent={documentId:live.id,direction:'undo' as const};
    await assert.rejects(new LegacyDocumentMutationManager(storage,transport).submit(historyPath,historyIntent,{baseRevision:2,direction:'undo',commandId:'real-undo'}),/lost real/);
    live=store.getDocument(live.id,owner);assert.equal(live.revision,3);assert.equal(live.layers[0].x,10);
    live=store.command(live.id,owner,{baseRevision:3,commandId:'later-name',commands:[{type:'document.update',patch:{name:'after lost receipt'}}]});
    const recovered=await new LegacyDocumentMutationManager(storage,transport).submit(historyPath,historyIntent,{baseRevision:4,direction:'undo',commandId:'should-not-undo-again'});
    assert.equal(recovered.revision,4);assert.equal(recovered.name,'after lost receipt');assert.equal(recovered.layers[0].x,10);assert.deepEqual(seen[0],seen[1]);
    const branch=store.createBranch(live.id,owner,{baseRevision:4});store.command(branch.id,owner,{baseRevision:0,commandId:'candidate',commands:[{type:'layer.update',layerId:'native-group',patch:{y:15}}]});
    dropped=true;const acceptPath=`/documents/${live.id}/accept`,acceptIntent={documentId:live.id,branchId:branch.id};
    await assert.rejects(new LegacyDocumentMutationManager(storage,transport).submit(acceptPath,acceptIntent,{baseRevision:4,branchDocumentId:branch.id,commandId:'real-accept'}),/lost real/);
    const accepted=await new LegacyDocumentMutationManager(storage,transport).submit(acceptPath,acceptIntent,{baseRevision:5,branchDocumentId:branch.id,commandId:'should-not-accept-again'});
    assert.equal(accepted.revision,5);assert.equal(accepted.layers[0].y,15);assert.deepEqual(seen[2],seen[3]);assert.equal((await storage.list()).length,0);
  }finally{store.close();await rm(directory,{recursive:true,force:true});}
});
