import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { ROOT, run, runtimeHash, fileHash, sha256, frameName, localServer } from './render.mjs';
import { atomicWrite, atomicJSON, durableRename } from './durable-io.mjs';
import { compareVideos } from './enhance.mjs';
import { validateEffectsProgram, effectsProgramHash, canonicalEffectsJSON } from '../../gateway/studio/effects-program.mjs';
const HERE=dirname(fileURLToPath(import.meta.url)),require=createRequire(join(ROOT,'web/package.json'));
const HASH=/^[a-f0-9]{64}$/,ID=/^[a-zA-Z0-9_-]{1,100}$/;
export function validateEffectsSpec(spec,assets){
 if(!spec||spec.fps!==24||!Number.isSafeInteger(spec.totalFrames)||!Number.isSafeInteger(spec.width)||!Number.isSafeInteger(spec.height)||spec.schemaVersion!==1||!HASH.test(spec.runtimeHash)||!HASH.test(spec.sourceHash)||!HASH.test(spec.effectsProgramHash)||!ID.test(spec.sourceAssetId))throw Error('Invalid frozen effects identity');
 const program=validateEffectsProgram(spec.effectsProgram,{source:spec});
 if(effectsProgramHash(program)!==spec.effectsProgramHash)throw Error('Effects program hash mismatch');
 if(spec.sourceMedia)for(const k of ['fps','width','height','totalFrames'])if((spec.sourceMedia[k]??(k==='totalFrames'?spec.sourceMedia.frames:undefined))!==spec[k])throw Error(`Frozen source media ${k} mismatch`);
 if(!Array.isArray(assets)||assets.length!==1||assets[0].id!==spec.sourceAssetId||assets[0].hash!==spec.sourceHash||assets[0].mime!=='video/mp4')throw Error('Effects require exactly the selected frozen MP4');
 return program;
}
async function probeJSON(args,signal){
 return new Promise((res,rej)=>{const child=spawn(process.env.FFPROBE_BIN||'ffprobe',['-v','error',...args,'-of','json'],{signal,windowsHide:true,stdio:['ignore','pipe','pipe']});const chunks=[];let bytes=0,error='';const timer=setTimeout(()=>child.kill('SIGKILL'),300000);child.stdout.on('data',b=>{bytes+=b.length;if(bytes>64*1024*1024){child.kill('SIGKILL');error='Probe output exceeds bound';}else chunks.push(b);});child.stderr.on('data',b=>{error=(error+b).slice(-5000);});child.on('error',e=>{clearTimeout(timer);rej(e);});child.on('close',code=>{clearTimeout(timer);if(code!==0)return rej(Error(error||`ffprobe exit ${code}`));try{res(JSON.parse(Buffer.concat(chunks)));}catch(e){rej(e);}});});
}
export function effectsAudioTimeline(packets,stream={}){
 const rows=packets.map(p=>[p.pts_time,p.dts_time,p.duration_time,p.size,p.side_data_list||[]]);
 const result={timelineHash:packets.length?sha256(canonicalEffectsJSON(rows)):null,compatibleTimelineHash:null,compatibility:null};
 // FFprobe 9 exposes the AAC tail padding already represented by the shortened
 // final packet duration; FFprobe 7 does not. Keep the strict hash for output
 // comparison and permit a second input-only hash only when samples prove it.
 const rate=Number(stream.sample_rate),timeBase=/^(\d+)\/(\d+)$/.exec(stream.time_base||'');
 const tail=packets.at(-1),side=tail?.side_data_list;
 if(stream.codec_name!=='aac'||packets.length<3||!Number.isSafeInteger(rate)||rate<=0||rate>384000||!timeBase||!Array.isArray(side)||side.length!==1)return result;
 const num=Number(timeBase[1]),den=Number(timeBase[2]),skip=side[0],keys=['side_data_type','skip_samples','discard_padding','skip_reason','discard_reason'];
 if(!Number.isSafeInteger(num)||num<=0||!Number.isSafeInteger(den)||den<=0||!skip||Object.keys(skip).length!==keys.length||!keys.every(k=>Object.hasOwn(skip,k))||skip.side_data_type!=='Skip Samples'||skip.skip_samples!==0||skip.skip_reason!==0||skip.discard_reason!==0||!Number.isSafeInteger(skip.discard_padding)||skip.discard_padding<=0)return result;
 const samples=p=>{const duration=Number(p.duration),seconds=duration*num/den,value=seconds*rate,rounded=Math.round(value);return Number.isSafeInteger(duration)&&duration>0&&Number.isSafeInteger(rounded)&&rounded>0&&Math.abs(value-rounded)<1e-6&&Number.isFinite(Number(p.duration_time))&&Math.abs(Number(p.duration_time)-seconds)<=.00000051?rounded:null;};
 const nominal=samples(packets.at(-2)),previous=samples(packets.at(-3)),last=samples(tail);
 if(!nominal||nominal!==previous||nominal>8192||!last||last>=nominal||last+skip.discard_padding!==nominal)return result;
 rows.at(-1)[4]=[];
 result.compatibleTimelineHash=sha256(canonicalEffectsJSON(rows));
 result.compatibility={kind:'ffprobe-terminal-aac-padding',discardPaddingSamples:skip.discard_padding,lastPacketSamples:last,nominalPacketSamples:nominal};return result;
}
export async function effectsAudioEvidence(path,signal){
 const {packets=[],streams=[]}=await probeJSON(['-select_streams','a:0','-show_packets','-show_streams','-show_data_hash','sha256','-show_entries','stream=codec_name,sample_rate,time_base:packet=data_hash,pts_time,dts_time,duration_time,duration,size,side_data_list',path],signal);
 return{present:packets.length>0,packetCount:packets.length,payloadHash:packets.length?sha256(canonicalEffectsJSON(packets.map(p=>p.data_hash))):null,...effectsAudioTimeline(packets,streams[0])};
}
export async function inspectEffectsSource(path,spec,signal){
 const p=await probeJSON(['-count_frames','-show_streams','-show_format',path],signal),videos=p.streams.filter(s=>s.codec_type==='video'),audios=p.streams.filter(s=>s.codec_type==='audio');
 const v=videos[0];if(videos.length!==1||!v||v.avg_frame_rate!=='24/1'||Number(v.nb_read_frames)!==spec.totalFrames||v.width!==spec.width||v.height!==spec.height||Math.abs(Number(v.duration)-spec.totalFrames/24)>.002)throw Error('Source does not match frozen 24 fps frame/dimension/duration contract');
 if(audios.length>1||audios.some(a=>a.codec_name!=='aac'))throw Error('Effects preserve one AAC track or an absent audio track; other audio layouts are unsupported');
 const {frames=[]}=await probeJSON(['-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp_time',path],signal);
 if(frames.length!==spec.totalFrames||frames.some((f,i)=>Math.abs(Number(f.best_effort_timestamp_time)-i/24)>.000002))throw Error('Source must have a zero-based exact CFR frame clock');
 const audio=await effectsAudioEvidence(path,signal);
 if(spec.sourceMedia?.hasAudio!==undefined&&spec.sourceMedia.hasAudio!==audio.present)throw Error('Frozen source audio presence mismatch');
 if(spec.sourceMedia?.audioPacketHash&&spec.sourceMedia.audioPacketHash!==audio.payloadHash)throw Error('Frozen source audio packet hash mismatch');
 if(spec.sourceMedia?.audioTimelineHash&&![audio.timelineHash,audio.compatibleTimelineHash].includes(spec.sourceMedia.audioTimelineHash))throw Error('Frozen source audio timeline mismatch');
 return{frames:frames.length,fps:24,width:v.width,height:v.height,duration:Number(v.duration),audio};
}
export async function renderEffectsPngs({spec,dir,frames,signal,progress=async()=>{}}){
 const program=validateEffectsProgram(spec.effectsProgram,{source:spec}),currentRuntime=await runtimeHash();
 if(spec.runtimeHash!==currentRuntime)throw Error('Frozen effects runtime unavailable; restore the original release');
 if(effectsProgramHash(program)!==spec.effectsProgramHash)throw Error('Effects program hash mismatch');
 dir=resolve(dir);const pngDir=join(dir,'effects-frames');await mkdir(pngDir,{recursive:true});
 const binding={schemaVersion:1,runtimeHash:currentRuntime,specHash:sha256(JSON.stringify(spec)),sourceAssetId:spec.sourceAssetId,sourceHash:spec.sourceHash,effectsProgramHash:spec.effectsProgramHash};
 const bindingPath=join(dir,'effects-binding.json'),old=await readFile(bindingPath,'utf8').then(JSON.parse,e=>{if(e.code==='ENOENT')return null;throw e;});
 if(old&&JSON.stringify(old)!==JSON.stringify(binding))throw Error('Effects checkpoints belong to a different immutable input');
 if(!old)await writeFile(bindingPath,JSON.stringify(binding),{flag:'wx'});
 const wanted=frames||Array.from({length:program.totalFrames},(_,i)=>i);if(wanted.some(f=>!Number.isSafeInteger(f)||f<0||f>=program.totalFrames))throw Error('Invalid effects frame selection');
 const missing=[];let visibleFrames=0;
 for(const frame of wanted){try{const bytes=await readFile(join(pngDir,frameName(frame))),meta=JSON.parse(await readFile(join(pngDir,frameName(frame)+'.json'),'utf8'));if(bytes.length<100||bytes.subarray(1,4).toString()!=='PNG'||sha256(bytes)!==meta.sha256)throw Error('Corrupt checkpoint');if(meta.hasVisiblePixels)visibleFrames++;}catch{missing.push(frame);}}
 const app=join(dir,'effects-app');await mkdir(app,{recursive:true});await writeFile(join(app,'effects-browser.js'),await readFile(join(HERE,'effects-browser.mjs')));await writeFile(join(app,'index.html'),'<!doctype html><meta charset="utf-8"><canvas id="fx"></canvas><script type="module">import {renderEffectsFrame} from "/effects-browser.js";window.effects={render(program,frame){const canvas=document.getElementById("fx");const metadata=renderEffectsFrame(canvas,program,frame);return {metadata,png:canvas.toDataURL("image/png").split(",")[1]};}};</script>');
 let browserVersion=null;
 const previous=await readFile(join(dir,'effects-frame-receipt.json'),'utf8').then(JSON.parse,()=>null);
 if(missing.length){const host=await localServer(app);let browser;try{
  const executablePath=process.env.STUDIO_CHROME_BIN||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':'/usr/bin/google-chrome');
  browser=await require('playwright').chromium.launch({executablePath,headless:true,args:['--disable-gpu','--force-color-profile=srgb','--force-device-scale-factor=1']});browserVersion=browser.version();
  const page=await browser.newPage();await page.route('**/*',r=>r.request().url().startsWith(host.url+'/')?r.continue():r.abort());await page.goto(host.url);await page.waitForFunction(()=>Boolean(window.effects));
  for(let i=0;i<missing.length;i++){signal?.throwIfAborted();const frame=missing[i],r=await page.evaluate(({program,frame})=>window.effects.render(program,frame),{program,frame});signal?.throwIfAborted();const bytes=Buffer.from(r.png,'base64'),path=join(pngDir,frameName(frame));await atomicWrite(path,bytes);await atomicJSON(path+'.json',{...r.metadata,sha256:sha256(bytes)});if(r.metadata.hasVisiblePixels)visibleFrames++;await progress({stage:'effects-frames',frame,completedFrames:wanted.length-missing.length+i+1,totalFrames:wanted.length});}
 }finally{await browser?.close();await host.close();}}
 if(!frames&&!visibleFrames)throw Error('All rendered effects pixels are transparent; no visible effect can be delivered');
 const receipt={...binding,browserVersion:browserVersion||previous?.browserVersion,renderer:'Canvas2D software RGBA, source-over',absoluteFrames:true,frameCount:wanted.length,renderedNow:missing.length,reusedFrames:wanted.length-missing.length,visibleFrames,subtitleProtection:{...program.subtitleProtection,featherPx:24,mode:'burned-in-source-protected-region'}};
 await atomicJSON(join(dir,'effects-frame-receipt.json'),receipt);return{pngDir,receipt};
}
async function outputMediaEvidence(path,signal){
 const p=await probeJSON(['-count_frames','-show_streams','-show_format',path],signal),v=p.streams.find(s=>s.codec_type==='video'),a=p.streams.find(s=>s.codec_type==='audio');
 await run(process.env.FFMPEG_BIN||'ffmpeg',['-v','error','-nostdin','-threads','1','-i',path,'-threads','1','-f','null','-'],{signal});
 return{sha256:await fileHash(path),bytes:(await stat(path)).size,frames:Number(v?.nb_read_frames),fps:v?.avg_frame_rate,width:v?.width,height:v?.height,videoDuration:Number(v?.duration),audioDuration:a?Number(a.duration):null,fullDecode:true};
}
function assertAudioSame(source,result,label){if(source.payloadHash!==result.payloadHash||source.timelineHash!==result.timelineHash||source.packetCount!==result.packetCount)throw Error(`${label} changed the source AAC packet sequence or timeline`);}
export async function applyEffects({spec,assets,dir,signal,progress=async()=>{}}){
 validateEffectsSpec(spec,assets);const source=assets[0];if(await fileHash(source.path)!==spec.sourceHash)throw Error('Selected effects source changed');
 const sourceMedia=await inspectEffectsSource(source.path,spec,signal);
 const {pngDir,receipt:frames}=await renderEffectsPngs({spec,dir,signal,progress:p=>progress({...p,progress:.05+.65*p.completedFrames/p.totalFrames})});
 signal?.throwIfAborted();if(await fileHash(source.path)!==spec.sourceHash)throw Error('Selected effects source changed during rendering');await progress({stage:'effects-compositing',progress:.72});const ffmpeg=process.env.FFMPEG_BIN||'ffmpeg',visual=join(dir,'effects-visual.mp4');
 await run(ffmpeg,['-hide_banner','-v','error','-nostdin','-y','-filter_complex_threads','1','-threads','1','-i',source.path,'-framerate','24','-i',join(pngDir,'frame-%06d.png'),'-filter_complex','[0:v]settb=1/24000,setpts=N*1000,format=rgba[base];[base][1:v]overlay=shortest=1:format=auto:alpha=straight,format=yuv420p[v]','-map','[v]','-an','-frames:v',String(spec.totalFrames),'-r','24','-fps_mode','cfr','-c:v','libx264','-threads','2','-preset','medium','-crf','16','-pix_fmt','yuv420p','-video_track_timescale','24000','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-movflags','+faststart',visual],{signal});
 const effects=join(dir,'effects.mp4'),staged=join(dir,'effects.staged.mp4');
 await run(ffmpeg,['-v','error','-nostdin','-y','-i',visual,'-i',source.path,'-map','0:v:0','-map','1:a?','-c','copy','-video_track_timescale','24000','-movflags','+faststart',staged],{signal});
 const media=await outputMediaEvidence(staged,signal),audio=await effectsAudioEvidence(staged,signal);assertAudioSame(sourceMedia.audio,audio,'Effects output');if(media.frames!==spec.totalFrames||media.fps!=='24/1'||media.width!==spec.width||media.height!==spec.height||Math.abs(media.videoDuration-spec.totalFrames/24)>.002)throw Error('Effects output changed the frame contract');await durableRename(staged,effects);
 await progress({stage:'effects-comparison',progress:.9});const comparison=join(dir,'comparison.mp4'),comparisonStaged=join(dir,'comparison.staged.mp4');await compareVideos({left:source.path,right:effects,output:comparisonStaged,signal});
 const comparisonMedia=await outputMediaEvidence(comparisonStaged,signal),comparisonAudio=await effectsAudioEvidence(comparisonStaged,signal);assertAudioSame(sourceMedia.audio,comparisonAudio,'Comparison output');if(comparisonMedia.frames!==spec.totalFrames||comparisonMedia.width!==spec.width*2||comparisonMedia.height!==spec.height||comparisonMedia.fps!=='24/1')throw Error('Effects comparison changed frame contract');await durableRename(comparisonStaged,comparison);
 if(await fileHash(source.path)!==spec.sourceHash)throw Error('Selected effects source changed during composition');
 const receipt={schemaVersion:1,runtimeHash:await runtimeHash(),sourceAssetId:spec.sourceAssetId,sourceHash:spec.sourceHash,effectsProgramHash:spec.effectsProgramHash,planJobId:spec.planJobId,planHash:spec.planHash,sourceMedia,frames,subtitleProtection:frames.subtitleProtection,sourceSelection:'selected MP4 directly; no clean-source substitution',audioPolicy:'copy original AAC packets and timestamps; no narration or mix added',automaticNR:false,media:{...media,audio},comparisonMedia:{...comparisonMedia,audio:comparisonAudio},comparisonLayout:{left:'selected source',right:'effects result'}};
 await atomicJSON(join(dir,'effects-receipt.json'),receipt);return{effects,comparison,receipt};
}
