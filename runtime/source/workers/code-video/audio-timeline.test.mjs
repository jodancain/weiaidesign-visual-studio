import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {effectsAudioTimeline} from './effects.mjs';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/audio-timeline-ffprobe7-9.json',import.meta.url)));
const linux=()=>structuredClone(fixture.linux),windows=()=>structuredClone(fixture.windows);
test('actual FFprobe 7/9 AAC tail reports share a proven input compatibility identity, keeping strict output identity',()=>{
 const a=linux(),b=windows(),before=JSON.stringify(b),old=effectsAudioTimeline(a.packets,a.stream),current=effectsAudioTimeline(b.packets,b.stream);
 assert.notEqual(current.timelineHash,old.timelineHash);assert.equal(current.compatibleTimelineHash,old.timelineHash);
 assert.equal(old.compatibleTimelineHash,null);assert.deepEqual(current.compatibility,{kind:'ffprobe-terminal-aac-padding',discardPaddingSamples:512,lastPacketSamples:512,nominalPacketSamples:1024});
 assert.equal(JSON.stringify(b),before,'input packet evidence must stay immutable');
});
test('compatibility never hides changed PTS/DTS/duration/size or initial skip',()=>{
 const old=effectsAudioTimeline(fixture.linux.packets,fixture.linux.stream).timelineHash;
 for(const mutate of [p=>p.at(-1).pts_time='59.990000',p=>p.at(-1).dts_time='59.990000',p=>p.at(-1).duration_time='0.011000',p=>p.at(-1).size='7',p=>p[0].side_data_list[0].skip_samples=512]){
  const {packets,stream}=windows();mutate(packets);const result=effectsAudioTimeline(packets,stream);assert.notEqual(result.timelineHash,old);assert.notEqual(result.compatibleTimelineHash,old);
 }
});
test('nonredundant trim, unknown side data and unproven sample clocks have no compatibility fallback',()=>{
 for(const mutate of [
  x=>x.packets.at(-1).side_data_list[0].discard_padding=511,
  x=>x.packets.at(-1).side_data_list[0].skip_samples=1,
  x=>x.packets.at(-1).side_data_list[0].skip_reason=1,
  x=>x.packets.at(-1).side_data_list[0].discard_reason=1,
  x=>x.packets.at(-1).side_data_list[0].unknown=0,
  x=>x.packets.at(-1).side_data_list.push({side_data_type:'New side data'}),
  x=>x.packets.at(-1).duration=513,
  x=>x.packets.at(-2).duration=960,
  x=>x.packets.at(-3).duration=960,
  x=>delete x.packets.at(-1).duration,
  x=>x.stream.sample_rate='44100',
  x=>x.stream.time_base='0/48000',
  x=>x.stream.codec_name='opus',
 ]){const x=windows();mutate(x);assert.equal(effectsAudioTimeline(x.packets,x.stream).compatibleTimelineHash,null);}
 const x=linux();x.packets.at(-2).side_data_list=structuredClone(fixture.windows.packets.at(-1).side_data_list);assert.equal(effectsAudioTimeline(x.packets,x.stream).compatibleTimelineHash,null,'Never remove nonterminal trim');
});
