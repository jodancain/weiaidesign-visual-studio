import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyLegacyDraft, cloneLegacyDraft, createLegacyCanvasDraft, matchesLegacyDraft } from '../lib/image2/legacy-drafts';

const input = () => ({ projectId:'original-project',documentId:'server-document',baseRevision:7,snapshot:{store:{'shape:original':{id:'shape:original',type:'image',x:-120,y:33,props:{src:'data:image/png;base64,fixture'}}}},frozenRequests:[{path:'/operations',intent:'stable-intent',idempotencyKey:'stable-key',body:{documentId:'server-document',baseRevision:7,operation:'erase',idempotencyKey:'stable-key',targetLayerId:'original-layer'}}] });

test('draft capture freezes native coordinates and request identity before asynchronous work', () => {
  const original=input(), draft=createLegacyCanvasDraft(original);
  original.snapshot.store['shape:original'].x=600;
  original.frozenRequests[0].body.baseRevision=8;
  original.frozenRequests[0].idempotencyKey='new-key';
  assert.equal((draft.snapshot.store['shape:original'] as {x:number}).x,-120);
  assert.equal(draft.frozenRequests?.[0].body.baseRevision,7);
  assert.equal(draft.frozenRequests?.[0].idempotencyKey,'stable-key');
  assert.equal(draft.frozenRequests?.[0].body.idempotencyKey,'stable-key');
});

test('same-revision recovery resumes; changed or unknown document state preserves a conflict draft', () => {
  const draft=createLegacyCanvasDraft(input());
  assert.equal(classifyLegacyDraft(undefined,{id:draft.documentId,revision:7}),'none');
  assert.equal(classifyLegacyDraft(draft,{id:draft.documentId,revision:7}),'resume');
  assert.equal(classifyLegacyDraft(draft,{id:draft.documentId,revision:8}),'revision_conflict');
  assert.equal(classifyLegacyDraft(draft,{id:draft.documentId,revision:6}),'revision_conflict');
  assert.equal(classifyLegacyDraft(draft,{id:'different-document',revision:7}),'document_mismatch');
  assert.equal(draft.baseRevision,7);assert.equal(draft.frozenRequests?.[0].body.baseRevision,7);
});

test('an older acknowledgement cannot match and erase a newer native edit', () => {
  const old=createLegacyCanvasDraft(input()), fresh=createLegacyCanvasDraft(input());
  assert.ok(fresh.savedAt>old.savedAt);
  assert.equal(matchesLegacyDraft(old,old),true);
  assert.equal(matchesLegacyDraft(fresh,old),false);
  assert.equal(matchesLegacyDraft({...old,baseRevision:8},old),false);
  assert.equal(matchesLegacyDraft({...old,documentId:'other'},old),false);
});

test('invalid draft metadata is rejected before writing durable storage', () => {
  const draft=createLegacyCanvasDraft(input());
  for(const patch of [{baseRevision:-1},{baseRevision:1.5},{documentId:''},{projectId:''},{savedAt:NaN},{snapshot:{store:[]}}]) assert.throws(()=>cloneLegacyDraft({...draft,...patch} as never));
});
