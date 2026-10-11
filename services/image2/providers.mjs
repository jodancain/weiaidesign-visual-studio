import {randomUUID} from 'node:crypto';

export class ProviderError extends Error {
  constructor(message,{code='UPSTREAM',status=502,uncertain=false,retryable=false}={}){super(message);Object.assign(this,{code,status,uncertain,retryable});}
}
const GPT_FRAME_MODELS=new Set(['gpt-image-1','gpt-image-1-mini','gpt-image-1.5','gpt-image-2','gpt-image-2.5-flare','gpt-image-2.5-sunburst']);
export function imageFrameFor(model,width,height,c={}){
  const known=GPT_FRAME_MODELS.has(model);
  const frames=c.imageFrames?.[model]||(known?[{width:1024,height:1024},{width:1536,height:1024},{width:1024,height:1536}]:null);
  if(!Array.isArray(frames)||!frames.length)throw new ProviderError('Inpaint size support is not configured for this model',{code:'INPAINT_SIZE_UNSUPPORTED',status:400});
  for(const f of frames)if(!Number.isInteger(f.width)||!Number.isInteger(f.height)||f.width<16||f.height<16||f.width>4096||f.height>4096)throw new ProviderError('Invalid model frame configuration',{code:'INPAINT_SIZE_UNSUPPORTED',status:400});
  return [...frames].sort((a,b)=>Math.abs(Math.log(a.width/a.height/(width/height)))-Math.abs(Math.log(b.width/b.height/(width/height))))[0];
}
export function configFromEnv(env=process.env){
  return {
    imageBaseUrl:(env.IMAGE_OPENAI_BASE_URL||'').replace(/\/+$/,''),imageApiKey:env.IMAGE_OPENAI_API_KEY||env.OPENAI_API_KEY||'',
    imageModel:env.IMAGE_OPENAI_MODEL||'gpt-image-2',imageQuality:env.IMAGE_OPENAI_QUALITY||'medium',imageTimeoutMs:Number(env.IMAGE_OPENAI_TIMEOUT_SECONDS||300)*1000,
    comfyBaseUrl:(env.GPU_COMFY_BASE_URL||'').replace(/\/+$/,''),comfyToken:env.GPU_COMFY_TOKEN||'',comfyTimeoutMs:Number(env.GPU_COMFY_TIMEOUT_SECONDS||120)*1000,
    comfyPollMs:Number(env.GPU_COMFY_POLL_INTERVAL_MS||1500),comfyPollAttempts:Number(env.GPU_COMFY_POLL_ATTEMPTS||120),
    srModels:{2:env.IMAGE2_SR_MODEL_X2||'RealESRGAN_x2plus.pth',4:env.IMAGE2_SR_MODEL_X4||'RealESRGAN_x4plus.pth'},
    ocrUrl:(env.IMAGE2_OCR_URL||'').replace(/\/+$/,''),ocrToken:env.IMAGE2_OCR_TOKEN||'',ocrTimeoutMs:Number(env.IMAGE2_OCR_TIMEOUT_SECONDS||120)*1000,
  };
}
function config(ctx){return {...configFromEnv(),...ctx.config,srModels:{...configFromEnv().srModels,...ctx.config?.srModels}};}
async function timedFetch(ctx,url,options={},timeoutMs=120000){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{return await (ctx.fetchImpl||fetch)(url,{...options,signal:controller.signal});}finally{clearTimeout(timer);}
}
async function jsonResponse(response){
  const value=await response.json().catch(()=>null);
  if(!response.ok)throw new ProviderError(`Provider HTTP ${response.status}`,{status:502,code:'UPSTREAM_HTTP'});
  if(!value)throw new ProviderError('Provider returned invalid JSON');return value;
}
function cancelled(ctx){if(ctx.cancelled?.())throw new ProviderError('Operation cancelled',{status:409,code:'CANCELLED'});}
const sleep=(ms)=>new Promise(r=>setTimeout(r,Math.max(0,ms)));
function downloadURL(value,base){
  const u=new URL(value,base),b=new URL(base);
  if(u.username||u.password||!['https:','http:'].includes(u.protocol))throw new ProviderError('Unsafe output URL');
  if(u.origin!==b.origin&&(u.protocol!=='https:'||/^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[|172\.(1[6-9]|2\d|3[01])\.)/i.test(u.hostname)))throw new ProviderError('Unsafe output host');
  return u.href;
}
export async function providerCapabilities(c={},fetchImpl=fetch){
  const cfg={...configFromEnv(),...c};const result={generate:{configured:Boolean(cfg.imageBaseUrl&&cfg.imageApiKey),ready:Boolean(cfg.imageBaseUrl&&cfg.imageApiKey),readiness:'configuration-only'},inpaint:{configured:Boolean(cfg.imageBaseUrl&&cfg.imageApiKey),ready:Boolean(cfg.imageBaseUrl&&cfg.imageApiKey),readiness:'configuration-only'}};
  try{imageFrameFor(cfg.imageModel,1,1,cfg);}catch{result.inpaint.ready=false;result.inpaint.reason='Model-specific inpaint size support is unavailable';}
  for(const op of ['matting','segment','super_resolution'])result[op]={configured:Boolean(cfg.comfyBaseUrl),ready:false};
  result.ocr={configured:Boolean(cfg.ocrUrl),ready:false};
  if(cfg.comfyBaseUrl){
    try{
      const nodes=await jsonResponse(await timedFetch({fetchImpl},`${cfg.comfyBaseUrl}/object_info`,{headers:cfg.comfyToken?{authorization:`Bearer ${cfg.comfyToken}`}:{ }},5000));
      result.matting.ready=Boolean(nodes.BiRefNetRMBG&&nodes.LoadImage&&nodes.SaveImage);
      result.segment.ready=Boolean(nodes.DownloadAndLoadSAM2Model&&nodes.Sam2AutoSegmentation&&nodes.MaskToImage&&nodes.SaveImage);
      const choices=nodes.UpscaleModelLoader?.input?.required?.model_name?.[0];
      const models={...configFromEnv().srModels,...cfg.srModels};
      result.super_resolution.ready=Boolean(nodes.ImageUpscaleWithModel&&Array.isArray(choices)&&Object.values(models).every(m=>choices.includes(m)));
      result.super_resolution.scales=[2,4].filter(s=>Array.isArray(choices)&&choices.includes(models[s]));
      // object_info verifies node/model menu presence; inference readiness is a separate gate.
      for(const op of ['matting','segment','super_resolution'])result[op].readiness='node-catalog-only';
    }catch{for(const op of ['matting','segment','super_resolution'])result[op].reason='ComfyUI unavailable';}
  }
  if(cfg.ocrUrl){try{const h=await jsonResponse(await timedFetch({fetchImpl},`${cfg.ocrUrl}/health`,{headers:cfg.ocrToken?{authorization:`Bearer ${cfg.ocrToken}`}:{ }},5000));result.ocr.ready=h.ready===true;result.ocr.model=h.models;result.ocr.reason=h.reason; }catch{result.ocr.reason='OCR worker unavailable';}}
  result.restore_layers={configured:true,ready:true,degraded:!result.ocr.ready||!result.segment.ready,ocr:result.ocr.ready,segment:result.segment.ready};
  return result;
}
export async function requestOCR(bytes,ctx){
  const cfg=config(ctx);if(!cfg.ocrUrl)throw new ProviderError('OCR worker is not configured',{code:'UNAVAILABLE',status:503});
  const headers={'content-type':'application/json',...(cfg.ocrToken?{authorization:`Bearer ${cfg.ocrToken}`}:{})};
  const health=await jsonResponse(await timedFetch(ctx,`${cfg.ocrUrl}/health`,{headers},5000));
  if(health.ready!==true)throw new ProviderError('OCR model is not prepared',{code:'UNAVAILABLE',status:503});
  cancelled(ctx);
  const data=await jsonResponse(await timedFetch(ctx,`${cfg.ocrUrl}/ocr`,{method:'POST',headers,body:JSON.stringify({image:Buffer.from(bytes).toString('base64')})},cfg.ocrTimeoutMs));
  if(!Array.isArray(data.items))throw new ProviderError('OCR response has no items');
  return data;
}
export async function generateImages(request,ctx){
  const cfg=config(ctx),p=request.params||{};
  if(!cfg.imageBaseUrl||!cfg.imageApiKey)throw new ProviderError('Image model is not configured',{code:'UNAVAILABLE',status:503});
  if(!String(p.prompt||'').trim()||String(p.prompt).length>30000)throw new ProviderError('A bounded prompt is required',{code:'INVALID_PARAMS',status:400});
  if(p.n!=null&&(!Number.isInteger(Number(p.n))||Number(p.n)<1||Number(p.n)>4))throw new ProviderError('n must be an integer in 1..4',{code:'INVALID_PARAMS',status:400});
  const suppliedBase=request.inputs?.find(i=>i.role==='base')?.assetId;
  if(!request.base&&suppliedBase)request={...request,base:await ctx.getAsset(suppliedBase)};
  const prior=ctx.providerReceipt;
  if(prior?.provider==='image'&&prior.phase==='submitting')throw new ProviderError('Previous generation acceptance is unknown; do not resubmit',{uncertain:true,code:'UNKNOWN_ACCEPTANCE'});
  let data=prior?.provider==='image'&&prior.phase==='received'?prior.response:null;
  if(!data){
    cancelled(ctx);
    const receipt={provider:'image',phase:'submitting',requestId:request.idempotencyKey||randomUUID(),startedAt:new Date().toISOString()};
    const headers={authorization:`Bearer ${cfg.imageApiKey}`};
    let body,path;
    const references=[];
    for(const ref of request.inputs||[])if(['reference','style','identity'].includes(ref.role)){const a=await ctx.getAsset(ref.assetId);references.push(a);}
    if(references.length+(request.base?1:0)>6)throw new ProviderError('At most six image references are supported',{code:'INVALID_PARAMS',status:400});
    if(request.base||references.length){
      const {decodeRGBA,encodePNG}=await import('./processors.mjs');
      const normalize=async a=>{const decoded=await decodeRGBA(a.bytes,a.asset.mime);return {...a,bytes:await encodePNG(decoded),asset:{...a.asset,mime:'image/png',width:decoded.width,height:decoded.height}};};
      if(request.base)request={...request,base:await normalize(request.base)};
      for(let i=0;i<references.length;i++)references[i]=await normalize(references[i]);
    }
    if(request.base||references.length){
      const form=new FormData();form.set('model',p.model||cfg.imageModel);form.set('prompt',String(p.prompt||''));form.set('quality',p.quality||cfg.imageQuality);form.set('output_format','png');form.set('n',String(Math.max(1,Math.min(4,Number(p.n)||1))));
      if(request.base)form.append('image[]',new Blob([request.base.bytes],{type:request.base.asset.mime}),'base.png');
      for(let i=0;i<references.length;i++)form.append('image[]',new Blob([references[i].bytes],{type:references[i].asset.mime}),`reference_${i}.png`);
      if(request.maskBytes)form.set('mask',new Blob([request.maskBytes],{type:'image/png'}),'mask.png');
      if(request.base&&request.operation==='inpaint')form.set('size',`${request.base.asset.width}x${request.base.asset.height}`);
      else if(p.width&&p.height)form.set('size',`${p.width}x${p.height}`);
      body=form;path='/images/edits';
    }else{
      headers['content-type']='application/json';path='/images/generations';body=JSON.stringify({model:p.model||cfg.imageModel,prompt:String(p.prompt||''),quality:p.quality||cfg.imageQuality,output_format:'png',n:Math.max(1,Math.min(4,Number(p.n)||1)),...(p.width&&p.height?{size:`${p.width}x${p.height}`}:{})});
    }
    cancelled(ctx);
    await ctx.checkpoint({providerReceipt:receipt});
    let response;
    try{response=await timedFetch(ctx,cfg.imageBaseUrl+path,{method:'POST',headers,body},cfg.imageTimeoutMs);}catch{throw new ProviderError('Generation request outcome is unknown; original retained',{uncertain:true,code:'UNKNOWN_ACCEPTANCE'});}
    if(!response.ok){
      if(response.status>=500)throw new ProviderError(`Generation HTTP ${response.status}; acceptance cannot be proven`,{uncertain:true,code:'UNKNOWN_ACCEPTANCE'});
      await ctx.checkpoint({providerReceipt:{...receipt,phase:'rejected',httpStatus:response.status}});
      throw new ProviderError(`Generation rejected (HTTP ${response.status})`,{code:'GENERATION_REJECTED'});
    }
    data=await response.json().catch(()=>null);
    if(!Array.isArray(data?.data)||!data.data.length)throw new ProviderError('Accepted response is missing image receipt',{uncertain:true,code:'UNKNOWN_ACCEPTANCE'});
    await ctx.checkpoint({providerReceipt:{...receipt,phase:'received',response:data}});
  }
  const outputs=[];
  for(const item of data.data){
    cancelled(ctx);let bytes;
    if(item.b64_json)bytes=Buffer.from(item.b64_json,'base64');
    else if(item.url){const r=await timedFetch(ctx,downloadURL(item.url,cfg.imageBaseUrl),{},cfg.imageTimeoutMs);if(!r.ok)throw new ProviderError('Generated output download failed');bytes=Buffer.from(await r.arrayBuffer());}
    else throw new ProviderError('Image receipt contains no image');
    if(!bytes.length||bytes.length>64*1024*1024)throw new ProviderError('Generated image size exceeds budget');
    outputs.push({bytes,mime:'image/png',metadata:{provider:'image',model:p.model||cfg.imageModel,revisedPrompt:item.revised_prompt}});
  }
  return outputs;
}
function workflow(op,name,p,cfg,base){
  const w={'1':{class_type:'LoadImage',inputs:{image:name}}};
  if(op==='matting'){
    w['2']={class_type:'BiRefNetRMBG',inputs:{image:['1',0],model:'BiRefNet-general',mask_blur:0,mask_offset:0,invert_output:false,refine_foreground:false,background:'Alpha',background_color:'#000000'}};
    w['3']={class_type:'SaveImage',inputs:{images:['2',0],filename_prefix:'image2_matting'}};
  }else if(op==='segment'){
    w['2']={class_type:'DownloadAndLoadSAM2Model',inputs:{model:'sam2.1_hiera_small.safetensors',segmentor:'automaskgenerator',device:'cuda',precision:'fp16'}};
    w['3']={class_type:'Sam2AutoSegmentation',inputs:{sam2_model:['2',0],image:['1',0],points_per_side:Math.max(8,Math.min(64,Number(p.pointsPerSide)||16)),points_per_batch:32,pred_iou_thresh:.6,stability_score_thresh:.8,stability_score_offset:1,mask_threshold:0,crop_n_layers:0,box_nms_thresh:.7,crop_nms_thresh:.7,crop_overlap_ratio:.34,crop_n_points_downscale_factor:1,min_mask_region_area:0,use_m2m:false,keep_model_loaded:false}};
    w['4']={class_type:'MaskToImage',inputs:{mask:['3',0]}};w['5']={class_type:'SaveImage',inputs:{images:['4',0],filename_prefix:'image2_segment_mask'}};
  }else{
    if(![2,4].includes(Number(p.scale)))throw new ProviderError('Super resolution scale must be 2 or 4',{code:'INVALID_PARAMS',status:400});
    w['2']={class_type:'UpscaleModelLoader',inputs:{model_name:cfg.srModels[p.scale]}};
    w['3']={class_type:'ImageUpscaleWithModel',inputs:{upscale_model:['2',0],image:['1',0]}};w['4']={class_type:'SaveImage',inputs:{images:['3',0],filename_prefix:'image2_super_resolution'}};
  }
  return w;
}
export async function runComfy(op,request,ctx){
  const cfg=config(ctx);if(!cfg.comfyBaseUrl)throw new ProviderError('ComfyUI is not configured',{code:'UNAVAILABLE',status:503});
  if(op==='super_resolution'&&![2,4].includes(Number(request.params?.scale)))throw new ProviderError('Super resolution scale must be 2 or 4',{code:'INVALID_PARAMS',status:400});
  const headers=cfg.comfyToken?{authorization:`Bearer ${cfg.comfyToken}`}:{ };
  let receipt=ctx.providerReceipt?.provider==='comfy'?ctx.providerReceipt:null;
  if(receipt?.phase==='submitting'&&!receipt.promptId)throw new ProviderError('Comfy submission acknowledgement was lost; no automatic duplicate submission',{uncertain:true,code:'UNKNOWN_ACCEPTANCE'});
  if(!receipt?.promptId){
    cancelled(ctx);
    const form=new FormData();form.set('image',new Blob([request.base.bytes],{type:request.base.asset.mime}),`${randomUUID()}.png`);form.set('overwrite','false');
    const uploaded=await jsonResponse(await timedFetch(ctx,`${cfg.comfyBaseUrl}/upload/image`,{method:'POST',headers,body:form},cfg.comfyTimeoutMs));
    if(!uploaded.name)throw new ProviderError('Comfy upload returned no filename');
    receipt={provider:'comfy',operation:op,phase:'submitting',clientId:randomUUID()};await ctx.checkpoint({providerReceipt:receipt});
    let response;
    try{response=await timedFetch(ctx,`${cfg.comfyBaseUrl}/prompt`,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({client_id:receipt.clientId,prompt:workflow(op,uploaded.subfolder?`${uploaded.subfolder}/${uploaded.name}`:uploaded.name,request.params||{},cfg,request.base)})},cfg.comfyTimeoutMs);}catch{throw new ProviderError('Comfy acceptance is unknown',{uncertain:true,code:'UNKNOWN_ACCEPTANCE'});}
    if(!response.ok){if(response.status>=500)throw new ProviderError('Comfy submission outcome unknown',{uncertain:true,code:'UNKNOWN_ACCEPTANCE'});await ctx.checkpoint({providerReceipt:{...receipt,phase:'rejected'}});throw new ProviderError('Comfy rejected the workflow');}
    const submitted=await response.json().catch(()=>null);
    if(!submitted?.prompt_id)throw new ProviderError('Comfy acknowledgement has no prompt_id',{uncertain:true,code:'UNKNOWN_ACCEPTANCE'});
    receipt={...receipt,promptId:submitted.prompt_id,phase:'accepted'};
    await ctx.checkpoint({providerReceipt:receipt}); // durable before polling, downloading, or cancellation
  }
  let record;
  for(let i=0;i<cfg.comfyPollAttempts;i++){
    cancelled(ctx);
    const history=await jsonResponse(await timedFetch(ctx,`${cfg.comfyBaseUrl}/history/${encodeURIComponent(receipt.promptId)}`,{headers},cfg.comfyTimeoutMs));
    record=history[receipt.promptId];
    if(record?.status?.status_str==='error')throw new ProviderError('Comfy workflow failed',{code:'COMFY_EXECUTION'});
    if(record?.outputs&&Object.keys(record.outputs).length)break;
    record=null;await sleep(cfg.comfyPollMs);
  }
  if(!record)throw new ProviderError('Comfy accepted task is still pending; prompt_id preserved',{uncertain:true,code:'COMFY_PENDING'});
  await ctx.checkpoint({providerReceipt:{...receipt,phase:'complete'}});
  const images=Object.values(record.outputs).flatMap(x=>x.images||[]);
  if(!images.length)throw new ProviderError('Comfy produced no images');
  const downloads=[];
  for(const image of images){
    cancelled(ctx);
    const query=new URLSearchParams({filename:image.filename,subfolder:image.subfolder||'',type:image.type||'output'});
    const r=await timedFetch(ctx,`${cfg.comfyBaseUrl}/view?${query}`,{headers},cfg.comfyTimeoutMs);
    if(!r.ok)throw new ProviderError('Comfy output download failed');
    const bytes=Buffer.from(await r.arrayBuffer());if(bytes.length>64*1024*1024)throw new ProviderError('Comfy output exceeds budget');
    downloads.push({bytes,mime:'image/png',metadata:{provider:'comfy',promptId:receipt.promptId},filename:image.filename});
  }
  if(op==='segment')return {masks:downloads.filter(x=>x.filename.includes('segment_mask')).slice(0,Math.max(1,Math.min(256,Number(request.params?.maxSegments)||64))),backend:'comfyui-sam2'};
  return {...downloads[0],backend:op==='matting'?'comfyui-birefnet':'comfyui-realesrgan'};
}
