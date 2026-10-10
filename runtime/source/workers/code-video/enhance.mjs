import { readFile, writeFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileHash, run, finishFilm, mediaEvidence, runtimeHash } from './render.mjs';
import { probeMedia } from '../../gateway/studio/compositor.mjs';

const EXPECTED_EXE='fdefd51abf31a63f20f970f8a7a82d230e825dd3da962836b8e9e8febbf16b89';
const EXPECTED_DLL='6eb209e764f39872625debd6abaf45e2bb6322f6f270f781f70c059ae30b3927';
export async function compareVideos({ left, right, output, signal }) {
  await run(process.env.FFMPEG_BIN||'ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-y','-filter_complex_threads','1','-threads','1','-i',left,'-threads','1','-i',right,'-filter_complex','[0:v]setpts=PTS-STARTPTS[l];[1:v]setpts=PTS-STARTPTS[r];[l][r]hstack=inputs=2:shortest=1[v]','-map','[v]','-map','0:a?','-c:v','libx264','-threads','4','-preset','medium','-crf','18','-pix_fmt','yuv420p','-r','24','-fps_mode','cfr','-c:a','copy','-video_track_timescale','24000','-movflags','+faststart',output],{signal});
  return output;
}
export async function enhance({spec,assets,dir,progress=async()=>{},signal}) {
  if(process.platform!=='win32')throw Error('NR requires the configured Windows interactive desktop');
  const exe=process.env.STUDIO_NR_EXE;if(!exe)throw Error('NR runtime unavailable');
  const runtimeDir=dirname(exe),dll=join(runtimeDir,'neural-runtime','nvngx_dlssnr.dll');
  if(await fileHash(exe)!==EXPECTED_EXE||await fileHash(dll)!==EXPECTED_DLL)throw Error('NR runtime differs from the verified pinned build');
  const source=assets.find(a=>a.id===spec.sourceAssetId);
  if(!source||await fileHash(source.path)!==spec.sourceHash)throw Error('Enhancement source hash mismatch');
  const clean=spec.cleanSourceAssetId?assets.find(a=>a.id===spec.cleanSourceAssetId):source;
  if(!clean||spec.cleanSourceHash&&await fileHash(clean.path)!==spec.cleanSourceHash)throw Error('Clean render is missing or changed');
  const original=await probeMedia(clean.path),v=original.streams.find(s=>s.codec_type==='video');
  if(!v||v.avg_frame_rate!=='24/1')throw Error('NR source must be a 24 fps video');
  const started=Date.now(),raw=join(dir,'nr-raw.mp4'),report=join(dir,'nr-converter-report.json');
  const logs=['neural-runtime/ReShade.log','neural-runtime/NeuralWorker.log','DLSSVideoPlayer.log'];
  const before=new Map();for(const name of logs){before.set(name,await readFile(join(runtimeDir,name)).catch(()=>Buffer.alloc(0)));}
  await progress({stage:'neural-rendering',progress:.1});
  const stdout=await run(exe,[clean.path,'--stages','nr','--preset','natural','--passes','1','--processing-scale','100','--out',raw,'--report',report,'--fail-fast'],{cwd:runtimeDir,signal,timeout:1800000});
  await writeFile(join(dir,'nr-console.log'),stdout);
  const collected={};for(const name of logs){const b=await readFile(join(runtimeDir,name)),old=before.get(name);const fresh=b.length>=old.length&&b.subarray(0,old.length).equals(old)?b.subarray(old.length):b;if(!fresh.length)throw Error('No fresh NR execution log');const filename=name.split('/').pop();collected[filename]=fresh.toString('utf8');await writeFile(join(dir,'nr-'+filename),fresh);}
  const log=collected['ReShade.log'];
  const created=/feature 18 created/i.test(log),counts=[...log.matchAll(/feature 18 evaluation succeeded \(count=(\d+)/gi)].map(m=>Number(m[1]));
  const result=JSON.parse((await readFile(report,'utf8')).replace(/^\uFEFF/,''));
  if(!created||!counts.length||result.exitCode!==0||result.files?.[0]?.result!=='done')throw Error('NR feature 18 execution could not be verified');
  const nrMs=Date.now()-started;
  await progress({stage:'normalizing',progress:.75});
  const normalized=join(dir,'enhanced-clean.mp4');
  await run(process.env.FFMPEG_BIN||'ffmpeg',['-v','error','-nostdin','-y','-i',raw,'-map','0:v:0','-map','0:a?','-vf','settb=1/24000,setpts=N*1000','-frames:v',String(v.nb_read_frames),'-r','24','-fps_mode','cfr','-c:v','libx264','-threads','4','-preset','medium','-crf','17','-pix_fmt','yuv420p','-video_track_timescale','24000','-c:a','copy','-movflags','+faststart',normalized],{signal});
  let enhanced=normalized;
  if(spec.cleanSourceAssetId){const renderSpec=spec.renderSpec || {...spec,fps:24,width:v.width,height:v.height,totalFrames:Number(v.nb_read_frames),sequence:spec.sequence};enhanced=(await finishFilm({cleanPath:normalized,dir,spec:renderSpec,assets,name:'enhanced-composited.mp4'})).path;}
  await run(process.env.FFMPEG_BIN||'ffmpeg',['-v','error','-nostdin','-y','-i',enhanced,'-i',source.path,'-map','0:v:0','-map','1:a?','-c','copy','-video_track_timescale','24000','-movflags','+faststart',join(dir,'enhanced.mp4')],{signal});enhanced=join(dir,'enhanced.mp4');
  const comparison=await compareVideos({left:source.path,right:enhanced,output:join(dir,'comparison.mp4'),signal});
  const receipt={runtimeHash:await runtimeHash(),sourceAssetId:spec.sourceAssetId,sourceHash:spec.sourceHash,neuralInputHash:await fileHash(clean.path),cleanBeforeCaptions:Boolean(spec.cleanSourceAssetId),runtime:{executableSHA256:EXPECTED_EXE,nrSHA256:EXPECTED_DLL,version:'community-player-0.27.0',platform:process.platform},nr:{featureId:18,created,evaluated:counts.length>0,loggedSuccessCounts:counts,verifiedNeuralFrames:null},parameters:spec.parameters,timings:{neuralRenderingMs:nrMs,totalMs:Date.now()-started},media:await mediaEvidence(enhanced)};
  if(receipt.media.frames!==Number(v.nb_read_frames)||receipt.media.width!==v.width||receipt.media.height!==v.height)throw Error('NR output changed dimensions/frame count');
  await writeFile(join(dir,'enhancement-receipt.json'),JSON.stringify(receipt,null,2));
  return {enhanced,comparison,receipt};
}
