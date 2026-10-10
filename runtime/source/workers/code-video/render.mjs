import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { exportSequence, probeMedia } from '../../gateway/studio/compositor.mjs';
import { atomicWrite, atomicJSON, durableRename, callbackQueue } from './durable-io.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '../..');
const require = createRequire(join(ROOT, 'web/package.json'));
export const sha256 = data => createHash('sha256').update(data).digest('hex');
export const frameName = n => `frame-${String(n).padStart(6, '0')}.png`;
export async function fileHash(path) { return sha256(await readFile(path)); }
let runtimeHashPromise;
export function runtimeHash() {
  return runtimeHashPromise ||= (async()=>{
    const entries=[];
    async function scan(dir){for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const path=join(dir,entry.name);if(entry.isDirectory()&&!entry.name.startsWith('.')&&entry.name!=='node_modules')await scan(path);else if(entry.isFile()&&/\.(mjs|ts|tsx|json|ps1)$/.test(entry.name))entries.push([path.slice(ROOT.length+1).replaceAll('\\','/'),await fileHash(path)]);}}
    await scan(HERE);await scan(join(ROOT,'web/lib/studio'));
    entries.push(['gateway/studio/compositor.mjs',await fileHash(join(ROOT,'gateway/studio/compositor.mjs'))]);
    entries.push(['gateway/studio/effects-program.mjs',await fileHash(join(ROOT,'gateway/studio/effects-program.mjs'))]);
    entries.push(['ffmpeg',sha256(await run(process.env.FFMPEG_BIN||'ffmpeg',['-version']))]);
    entries.push(['ffprobe',sha256(await run(process.env.FFPROBE_BIN||'ffprobe',['-version']))]);
    const fonts=[process.env.STUDIO_FONT_PATH,'/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc','/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc','/System/Library/Fonts/Supplemental/Arial Unicode.ttf','C:/Windows/Fonts/msyh.ttc','/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'];
    for(const font of fonts){if(font&&await stat(font).then(()=>true,()=>false)){entries.push(['captionFont',await fileHash(font)]);break;}}
    entries.push(['pillow', (await run(process.env.STUDIO_PYTHON_BIN||'python3',['-c','import PIL;print(PIL.__version__)'])).trim()]);
    const chrome=chromePath();if(await stat(chrome).then(()=>true,()=>false))entries.push(['chromeExecutable',await fileHash(chrome)]);
    if(process.platform==='darwin'){const info=resolve(dirname(chrome),'../Info.plist');if(await stat(info).then(()=>true,()=>false))entries.push(['chromeBundleVersion',await fileHash(info)]);}
    for(const name of ['remotion','@remotion/three','@remotion/renderer','@remotion/bundler','three','react','@react-three/fiber'])entries.push([name,JSON.parse(await readFile(join(ROOT,'web/node_modules',name,'package.json'),'utf8')).version]);
    return sha256(JSON.stringify(entries));
  })();
}
export async function run(bin, args, { cwd, signal, timeout = 3600000 } = {}) {
  return new Promise((res, rej) => {
    const child = spawn(bin, args, { cwd, signal, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', b => { stdout = (stdout + b).slice(-2e6); });
    child.stderr.on('data', b => { stderr = (stderr + b).slice(-2e5); });
    child.on('error', e => { clearTimeout(timer); rej(e); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? res(stdout) : rej(Error(`${bin} exit ${code}: ${stderr.slice(-5000)}`)); });
  });
}
function chromePath() {
  return process.env.STUDIO_CHROME_BIN || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome');
}
const glMode = () => process.env.STUDIO_CHROME_GL || 'angle';
export async function localServer(dir) {
  const server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (path.includes('..') || path.includes('\\')) throw Error('bad path');
      const file = join(dir, path === '/' ? 'index.html' : path);
      const data = await readFile(file);
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.html') ? 'text/html' : file.endsWith('.json') ? 'application/json' : 'application/octet-stream');
      res.end(data);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(res => server.listen(0, '127.0.0.1', res));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(res => server.close(res)) };
}
export async function renderPngs({ spec, dir, frames, progress = async () => {}, onShot = async () => {}, signal }) {
  dir = resolve(dir);
  if (!['three-webgl', 'remotion'].includes(spec.backend)) throw Error('Unknown renderer');
  if (spec.runtimeHash && spec.runtimeHash !== await runtimeHash()) throw Error('Frozen renderer revision unavailable; restore the original worker release');
  if (spec.fps !== 24 || !Number.isSafeInteger(spec.totalFrames) || spec.totalFrames < 1 || spec.totalFrames > 43200 || ![720,1280].includes(spec.width) || ![720,1280].includes(spec.height)) throw Error('Invalid render dimensions');
  const start = performance.now(), timings = {}, pngDir = join(dir, 'frames');
  await mkdir(pngDir, { recursive: true });
  const binding={runtimeHash:await runtimeHash(),specHash:sha256(JSON.stringify(spec)),backend:spec.backend};
  const bindingFile=join(dir,'render-binding.json');
  const oldBinding=await readFile(bindingFile,'utf8').then(JSON.parse,e=>{if(e.code==='ENOENT')return null;throw e;});
  if(oldBinding&&JSON.stringify(oldBinding)!==JSON.stringify(binding))throw Error('Frame checkpoint belongs to a different immutable render input');
  if(!oldBinding)await writeFile(bindingFile,JSON.stringify(binding),{flag:'wx'});
  const wanted = frames || Array.from({ length: spec.totalFrames }, (_, i) => i);
  if (wanted.some(n => !Number.isInteger(n) || n < 0 || n >= spec.totalFrames)) throw Error('Invalid absolute frame');
  const missing = [];
  for (const n of wanted) { try { const b = await readFile(join(pngDir, frameName(n))), hash=await readFile(join(pngDir,frameName(n)+'.sha256'),'utf8'); if (b.length < 100 || b.subarray(1,4).toString() !== 'PNG' || sha256(b)!==hash) missing.push(n); } catch { missing.push(n); } }
  async function checkpoint(frame,buffer){const path=join(pngDir,frameName(frame));await atomicWrite(path,buffer);await atomicWrite(path+'.sha256',sha256(buffer));}
  let gpu = null, browserVersion = null;
  const previous=await readFile(join(dir,'render-receipt.json'),'utf8').then(JSON.parse,()=>null);
  const sessionFile=join(dir,'render-session.json');
  if(!missing.length){
    const original=previous||await readFile(sessionFile,'utf8').then(JSON.parse,()=>null);
    if(!original?.gpu||!original?.browserVersion)throw Error('Completed frames lack renderer execution provenance; restore the original receipt');
    const reused={...original,frameCount:wanted.length,renderedNow:0,reusedFrames:wanted.length,resumes:[...(original.resumes||[]),{at:new Date().toISOString(),reusedFrames:wanted.length,validationMs:performance.now()-start}]};
    await atomicJSON(join(dir,'render-receipt.json'),reused);return{pngDir,receipt:reused};
  }
  const browserExecutable = chromePath(), gl = glMode();
  if (missing.length && spec.backend === 'three-webgl') {
    const bundleStart = performance.now(), bundleDir = join(dir, 'three-app'); await mkdir(bundleDir, { recursive: true });
    await require('esbuild').build({ entryPoints: [join(HERE, 'three-entry.ts')], bundle: true, outfile: join(bundleDir, 'app.js'), platform: 'browser', format: 'iife', nodePaths: [join(ROOT, 'web/node_modules')], sourcemap: false, logLevel: 'silent' });
    await writeFile(join(bundleDir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><script src="/app.js"></script></body></html>');
    timings.bundleMs = performance.now() - bundleStart;
    const host = await localServer(bundleDir);
    let browser;
    try {
      const args = gl === 'swangle' ? ['--use-gl=angle', '--use-angle=swiftshader'] : [`--use-gl=${gl}`];
      const launchStart = performance.now();
      browser = await require('playwright').chromium.launch({ executablePath: browserExecutable, headless: true, args: [...args, '--force-color-profile=srgb', '--force-device-scale-factor=1'] });
      browserVersion = browser.version(); timings.startupMs = performance.now() - launchStart;
      const page = await browser.newPage({ viewport: { width: spec.width, height: spec.height }, deviceScaleFactor: 1 });
      const errors = []; page.on('pageerror', error => errors.push(String(error)));
      await page.route('**/*', route => route.request().url().startsWith(host.url + '/') || route.request().url().startsWith('data:') ? route.continue() : route.abort());
      await page.goto(host.url); await page.waitForFunction(() => Boolean(window.codeVideo));
      gpu = await page.evaluate(s => window.codeVideo.initialize(s), spec);
      timings.resourceLoadMs = gpu.resourceLoadMs;
      await atomicJSON(sessionFile,{backend:spec.backend,runtimeHash:binding.runtimeHash,sceneSnapshotHash:spec.sceneSnapshotHash,renderProfileHash:spec.renderProfileHash,browserExecutable,browserVersion,gl,gpu,timings});
      const frameStart = performance.now();
      for (const frame of missing) {
        signal?.throwIfAborted();
        const metadata = await page.evaluate(n => window.codeVideo.renderFrame(n), frame);
        await checkpoint(frame,await page.screenshot({ type: 'png', animations: 'disabled', scale: 'css' }));
        if (errors.length) throw Error(errors.join('\n'));
        if (frame % 144 === 0 || frame % 144 === 71 || frame % 144 === 143) await writeFile(join(pngDir, `frame-${String(frame).padStart(6,'0')}.json`), JSON.stringify(metadata));
        if (frame % 144 === 143) await onShot(frame - 143, 144);
        await progress({ stage: 'rendering', frame, completedFrames: wanted.length - missing.length + missing.indexOf(frame) + 1, totalFrames: wanted.length });
      }
      timings.framesMs = performance.now() - frameStart;
    } finally { await browser?.close(); await host.close(); }
  } else if (missing.length) {
    const { bundle } = require('@remotion/bundler');
    const { openBrowser, renderFrames, makeCancelSignal } = require('@remotion/renderer');
    const bundleStart = performance.now();
    const serveUrl = await bundle({ entryPoint: join(HERE, 'remotion-entry.tsx'), outDir: join(dir, 'remotion-app'), webpackOverride: config => ({ ...config, resolve: { ...config.resolve, modules: [join(ROOT, 'web/node_modules'), ...(config.resolve?.modules || ['node_modules'])] } }), onProgress: () => {} });
    timings.bundleMs = performance.now() - bundleStart;
    const launchStart = performance.now();
    const browser = await openBrowser('chrome', { browserExecutable, chromiumOptions: { gl }, forceDeviceScaleFactor: 1, logLevel: 'error' });
    browserVersion=(await browser.connection.send('Browser.getVersion')).value.product.replace(/^Chrome\//,'');
    timings.startupMs = performance.now() - launchStart;
    const cancel = makeCancelSignal(); const abort = () => cancel.cancel(); signal?.addEventListener('abort', abort, { once: true });
    const callbacks = callbackQueue(() => cancel.cancel());
    try {
      const frameStart = performance.now();
      let renderError;
      try { await renderFrames({ serveUrl, puppeteerInstance: browser, browserExecutable, chromiumOptions: { gl },
        composition: { id: 'CodeFilm', durationInFrames: spec.totalFrames, fps: 24, width: spec.width, height: spec.height, props: { spec }, defaultProps: { spec } },
        inputProps: { spec }, imageFormat: 'png', outputDir: null, frames: missing, concurrency: 1, scale: 1, logLevel: 'error',
        timeoutInMilliseconds: 120000, cancelSignal: cancel.cancelSignal,
        onBrowserLog: log => { const message = log.text || ''; const i = message.indexOf('CODE_VIDEO_GPU:'); if (i >= 0) { try { gpu = JSON.parse(message.slice(i + 15));callbacks.push(()=>atomicJSON(sessionFile,{backend:spec.backend,runtimeHash:binding.runtimeHash,sceneSnapshotHash:spec.sceneSnapshotHash,renderProfileHash:spec.renderProfileHash,browserExecutable,browserVersion,gl,gpu,timings})); } catch {} } const j=message.indexOf('CODE_VIDEO_LOAD:');if(j>=0)timings.resourceLoadMs=Number(message.slice(j+16)); },
        onFrameBuffer: async (buffer, frame) => { await callbacks.drain();await checkpoint(frame,buffer); if (frame % 144 === 143) await onShot(frame - 143, 144); },
        onFrameUpdate: (count, frame) => { callbacks.push(()=>progress({ stage: 'rendering', frame, completedFrames: wanted.length - missing.length + count, totalFrames: wanted.length })); },
      }); } catch (error) { renderError=error; }
      await callbacks.drain();
      if(renderError)throw renderError;
      timings.framesMs = performance.now() - frameStart;
    } finally { signal?.removeEventListener('abort', abort); await browser.close({ silent: true }); }
  }
  timings.totalRenderMs = performance.now() - start;
  const dependencies = {};
  for (const name of ['remotion', '@remotion/three', '@remotion/renderer', '@remotion/bundler', 'three', 'react', '@react-three/fiber']) dependencies[name] = JSON.parse(await readFile(join(ROOT,'web/node_modules',name,'package.json'),'utf8')).version;
  const receipt = { backend: spec.backend, runtimeHash:await runtimeHash(), sceneSnapshotHash: spec.sceneSnapshotHash, renderProfileHash: spec.renderProfileHash, specHash: spec.specHash, frameCount: wanted.length, renderedNow: missing.length, reusedFrames: wanted.length - missing.length, browserExecutable, browserVersion, gl, gpu, dependencies, timings };
  await atomicJSON(join(dir, 'render-receipt.json'), receipt);
  return { pngDir, receipt };
}
export async function encodeClean({ dir, spec, startFrame = 0, count = spec.totalFrames, shotOnly = false, signal }) {
  const path = join(dir, !shotOnly && startFrame === 0 && count === spec.totalFrames ? 'clean.mp4' : `shot-${startFrame}-${startFrame + count}.mp4`);
  const staged=path+'.encoding.mp4';
  const t = performance.now();
  await run(process.env.FFMPEG_BIN || 'ffmpeg', ['-hide_banner','-loglevel','error','-nostdin','-y','-framerate','24','-start_number',String(startFrame),'-i',join(dir,'frames','frame-%06d.png'),'-frames:v',String(count),'-an','-c:v','libx264','-threads','4','-preset','medium','-crf','16','-pix_fmt','yuv420p','-r','24','-fps_mode','cfr','-video_track_timescale','24000','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-movflags','+faststart',staged], { signal });
  await durableRename(staged,path);
  return { path, encodingMs: performance.now() - t };
}
export async function finishFilm({ cleanPath, dir, spec, assets = [], name = 'base.mp4' }) {
  const clips = (spec.sequence?.clips || []).filter(c => c.kind === 'text' || c.kind === 'audio');
  const totalFrames = spec.totalFrames;
  const project = { fps: 24, aspect: spec.width > spec.height ? '16:9' : '9:16', sequence: { fps:24,totalFrames,clips:[{id:'clean-video',kind:'video',assetId:'__clean',startFrame:0,endFrame:totalFrames,sourceIn:0,track:0,volume:0}, ...clips] } };
  const path = join(dir, name), t = performance.now();
  await exportSequence({ project, outputPath: path, resolveAsset: id => id === '__clean' ? cleanPath : assets.find(a=>a.id === id)?.path, commitFile: durableRename });
  return { path, compositingMs: performance.now()-t, narration: false };
}
export async function mediaEvidence(path) {
  const probe = await probeMedia(path); const v = probe.streams.find(s=>s.codec_type==='video'), a = probe.streams.find(s=>s.codec_type==='audio');
  await run(process.env.FFMPEG_BIN || 'ffmpeg', ['-v','error','-i',path,'-f','null','-']);
  return { sha256: await fileHash(path), bytes:(await stat(path)).size, frames:Number(v?.nb_read_frames), fps:v?.avg_frame_rate, width:v?.width,height:v?.height, videoDuration:Number(v?.duration), audioDuration:a ? Number(a.duration) : null, fullDecode:true };
}
