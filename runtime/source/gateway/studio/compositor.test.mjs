import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, stat, copyFile, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { exportSequence, probeMedia, PANEL_SCRIPT } from './compositor.mjs';

const ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg';
function media(args) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 8e6 });
  assert.equal(r.status, 0, r.stderr?.toString()); return r.stdout;
}
test('240-frame export trims, concatenates, renders Unicode panels and mixes faded audio', { timeout: 120000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-compositor-test-'));
  try {
    const assets = { red: join(dir, 'red.mp4'), blue: join(dir, 'blue.mp4'), tone: join(dir, 'tone.wav') };
    media(['-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=24:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', assets.red]);
    media(['-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=24:d=9', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', assets.blue]);
    media(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=10', assets.tone]);
    const defaults = { sourceIn: 0, volume: 1, fadeIn: 0, fadeOut: 0, track: 0 };
    const clips = [
      { ...defaults, id: 'v1', kind: 'video', assetId: 'red', startFrame: 0, endFrame: 48, sourceIn: 24 },
      { ...defaults, id: 'v2', kind: 'video', assetId: 'blue', startFrame: 48, endFrame: 240, sourceIn: 24 },
      { ...defaults, id: 'a1', kind: 'audio', assetId: 'tone', startFrame: 0, endFrame: 240, fadeIn: 24, fadeOut: 24, volume: 0.5, track: 1 },
      { ...defaults, id: 'a2', kind: 'audio', assetId: 'tone', startFrame: 96, endFrame: 144, volume: 0.25, track: 2 },
      { ...defaults, id: 't1', kind: 'text', text: '沈月 · 身份面板\n100% verified: [safe]', startFrame: 24, endFrame: 72, fontSize: 48, x: .3, y: .16, color: '#ffffff', track: 3 },
      { ...defaults, id: 't2', kind: 'text', text: '最后一帧仍应有字幕', startFrame: 216, endFrame: 240, fontSize: 36, x: .5, y: .82, color: '#ffffff', track: 3 },
    ];
    const project = { fps: 24, aspect: '16:9', sequence: { fps: 24, totalFrames: 240, clips } };
    const outputPath = join(dir, 'result.mp4');
    const result = await exportSequence({ project, outputPath, resolveAsset: id => assets[id] });
    assert.deepEqual({ ...result, path: '' }, { path: '', frames: 240, fps: 24, duration: 10, width: 1280, height: 720 });
    assert.ok((await stat(outputPath)).size > 10000);
    const probe = await probeMedia(outputPath);
    assert.equal(Number(probe.streams.find(s => s.codec_type === 'video').nb_read_frames), 240);
    assert.equal(probe.streams.find(s => s.codec_type === 'audio').sample_rate, '48000');
    const pixel = frame => [...media(['-i', outputPath, '-vf', `select=eq(n\\,${frame}),crop=2:2:1000:500,scale=1:1`, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'])];
    assert.ok(pixel(47)[0] > 200, 'last first-clip frame is red');
    assert.ok(pixel(48)[2] > 200, 'first second-clip frame is blue');
    const panel = frame => media(['-i', outputPath, '-vf', `select=eq(n\\,${frame}),crop=600:140:30:30`, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']);
    const white = bytes => { let n = 0; for (let i = 0; i < bytes.length; i += 3) if (bytes[i] > 180 && bytes[i+1] > 180 && bytes[i+2] > 180) n++; return n; };
    assert.equal(white(panel(23)), 0);
    assert.ok(white(panel(24)) > 500, 'text appears on its inclusive first frame');
    assert.equal(white(panel(72)), 0, 'text disappears at its exclusive end frame');
    const latePanel = frame => media(['-i', outputPath, '-vf', `select=eq(n\\,${frame}),crop=900:120:180:540`, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']);
    assert.equal(white(latePanel(215)), 0, 'a decoded-once late panel stays disabled before its start');
    assert.ok(white(latePanel(216)) > 300, 'a decoded-once panel appears on a delayed inclusive first frame');
    assert.ok(white(latePanel(239)) > 300, 'retaining one PNG keeps the final caption visible through the last frame');
    const textFrame = media(['-i', outputPath, '-vf', 'select=eq(n\\,24)', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']);
    const bounds = [1280, 720, 0, 0];
    for (let i = 0; i < textFrame.length; i += 3) if (textFrame[i] > 180 && textFrame[i+1] > 180 && textFrame[i+2] > 180) { const x = (i/3) % 1280, y = Math.floor(i/3/1280); bounds[0] = Math.min(bounds[0], x); bounds[1] = Math.min(bounds[1], y); bounds[2] = Math.max(bounds[2], x); bounds[3] = Math.max(bounds[3], y); }
    assert.ok(Math.abs((bounds[0]+bounds[2])/2 - .3*1280) < 6, 'text x is a normalized center');
    assert.ok(Math.abs((bounds[1]+bounds[3])/2 - .16*720) < 6, 'text y is a normalized center');
    const samples = media(['-i', outputPath, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-']);
    const rms = (start, end) => { let energy = 0, n = 0; for (let i = start * 48000 | 0; i < end * 48000 && i * 4 + 4 <= samples.length; i++) { const x = samples.readFloatLE(i * 4); energy += x*x; n++; } return Math.sqrt(energy/n); };
    assert.ok(rms(1.2, 1.8) > rms(0.02, 0.08) * 5, 'fade in changes actual audio samples');
    assert.ok(rms(4.5, 5.5) > rms(2.5, 3.5) * 1.25, 'overlapping audio is mixed');
    assert.ok(rms(8.2, 8.8) > rms(9.92, 9.98) * 5, 'fade out changes actual audio samples');
    const reject = async (changed, code) => assert.rejects(exportSequence({ project: { ...project, sequence: { ...project.sequence, clips: changed } }, outputPath: join(dir, 'invalid.mp4'), resolveAsset: id => assets[id] }), e => e.code === code);
    await reject(clips.map(c => c.id === 'v2' ? { ...c, startFrame: 49 } : c), 'VIDEO_COVERAGE_ERROR');
    await reject(clips.map(c => c.id === 'v2' ? { ...c, startFrame: 47 } : c), 'VIDEO_COVERAGE_ERROR');
    await reject(clips.map(c => c.id === 'v2' ? { ...c, sourceIn: 25 } : c), 'SOURCE_TOO_SHORT');
    await reject(clips.map(c => c.id === 'a1' ? { ...c, sourceIn: 1 } : c), 'SOURCE_TOO_SHORT');
    if (process.env.STUDIO_TEST_OUTPUT_DIR) {
      const evidence = process.env.STUDIO_TEST_OUTPUT_DIR;
      await mkdir(evidence, { recursive: true });
      await copyFile(outputPath, join(evidence, 'compositor-240frames.mp4'));
      await writeFile(join(evidence, 'compositor-evidence.json'), JSON.stringify({ result: { ...result, path: 'compositor-240frames.mp4' }, probe, assertions: { cutFrames: [47, 48], textPresentFrames: [24], textAbsentFrames: [23, 72], normalizedTextCenter: [.3, .16], textPixelBounds: bounds, mixedAudioRms: rms(4.5, 5.5), soloAudioRms: rms(2.5, 3.5), fadeInRms: rms(0.02, 0.08), fadeOutRms: rms(9.92, 9.98), rejected: ['video-gap', 'video-overlap', 'short-video', 'short-audio'] } }, null, 2));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('killed media subprocess reports its signal instead of an unexplained null exit', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-compositor-signal-'));
  try {
    const probe = join(dir, 'killed-probe');
    await writeFile(probe, '#!/bin/sh\nkill -KILL $$\n'); await chmod(probe, 0o755);
    await assert.rejects(probeMedia('unused', probe), error => error.code === 'MEDIA_EXECUTION_FAILED' && /signal SIGKILL/.test(error.message));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const cjkCollection = process.env.STUDIO_TEST_CJK_FONT || '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc';
test('actual 门/曾 caption pixels use the named Simplified Chinese face, not the TTC Japanese default', { skip: !existsSync(cjkCollection) }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-compositor-sc-font-'));
  try {
    const spec = join(dir, 'spec.json'), actual = join(dir, 'actual.png');
    await writeFile(spec, JSON.stringify({ width: 512, height: 256, fontSize: 96, text: '门曾', x: .5, y: .5, color: '#ffffff' }));
    const env = { ...process.env, STUDIO_FONT_PATH: cjkCollection };
    const rendered = spawnSync(process.env.STUDIO_PYTHON_BIN || 'python3', ['-c', PANEL_SCRIPT, spec, actual], { env });
    assert.equal(rendered.status, 0, rendered.stderr.toString());
    const compared = spawnSync(process.env.STUDIO_PYTHON_BIN || 'python3', ['-c', `import sys,json,os
from PIL import Image,ImageDraw,ImageFont,ImageChops
fonts=[]
for index in range(64):
    try: font=ImageFont.truetype(sys.argv[1],96,index=index)
    except OSError: break
    fonts.append((index,font))
sc=next((i,f) for i,f in fonts if f.getname()[0]=='Noto Sans CJK SC')
jp=next((i,f) for i,f in fonts if f.getname()[0]=='Noto Sans CJK JP')
def glyph(font):
    image=Image.new('L',(512,256)); ImageDraw.Draw(image).text((80,50),'门曾',font=font,fill=255)
    return image.crop(image.getbbox())
actual=Image.open(sys.argv[2]).getchannel('R'); actual=actual.crop(actual.getbbox())
expected=glyph(sc[1]); wrong=glyph(jp[1])
same=lambda a,b:a.size==b.size and ImageChops.difference(a,b).getbbox() is None
expected.save(os.path.join(sys.argv[3],'expected-sc.png')); wrong.save(os.path.join(sys.argv[3],'default-jp.png'))
print(json.dumps({'scIndex':sc[0],'scFamily':sc[1].getname()[0],'jpIndex':jp[0],'jpFamily':jp[1].getname()[0],'matchesSC':same(actual,expected),'matchesJP':same(actual,wrong)}))
`, cjkCollection, actual, dir], { env });
    assert.equal(compared.status, 0, compared.stderr.toString());
    const result = JSON.parse(compared.stdout.toString());
    assert.equal(result.matchesSC, true, 'the production panel must rasterize the actual SC glyphs');
    assert.equal(result.matchesJP, false, 'the affected characters must differ from the default JP glyphs');
    if (process.env.STUDIO_TEST_FONT_OUTPUT_DIR) {
      const evidence = process.env.STUDIO_TEST_FONT_OUTPUT_DIR;
      await mkdir(evidence, { recursive: true });
      for (const name of ['actual.png', 'expected-sc.png', 'default-jp.png']) await copyFile(join(dir, name), join(evidence, name));
      await writeFile(join(evidence, 'glyph-receipt.json'), JSON.stringify(result, null, 2));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
