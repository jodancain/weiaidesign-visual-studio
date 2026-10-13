import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProfessionalMigrationManager,MIGRATION_PREFIX,type MigrationResult} from '../lib/image2/professional-migration';
import {LegacyDocumentMutationManager,getMutationsStorage} from '../lib/image2/legacy-mutations';
import type {SubmissionStorage,SubmissionAttempt} from '../lib/image2/submissions';
import type {ImageDocument} from '../lib/image2/types';
import {T} from '@tldraw/validate';
import {professionalProxyRecords} from '../lib/image2/professional-projection';
class MemoryStorage implements SubmissionStorage {
  values=new Map<string,SubmissionAttempt>();
  async getOrCreate(attempt:SubmissionAttempt){if(!this.values.has(attempt.intent))this.values.set(attempt.intent,structuredClone(attempt));return structuredClone(this.values.get(attempt.intent)!);}
  async list(){return [...this.values.values()].map(value=>structuredClone(value));}
  async remove(intent:string){this.values.delete(intent);}
}
test('copy migration preserves its key across lost response and resumes a single real SQLite copy',async()=>{
  const {ImageStore}=await import(new URL('../services/image2/store.mjs',import.meta.url).href);
  const folder=await mkdtemp(join(tmpdir(),'professional-copy-')),owner=crypto.randomUUID(),storage=new MemoryStorage();let store=new ImageStore(folder),drop=true;
  const original=store.createDocument(owner,{name:'Original',layers:[{id:'group',type:'group',x:-4,y:7,width:40,height:50}]}) as ImageDocument;
  const seen:Record<string,unknown>[]=[];
  const transport=async(_path:string,body:Record<string,unknown>)=>{seen.push(structuredClone(body));const result=store.migrateV3(original.id,owner,body);if(drop){drop=false;throw new Error('lost accepted copy');}return result;};
  try{
    await assert.rejects(new ProfessionalMigrationManager(storage,transport).migrate(original,async()=>{}),/lost accepted/);
    assert.equal((await storage.list()).length,1);assert.ok((await storage.list())[0].intent.startsWith(MIGRATION_PREFIX));
    store.close();store=new ImageStore(folder);let adopted:MigrationResult|undefined;
    await new ProfessionalMigrationManager(storage,transport).recover(original.id,async result=>{adopted=result;});
    assert.equal(adopted?.document.schemaVersion,3);assert.notEqual(adopted?.document.id,original.id);assert.deepEqual(seen[0],seen[1]);
    const proxies=professionalProxyRecords(adopted!.document,'page:page');for(const proxy of proxies){T.jsonValue.validate(proxy.props.layer);T.jsonValue.validate(proxy.meta);}assert.equal(proxies.length,1);
    assert.equal(store.listDocuments(owner).length,2);assert.deepEqual(store.getDocument(original.id,owner),original);assert.equal(adopted?.document.resolution?.dpiX,72);
    assert.equal((await storage.list()).length,0);
    let doc=adopted!.document;doc=store.command(doc.id,owner,{baseRevision:doc.revision,commandId:'name-b',commands:[{type:'document.update',patch:{name:'B edited'}}]});
    const history=new LegacyDocumentMutationManager(getMutationsStorage(storage),async(_path,body)=>store.history(doc.id,owner,body));
    const undone=await history.submit(`/documents/${doc.id}/history`,{documentId:doc.id,direction:'undo'},{baseRevision:doc.revision,direction:'undo'});
    assert.equal(undone.schemaVersion,3);assert.notEqual(undone.name,'B edited');
  }finally{store.close();await rm(folder,{recursive:true,force:true});}
});
test('incomplete or foreign migration receipt keeps the pending copy and never binds it',async()=>{
  const storage=new MemoryStorage(),source={id:'source',schemaVersion:2,revision:4} as ImageDocument;let value:unknown={},bound=0;
  const manager=new ProfessionalMigrationManager(storage,async()=>value);
  for(value of [{},{document:{id:'copy',schemaVersion:3},sourceDocumentId:'wrong',sourceRevision:4,mappings:{},receipt:{}},{document:{id:'source',schemaVersion:3},sourceDocumentId:'source',sourceRevision:4,mappings:{},receipt:{}}]){
    await assert.rejects(manager.migrate(source,async()=>{bound++;}),/回执/);assert.equal((await storage.list()).length,1);
  }
  assert.equal(bound,0);
});
test('copy receipt survives a local bind conflict; definite server rejection releases only that copy',async()=>{
  const storage=new MemoryStorage(),source={id:'source',schemaVersion:2,revision:4} as ImageDocument;
  const result={document:{id:'copy',schemaVersion:3},sourceDocumentId:'source',sourceRevision:4,mappings:{},receipt:{}};
  await assert.rejects(new ProfessionalMigrationManager(storage,async()=>result).migrate(source,async()=>{throw new Error('local draft conflict');}),/local draft/);
  const saved=(await storage.list())[0];assert.ok(saved);
  await assert.rejects(new ProfessionalMigrationManager(storage,async()=>{throw Object.assign(new Error('not owned'),{status:404});}).migrate(source,async()=>{}),/not owned/);
  assert.equal((await storage.list()).length,0);
});
