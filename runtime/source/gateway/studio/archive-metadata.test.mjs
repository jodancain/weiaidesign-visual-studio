import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudioStore } from './store.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createProject } from './domain.mjs';

test('real gateway archives an existing export as FFmpeg without attributing it to an AI provider',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'studio-archive-metadata-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const store=new StudioStore(join(directory,'studio')),project=store.createProject(createProject({demo:false}));
  const job=store.createJob(project.id,'export','already-exported-fixture',{project});
  store.completeJob(job.id,{name:'Preview export.mp4',kind:'video',mime:'video/mp4',source:'export',metadata:{frames:240,fps:24,duration:10}},Buffer.from('synthetic existing export bytes'),{frames:240});
  store.close();
  let resolveReceipt,rejectReceipt,uploads=0;
  const receipt=new Promise((resolve,reject)=>{resolveReceipt=resolve;rejectReceipt=reject;});
  const server=createServer(async(req,res)=>{
    try{
      uploads++;assert.equal(req.url,'/api/v1/videos/upload');assert.equal(req.headers.authorization,'Bearer synthetic-nas-capability');
      const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks).toString();
      const field=name=>body.match(new RegExp('name="'+name+'"\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--'))?.[1];
      const metadata=JSON.parse(field('metadata'));assert.equal(field('source_task_id'),job.id);
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({status:200,data:{id:'synthetic-nas-record',source_task_id:job.id,kind:'studio-v3-video',stored_name:'preview.mp4',size:Buffer.byteLength('synthetic existing export bytes'),metadata}}));
      resolveReceipt(metadata);
    }catch(error){res.writeHead(500);res.end();rejectReceipt(error);}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const config=join(directory,'config.toml');writeFileSync(config,'openai_model_name = "fixture"\n');
  const child=spawn(process.execPath,[fileURLToPath(new URL('../node-gateway.mjs',import.meta.url))],{env:{PATH:process.env.PATH,PORT:'0',NODE_NO_WARNINGS:'1',MPT_CONFIG_PATH:config,MPT_LOCAL_VIDEO_DIR:join(directory,'legacy'),STUDIO_DATA_DIR:join(directory,'studio'),VIDEO_API_TOKEN:'synthetic-api-capability',VIDEO_STORAGE_BASE_URL:'http://127.0.0.1:'+server.address().port,VIDEO_STORAGE_TOKEN:'synthetic-nas-capability'},stdio:['ignore','ignore','pipe']});
  child.once('error',rejectReceipt);
  t.after(async()=>{if(child.exitCode===null){const exit=once(child,'exit');child.kill('SIGTERM');await exit;}await new Promise(resolve=>server.close(resolve));});
  const timeout=setTimeout(()=>rejectReceipt(Error('Gateway did not archive the existing completed export')),15000);
  let metadata;try{metadata=await receipt;}finally{clearTimeout(timeout);}
  assert.equal(metadata.provider,'ffmpeg');assert.equal(metadata.archived_by,'studio-v3');assert.equal(metadata.studioJobKind,'export');assert.equal(metadata.studioProjectId,project.id);assert.equal(metadata.frames,240);assert.equal(uploads,1);
  const reader=new DatabaseSync(join(directory,'studio','studio.sqlite'),{readOnly:true});t.after(()=>reader.close());
  let saved;for(let i=0;i<100;i++){saved=JSON.parse(reader.prepare('SELECT json FROM jobs WHERE id=?').get(job.id).json);if(saved.output?.archive?.state==='complete')break;await new Promise(resolve=>setTimeout(resolve,20));}
  assert.equal(saved.state,'complete');assert.equal(saved.output.archive.state,'complete');assert.equal(saved.output.archive.bytes,Buffer.byteLength('synthetic existing export bytes'));
});
