// Operator-only historical media import. There is deliberately no HTTP route.
// A remix may change audio, but must retain every encoded video packet and timestamp.
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { digest, fail } from './domain.mjs';
import { effectsSource } from './effects-source.mjs';
import { inspectVideo } from './code-jobs.mjs';

const exec=promisify(execFile),hashPattern=/^[a-f0-9]{64}$/;
export async function effectsVideoEvidence(path,ffprobePath='ffprobe'){
  const {stdout}=await exec(ffprobePath,['-v','error','-show_streams','-show_data_hash','sha256','-of','json',path],{timeout:120000,maxBuffer:2000000});
  const streams=JSON.parse(stdout).streams||[],videos=streams.filter(s=>s.codec_type==='video'),audio=streams.filter(s=>s.codec_type==='audio');
  fail(videos.length===1&&audio.length===1&&audio[0].codec_name==='aac','verified audio remix requires exactly one video stream and one AAC stream',422);
  const v=videos[0],packetsResult=await exec(ffprobePath,['-v','error','-select_streams','v:0','-show_packets','-show_data_hash','sha256','-show_entries','packet=data_hash,pts,dts,duration,pts_time,dts_time,duration_time,size,side_data_list','-of','json',path],{timeout:120000,maxBuffer:16000000});
  const packets=JSON.parse(packetsResult.stdout).packets;
  fail(Array.isArray(packets)&&packets.length>0&&packets.every(p=>/^SHA256:[a-f0-9]{64}$/i.test(p.data_hash||'')&&p.pts!==undefined&&p.dts!==undefined&&p.duration!==undefined),'video packet identity is not verifiable',422);
  const profile={codec:v.codec_name,profile:v.profile,width:v.width,height:v.height,pixelFormat:v.pix_fmt,timeBase:v.time_base,extradataHash:v.extradata_hash};
  return {videoPacketHash:digest(packets.map(p=>p.data_hash)),videoTimelineHash:digest({profile,packets:packets.map(p=>[p.pts,p.dts,p.duration,p.pts_time,p.dts_time,p.duration_time,p.size,p.side_data_list||[]])}),packetCount:packets.length,profile};
}

export async function importEffectsAudioRemix(store,{projectId,sourceAssetId,sourceHash,outputPath,outputHash,name,idempotencyKey,evidenceHash},{ffprobePath='ffprobe'}={}){
  fail(hashPattern.test(outputHash)&&hashPattern.test(evidenceHash),'outputHash and historical evidence SHA256 are required',422);
  const source=effectsSource(store,projectId,sourceAssetId,sourceHash),bytes=readFileSync(outputPath);
  fail(digest(bytes)===outputHash,'historical remix output hash changed',409);
  const [before,after,sourceMedia,outputMedia]=await Promise.all([effectsVideoEvidence(source.path,ffprobePath),effectsVideoEvidence(outputPath,ffprobePath),inspectVideo(source.path,ffprobePath),inspectVideo(outputPath,ffprobePath)]);
  fail(before.videoPacketHash===after.videoPacketHash&&before.videoTimelineHash===after.videoTimelineHash,'audio remix changed video packets or timestamps',409);
  fail(outputMedia.fps===24&&outputMedia.frames===sourceMedia.frames&&outputMedia.width===sourceMedia.width&&outputMedia.height===sourceMedia.height&&outputMedia.duration===sourceMedia.duration,'audio remix changed video format or duration',409);
  fail(digest(readFileSync(source.path))===sourceHash&&digest(readFileSync(outputPath))===outputHash,'media changed during import verification',409);
  const proof={schemaVersion:1,transform:'audio-remix',sourceAssetId,sourceHash,outputHash,sourceVideoPacketHash:before.videoPacketHash,outputVideoPacketHash:after.videoPacketHash,sourceVideoTimelineHash:before.videoTimelineHash,outputVideoTimelineHash:after.videoTimelineHash,evidenceHash};
  return store.transaction(()=>{
    const job=store.createJob(projectId,'trusted-media-import',idempotencyKey,{proof,sourceMedia,outputMedia});
    if(job.state==='complete'){const asset=store.getAsset(job.outputAssetId).asset;fail(asset.hash===outputHash,'existing import output changed',409);return {job,asset};}
    fail(job.state==='queued','historical import has an unexpected state',409);
    const complete=store.completeJob(job.id,{name,kind:'video',mime:'video/mp4',parentId:sourceAssetId,source:'verified-media-import',metadata:{jobId:job.id,transform:'audio-remix',...outputMedia}},bytes,{...outputMedia,transform:'audio-remix',sourceHash,outputHash});
    return {job:complete,asset:store.getAsset(complete.outputAssetId).asset};
  });
}
