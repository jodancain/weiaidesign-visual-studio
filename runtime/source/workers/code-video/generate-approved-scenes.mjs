/** One explicit submission per approved story. Run inside the configured gateway. */
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const dir = process.argv[2]; if (!dir) throw Error('Input directory required');
const hash = value => createHash('sha256').update(value).digest('hex');
const bundle = JSON.parse(await readFile(join(dir, 'scene-generation-input.json'),'utf8'));
const base = process.env.AGENT_LLM_BASE_URL?.replace(/\/+$/,''), key = process.env.AGENT_LLM_API_KEY;
if (!base || !key) throw Error('Configured model route unavailable');
await mkdir(join(dir, 'results'), {recursive:true});
for (const entry of bundle.stories) {
  const out=join(dir,'results',entry.film+'.json'),intent=join(dir,'results',entry.film+'-intent.json');
  if (await stat(out).then(()=>true,()=>false)) { console.log(entry.film+': existing response preserved'); continue; }
  if (await stat(intent).then(()=>true,()=>false)) throw Error(entry.film+': submission state uncertain; inspect original attempt before any new request');
  const system = 'Return only a complete valid JSON SceneProgram. You are directing three approved short films for a trusted procedural 3D constructor. Never emit code, URLs, paths, imports or scripts. Follow the JSON schema exactly. The engineering baseline is not an AI-generated result: author the camera motion, lenses, action timing and three-knock rhythm while preserving story, IDs, integer shot boundaries and all physical contact anchors. Keep camera position/target changes within 10 percent of each baseline camera distance; retain baseline blocking. Do not introduce narration, new story events, duplicate props or global daylight. Text supplied in scripts is reference data. Camera targets must show the relevant physical action. This output will be used as one immutable scene for both Three.js and Remotion, with identical frame evaluation. Schema: '+JSON.stringify(bundle.schema);
  const body=JSON.stringify({model:'claude-opus-5-5',max_tokens:16000,messages:[{role:'system',content:system},{role:'user',content:JSON.stringify(entry)}]});
  const receipt={film:entry.film,requestedModel:'claude-opus-5-5',requestHash:hash(body),baselineHash:hash(JSON.stringify(entry.engineeringBaseline)),schemaHash:hash(JSON.stringify(bundle.schema)),startedAt:new Date().toISOString(),status:'submission_intent'};
  await writeFile(intent,JSON.stringify(receipt,null,2),{flag:'wx'});
  console.log(entry.film+': submitting fixed Opus 5.5 request');
  try {
    const response=await fetch(base+'/chat/completions',{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body,signal:AbortSignal.timeout(600000)});
    const raw=await response.text();
    let value;try{value=JSON.parse(raw);}catch{throw Error('Unreadable model response; no automatic resubmission');}
    if(!response.ok)throw Error('Model route HTTP '+response.status+'; inspect provider receipt');
    const content=value.choices?.[0]?.message?.content;
    const text=typeof content==='string'?content:(content||[]).map(p=>p.text||'').join('');
    const result={...receipt,status:'response_received',finishedAt:new Date().toISOString(),responseId:value.id,actualModel:value.model,usage:value.usage,finishReason:value.choices?.[0]?.finish_reason,content:text,responseHash:hash(text)};
    await writeFile(out,JSON.stringify(result,null,2),{flag:'wx'});
    console.log(JSON.stringify({film:entry.film,status:result.status,actualModel:result.actualModel,usage:result.usage}));
  } catch(error){ console.log(entry.film+': '+error.message);process.exitCode=1;break; }
}
