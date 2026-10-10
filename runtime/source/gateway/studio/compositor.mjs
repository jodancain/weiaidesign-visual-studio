/** Frame-exact Studio v3 compositor. No network, relay, implicit loops or stretches. */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, rename, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const FPS = 24;
function fail(message, code = 'INVALID_SEQUENCE') {
  const error = new Error(message); error.code = code; throw error;
}
function run(bin, args, { timeout = 600_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', b => { stdout += b; if (stdout.length > 4e6) stdout = stdout.slice(-4e6); });
    child.stderr.on('data', b => { stderr += b; if (stderr.length > 20000) stderr = stderr.slice(-20000); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) { const e = new Error(`${bin} failed (${timedOut ? `timeout after ${timeout}ms; ` : ''}${signal ? `signal ${signal}` : `exit ${code}`}): ${stderr.slice(-3500)}`); e.code = 'MEDIA_EXECUTION_FAILED'; reject(e); }
      else resolve(stdout);
    });
  });
}
export async function probeMedia(path, ffprobePath = process.env.FFPROBE_BIN || 'ffprobe') {
  return JSON.parse(await run(ffprobePath, ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', path]));
}
const rational = value => { const [n, d = 1] = String(value).split('/').map(Number); return n / d; };
const seconds = frames => String(frames / FPS);
const integer = value => Number.isSafeInteger(value);
const durationOf = (stream, media) => Number(stream?.duration ?? media.format?.duration ?? 0);

function validate(project) {
  const seq = project?.sequence;
  if (project?.fps !== FPS || seq?.fps !== FPS) fail('Studio exports require 24 fps');
  if (!integer(seq.totalFrames) || seq.totalFrames < 1 || seq.totalFrames > 24 * 60 * 30) fail('Invalid totalFrames');
  if (!Array.isArray(seq.clips) || seq.clips.length > 1000) fail('Invalid sequence clips');
  const ids = new Set();
  for (const clip of seq.clips) {
    if (!clip.id || ids.has(clip.id)) fail('Clip ids must be unique'); ids.add(clip.id);
    if (!['video', 'audio', 'text'].includes(clip.kind)) fail(`Unknown clip kind: ${clip.kind}`);
    if (![clip.startFrame, clip.endFrame, clip.sourceIn ?? 0].every(integer) || clip.sourceIn < 0 || clip.startFrame < 0 || clip.endFrame <= clip.startFrame || clip.endFrame > seq.totalFrames) fail(`Invalid frame interval: ${clip.id}`);
    if (!integer(clip.track) || clip.track < 0) fail(`Invalid track: ${clip.id}`);
    if (clip.kind !== 'text' && !clip.assetId) fail(`Missing asset: ${clip.id}`);
    if (clip.kind === 'text' && (typeof clip.text !== 'string' || !clip.text.trim() || clip.text.length > 2000)) fail(`Invalid text: ${clip.id}`);
    for (const key of ['fadeIn', 'fadeOut']) {
      if (!integer(clip[key] ?? 0) || (clip[key] ?? 0) < 0 || (clip[key] ?? 0) > clip.endFrame - clip.startFrame) fail(`Invalid ${key}: ${clip.id}`);
    }
    if (!Number.isFinite(clip.volume ?? 1) || (clip.volume ?? 1) < 0 || (clip.volume ?? 1) > 4) fail(`Invalid volume: ${clip.id}`);
  }
  const videos = seq.clips.filter(c => c.kind === 'video').sort((a, b) => a.startFrame - b.startFrame);
  let cursor = 0;
  for (const clip of videos) {
    if (clip.startFrame !== cursor) fail(`Video ${clip.startFrame > cursor ? 'gap' : 'overlap'} at frame ${Math.min(cursor, clip.startFrame)}`, 'VIDEO_COVERAGE_ERROR');
    cursor = clip.endFrame;
  }
  if (cursor !== seq.totalFrames) fail(`Video gap at frame ${cursor}`, 'VIDEO_COVERAGE_ERROR');
  return { seq, videos };
}

// Pillow is used because several FFmpeg distributions omit libfreetype/drawtext.
// Text is data in JSON, never inserted into shell/filter expressions.
export const PANEL_SCRIPT = `import json,sys,os,re
from PIL import Image,ImageDraw,ImageFont
spec=json.load(open(sys.argv[1],encoding='utf8'))
candidates=[os.environ.get('STUDIO_FONT_PATH',''),'/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc','/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc','/System/Library/Fonts/Supplemental/Arial Unicode.ttf','C:/Windows/Fonts/msyh.ttc','/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']
fontpath=next((p for p in candidates if p and os.path.isfile(p)),None)
if not fontpath: raise RuntimeError('Text rendering needs a font; set STUDIO_FONT_PATH')
font=ImageFont.truetype(fontpath,spec['fontSize'],index=0)
# A TTC can default to Japanese even when it also includes Simplified Chinese.
# Keep the chosen file (including STUDIO_FONT_PATH), select its named SC face,
# and retain face 0 when that file has no SC face. Never assume a fixed index.
with open(fontpath,'rb') as f: is_collection=f.read(4)==b'ttcf'
if is_collection:
    sc_fallback=None
    for face_index in range(64):
        try: candidate=ImageFont.truetype(fontpath,spec['fontSize'],index=face_index)
        except OSError: break
        family=candidate.getname()[0]
        if re.search(r'(^|[^A-Za-z])SC($|[^A-Za-z])',family,re.I):
            if 'mono' not in family.lower():
                font=candidate
                break
            if sc_fallback is None: sc_fallback=candidate
    if not re.search(r'(^|[^A-Za-z])SC($|[^A-Za-z])',font.getname()[0],re.I) and sc_fallback is not None: font=sc_fallback
im=Image.new('RGBA',(spec['width'],spec['height']),(0,0,0,0)); d=ImageDraw.Draw(im)
text=spec['text']; box=d.multiline_textbbox((0,0),text,font=font,spacing=8)
x=spec['x']*im.width-(box[2]-box[0])/2; y=spec['y']*im.height-(box[3]-box[1])/2; pad=12
d.rounded_rectangle((max(0,x-pad),max(0,y-pad),min(im.width,x+box[2]-box[0]+pad),min(im.height,y+box[3]-box[1]+pad)),radius=8,fill=(0,0,0,180))
d.multiline_text((x-box[0],y-box[1]),text,font=font,fill=spec['color'],spacing=8)
im.save(sys.argv[2])
`;

/** resolveAsset receives an assetId and must return an existing local filename. */
export async function exportSequence({ project, outputPath, resolveAsset, ffmpegPath = process.env.FFMPEG_BIN || 'ffmpeg', ffprobePath = process.env.FFPROBE_BIN || 'ffprobe', commitFile = rename }) {
  const { seq, videos } = validate(project);
  if (typeof resolveAsset !== 'function' || !outputPath) fail('outputPath and resolveAsset are required');
  const width = project.aspect === '9:16' ? 720 : 1280;
  const height = project.aspect === '9:16' ? 1280 : 720;
  const dir = await mkdtemp(join(tmpdir(), 'studio-compose-'));
  const outputDir = dirname(outputPath);
  await mkdir(outputDir, { recursive: true });
  // Keep staging on the target filesystem; rename is atomic even with /tmp on another volume.
  const staged = join(outputDir, `.studio-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.mp4`);
  try {
    const assets = new Map();
    for (const clip of seq.clips.filter(c => c.kind !== 'text')) {
      if (!assets.has(clip.assetId)) {
        const path = await resolveAsset(clip.assetId);
        if (typeof path !== 'string' || !path || /^(https?|file):/i.test(path)) fail(`Asset must resolve to a local file: ${clip.assetId}`);
        await access(path);
        assets.set(clip.assetId, { path, media: await probeMedia(path, ffprobePath) });
      }
      const { media } = assets.get(clip.assetId);
      const stream = media.streams.find(s => s.codec_type === clip.kind);
      if (!stream) fail(`Asset has no ${clip.kind} stream: ${clip.assetId}`);
      const available = durationOf(stream, media) * FPS;
      const needed = (clip.sourceIn ?? 0) + clip.endFrame - clip.startFrame;
      if (!Number.isFinite(available) || available + 0.01 < needed) fail(`Source ${clip.assetId} is too short: requires frame ${needed}, available ${available.toFixed(3)}`, 'SOURCE_TOO_SHORT');
    }
    // Bound independent decoders/filter pools: many 720p clips and overlays must
    // not each auto-size a frame pool to every CPU on the host.
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-filter_threads', '1', '-filter_complex_threads', '1'];
    const indices = new Map();
    for (const [id, asset] of assets) { indices.set(id, indices.size); args.push('-threads', '1', '-i', asset.path); }
    const filters = [];
    videos.forEach((clip, i) => {
      const start = clip.sourceIn ?? 0, end = start + clip.endFrame - clip.startFrame;
      filters.push(`[${indices.get(clip.assetId)}:v:0]fps=${FPS}:eof_action=pass,trim=start_frame=${start}:end_frame=${end},setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v${i}]`);
    });
    filters.push(`${videos.map((_, i) => `[v${i}]`).join('')}concat=n=${videos.length}:v=1:a=0[base]`);
    let videoLabel = 'base';
    const panels = seq.clips.filter(c => c.kind === 'text').sort((a, b) => a.track - b.track);
    for (let i = 0; i < panels.length; i++) {
      const clip = panels[i];
      const spec = { width, height, text: clip.text, fontSize: clip.fontSize ?? 36, color: clip.color ?? '#ffffff', x: clip.x ?? .5, y: clip.y ?? .82 };
      if (!integer(spec.fontSize) || spec.fontSize < 8 || spec.fontSize > 240 || !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(spec.color) || ![spec.x, spec.y].every(Number.isFinite) || spec.x < 0 || spec.y < 0 || spec.x > 1 || spec.y > 1) fail(`Invalid text layout: ${clip.id}`);
      const json = join(dir, `panel-${i}.json`), png = join(dir, `panel-${i}.png`);
      await writeFile(json, JSON.stringify(spec));
      await run(process.env.STUDIO_PYTHON_BIN || 'python3', ['-c', PANEL_SCRIPT, json, png], { timeout: 30_000 });
      const index = assets.size + i;
      // Decode a static panel once; overlay retains that frame. Looping every
      // full-resolution RGBA PNG needlessly queues an entire video per caption.
      args.push('-threads', '1', '-framerate', String(FPS), '-i', png);
      filters.push(`[${videoLabel}][${index}:v:0]overlay=eof_action=repeat:repeatlast=1:enable='gte(n,${clip.startFrame})*lt(n,${clip.endFrame})'[panel${i}]`);
      videoLabel = `panel${i}`;
    }
    const totalSamples = seq.totalFrames * 2000;
    filters.push(`anullsrc=r=48000:cl=stereo,atrim=end_sample=${totalSamples}[silence]`);
    const audioLabels = ['silence'];
    for (const clip of seq.clips.filter(c => c.kind === 'audio' || c.kind === 'video')) {
      const asset = assets.get(clip.assetId);
      if (!asset.media.streams.some(s => s.codec_type === 'audio') || (clip.volume ?? 1) === 0) continue;
      const label = `a${audioLabels.length}`;
      const length = clip.endFrame - clip.startFrame;
      let chain = `[${indices.get(clip.assetId)}:a:0]aresample=48000,atrim=start_sample=${(clip.sourceIn ?? 0) * 2000}:end_sample=${((clip.sourceIn ?? 0) + length) * 2000},asetpts=PTS-STARTPTS,volume=${clip.volume ?? 1}`;
      if (clip.fadeIn) chain += `,afade=t=in:st=0:d=${seconds(clip.fadeIn)}`;
      if (clip.fadeOut) chain += `,afade=t=out:st=${seconds(length - clip.fadeOut)}:d=${seconds(clip.fadeOut)}`;
      chain += `,adelay=${clip.startFrame * 2000}S:all=1[${label}]`;
      filters.push(chain); audioLabels.push(label);
    }
    filters.push(`${audioLabels.map(l => `[${l}]`).join('')}amix=inputs=${audioLabels.length}:normalize=0:dropout_transition=0,alimiter=limit=0.95:latency=1,atrim=end_sample=${totalSamples}[audio]`);
    const filterPath = join(dir, 'filters.txt'); await writeFile(filterPath, filters.join(';\n'));
    args.push('-/filter_complex', filterPath, '-map', `[${videoLabel}]`, '-map', '[audio]', '-frames:v', String(seq.totalFrames), '-t', seconds(seq.totalFrames), '-r', String(FPS), '-c:v', 'libx264', '-threads:v', '2', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-threads:a', '1', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', staged);
    await run(ffmpegPath, args);
    const result = await probeMedia(staged, ffprobePath);
    const video = result.streams.find(s => s.codec_type === 'video');
    const audio = result.streams.find(s => s.codec_type === 'audio');
    const frames = Number(video?.nb_read_frames);
    if (frames !== seq.totalFrames || rational(video?.avg_frame_rate) !== FPS || Number(video?.width) !== width || Number(video?.height) !== height) fail(`Rendered video does not match the sequence: got ${frames} frames`, 'OUTPUT_VALIDATION_FAILED');
    if (!audio || Math.abs(durationOf(audio, result) - seq.totalFrames / FPS) > 1 / FPS) fail('Output audio duration does not match the sequence', 'OUTPUT_VALIDATION_FAILED');
    await commitFile(staged, outputPath);
    return { path: outputPath, frames, fps: FPS, duration: seq.totalFrames / FPS, width, height };
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(staged, { force: true });
  }
}
