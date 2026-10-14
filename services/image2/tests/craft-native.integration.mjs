/** Opt-in real binaries + OS sandbox acceptance. Never substitutes a protocol fixture. */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { unzipSync } from 'fflate';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
import { createCraftRuntime } from '../craft-runtime.mjs';

const s = (command, args = {}) => ({ command, args });
const output = name => ({ outputName: name });
const asset = assetId => ({ assetId });
const ref = resultRef => ({ resultRef });
const png = s('export', { path: output('result.png'), format: 'png', scale: 1 });
const cases = {
  photocraft: { first: [s('doc_open', { path: asset('image') }), s('image.adjustments.invert'), s('doc_export', { path: output('result.png') })], second: [s('doc_export', { path: output('result.png') })], compare: 'result.png' },
  vectorcraft: { first: [s('new', { width: 128, height: 96 }), s('draw_path', { points: [[8, 8], [110, 18], [60, 80]], closed: true, fill: '#136a9f', stroke: 'none' }), png], second: [png], compare: 'result.png' },
  filmcraft: { first: [s('file.import', { paths: [asset('image')] }), s('file.newSequenceFromClip', { items: [ref('0.items.0')] }), s('render_preview', { seconds: 0, max_side: 128 })], second: [s('render_preview', { seconds: 0, max_side: 128 })], preview: true },
  lightcraft: { first: [s('import', { paths: [asset('image')], mode: 'copy' }), s('set_develop', { values: { 'light.exposure': 0.5 } }), s('export', { path: output('result.png'), format: 'png' })], second: [s('export', { path: output('result.png'), format: 'png' })], compare: 'result.png' },
  pdfcraft: { first: [s('new', { width: 256, height: 192 }), s('page_add_text', { doc: ref('0.doc'), page: 1, text: 'Native Probe', at: [16, 16], size: 18 }), s('page_add_image', { doc: ref('0.doc'), page: 1, path: asset('image'), rect: [16, 50, 160, 100] }), s('render_preview', { max_side: 256 })], second: [s('render_preview', { max_side: 256 })], preview: true },
  effectcraft: { first: [s('comp.new', { name: 'Native Probe', width: 128, height: 96, duration: 1, frameRate: 24 }), s('file.import', { paths: [asset('image')], sequence: false, addToComp: true, background: false }), s('layer.newSolid', { name: 'Blue', color: '#136a9f', width: 64, height: 48 }), s('render_frame', { path: output('result.png'), max_side: 128 })], second: [s('render_frame', { path: output('result.png'), max_side: 128 })], compare: 'result.png' },
  designcraft: { first: [s('new', { width: 256, height: 192 }), s('frame.create', { rect: [20, 20, 210, 80], content: 'text', text: 'Native Probe' }), s('export_png', { path: output('result.png'), page: 0, scale: 1 })], second: [s('export_png', { path: output('result.png'), page: 0, scale: 1 })], compare: 'result.png' },
  figcraft: { first: [s('create_node', { type: 'rectangle', name: 'Native Probe', x: 10, y: 10, width: 128, height: 96, props: { fill: '#136a9f', cornerRadius: 8 } }), png], second: [png], compare: 'result.png' },
  wordcraft: { first: [s('font.add', { path: asset('font') }), s('format.font', { name: 'Craft Acceptance Face' }), s('type_text', { text: 'Native Probe: persistent document.' }), s('render_page', { page: 1, scale: 1 })], second: [s('render_page', { page: 1, scale: 1 })], preview: true },
  soundcraft: { first: [s('import_audio', { path: asset('audio') }), s('bounce_mix', { path: output('result.wav'), format: 'wav', start: { seconds: 0 }, end: { seconds: 0.25 } })], second: [s('bounce_mix', { path: output('result.wav'), format: 'wav', start: { seconds: 0 }, end: { seconds: 0.25 } })], compare: 'result.wav' },
  deckcraft: { first: [s('add_shape', { preset: 'rect', x: 30, y: 30, w: 160, h: 100, text: 'Native Probe', fill: '#136a9f' }), s('export', { path: output('result.png'), format: 'png', slide: 0, scale: 1 })], second: [s('export', { path: output('result.png'), format: 'png', slide: 0, scale: 1 })], compare: 'result.png' },
  cadcraft: { first: [s('circle', { center: [10, 10], radius: 8 }), s('line', { points: [[0, 0], [20, 20]] }), s('xattach', { path: asset('cad-reference'), name: 'Reference', at: [30, 0] }), s('xref'), s('render', { path: output('result.png'), width: 256, height: 192 })], second: [s('-xref', { option: 'reload', names: 'Reference' }), s('xref'), s('render', { path: output('result.png'), width: 256, height: 192 })], compare: 'result.png' },
  gridcraft: { first: [s('cell.set', { cell: 'A1', input: 'Native Probe' }), s('cell.set', { cell: 'B1', input: '=6*7' }), s('read_range', { range: 'A1:B1' })], second: [s('read_range', { range: 'A1:B1' })], values: true },
};

// These invoke the engines' real writers, independently of the PNG previews.
const exportCases = {
  vectorcraft: { steps: [s('export', { path: output('result.svg'), format: 'svg' })], files: ['result.svg'] },
  filmcraft: { steps: [s('file.exportMedia', { path: output('result.mp4'), format: 'h264', width: 128, height: 96, fps: 12, range: 'custom', startSeconds: 0, endSeconds: 0.25, audio: false, wait: true }), s('file.import', { paths: [output('result.mp4')] }), s('file.newSequenceFromClip', { items: [ref('4.items.0')] }), s('render_preview', { seconds: 0, max_side: 128 })], files: ['result.mp4'] },
  pdfcraft: { files: ['document.pdf'] },
  effectcraft: { steps: [s('renderQueue.add', { output: output('result.mp4'), format: 'h264', timeSpan: 'custom', start: 0, end: 0.25, frameRate: 12, audio: 'off' }), s('renderQueue.render', { wait: true }), s('file.import', { paths: [output('result.mp4')], addToComp: true, background: false }), s('render_frame', { path: output('result.png'), max_side: 128 })], files: ['result.mp4'] },
  designcraft: { steps: [s('file.exportPdf', { path: output('result.pdf') })], files: ['result.pdf'] },
  wordcraft: { files: ['document.docx'] },
  deckcraft: { steps: [s('export', { path: output('result.pptx'), format: 'pptx' })], files: ['result.pptx'] },
  cadcraft: { steps: [s('save', { path: output('result.pdf') })], files: ['document.dxf', 'result.pdf'] },
  gridcraft: { steps: [s('save_workbook', { path: output('result.xlsx') })], files: ['result.xlsx'] },
};

async function inspectFormat(file, directory) {
  const extension = path.extname(file.name).slice(1), bytes = file.bytes;
  assert.ok(bytes.length > 32, `${file.name} is empty`);
  const local = path.join(directory, file.name); await fs.writeFile(local, bytes);
  if (['docx', 'pptx', 'xlsx'].includes(extension)) {
    const entries = unzipSync(bytes), member = { docx: 'word/document.xml', pptx: 'ppt/presentation.xml', xlsx: 'xl/workbook.xml' }[extension];
    assert.ok(entries['[Content_Types].xml'] && entries[member], `Not a real ${extension} package`);
    const xml = Buffer.from(entries[member]).toString(); assert.match(xml, /^<\?xml|^<[^>]+>/);
    if (extension === 'docx') assert.match(xml, /Native Probe/);
    if (extension === 'pptx') assert.ok(Object.keys(entries).some(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)));
    if (extension === 'xlsx') { const sheet = Buffer.from(entries['xl/worksheets/sheet1.xml']).toString(); assert.match(sheet, /6\*7/); assert.match(sheet, />42</); }
    return { format: extension, archiveMembers: Object.keys(entries).length, requiredPart: member, bytes: bytes.length };
  }
  if (extension === 'pdf') {
    assert.ok(bytes.subarray(0, 8).toString('ascii').startsWith('%PDF-'), 'Missing PDF signature'); assert.ok(bytes.subarray(-1024).includes(Buffer.from('%%EOF')), 'Missing PDF trailer');
    // PDF 1.5+ legitimately puts Page/MediaBox dictionaries into compressed
    // object streams. Use an independent parser, not a plaintext-regex shortcut.
    const { stdout, stderr } = await execFileAsync(process.env.IMAGE2_CRAFT_PDFINFO || 'pdfinfo', ['-box', local], { timeout: 30000, maxBuffer: 1024 * 1024 });
    const pages = Number(/^Pages:\s+(\d+)/m.exec(stdout)?.[1]), box = /^Page size:\s+([\d.]+) x ([\d.]+) pts/m.exec(stdout);
    assert.ok(pages > 0 && box && Number(box[1]) > 0 && Number(box[2]) > 0, 'PDF parser did not find valid pages and dimensions');
    assert.doesNotMatch(stderr, /Syntax Error/i);
    return { format: 'pdf', parser: 'poppler-pdfinfo', realHeader: true, pages, width: Number(box[1]), height: Number(box[2]), bytes: bytes.length };
  }
  if (extension === 'dxf') { assert.match(bytes.toString(), /SECTION/); assert.match(bytes.toString(), /ENTITIES/); assert.match(bytes.toString(), /CIRCLE/); return { format: 'dxf', circleEntity: true, bytes: bytes.length }; }
  if (extension === 'svg') { const text = bytes.toString(); assert.match(text, /<svg[\s>]/); assert.match(text, /<path[\s>]/); return { format: 'svg', path: true, bytes: bytes.length }; }
  if (extension === 'mp4') {
    assert.equal(bytes.toString('ascii', 4, 8), 'ftyp');
    const { stdout } = await execFileAsync(process.env.IMAGE2_CRAFT_FFPROBE || 'ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', local], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
    const info = JSON.parse(stdout); const video = info.streams.find(stream => stream.codec_type === 'video'); assert.ok(video); assert.equal(video.width, 128); assert.equal(video.height, 96); assert.ok(Number(info.format.duration) > 0);
    await execFileAsync(process.env.IMAGE2_CRAFT_FFMPEG || 'ffmpeg', ['-v', 'error', '-xerror', '-i', local, '-map', '0:v:0', '-f', 'null', '-'], { timeout: 30000, maxBuffer: 1024 * 1024 });
    return { format: 'mp4', codec: video.codec_name, width: video.width, height: video.height, duration: Number(info.format.duration), fullDecode: true, bytes: bytes.length };
  }
  throw new Error(`Missing structural check for ${file.name}`);
}

function wavFixture() {
  const frames = 12000, out = Buffer.alloc(44 + frames * 2);
  out.write('RIFF'); out.writeUInt32LE(out.length - 8, 4); out.write('WAVEfmt ', 8); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(48000, 24); out.writeUInt32LE(96000, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) out.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / 48000) * 6000), 44 + i * 2);
  return out;
}

function pcm(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF'); assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  for (let offset = 12; offset + 8 <= bytes.length;) { const size = bytes.readUInt32LE(offset + 4); if (bytes.toString('ascii', offset, offset + 4) === 'data') return bytes.subarray(offset + 8, offset + 8 + size); offset += 8 + size + (size % 2); }
  throw new Error('WAV output did not contain PCM data');
}

function describe(result) {
  return { result: result.result, state: result.state, receipt: result.receipt, warnings: result.warnings, files: result.files.map(({ bytes, ...item }) => ({ ...item, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })), checkpointBytes: result.checkpoint.bytes.length };
}

export async function runNativeCraftAcceptance({ binDir = process.env.IMAGE2_CRAFT_BIN_DIR, evidenceDir = process.env.IMAGE2_CRAFT_EVIDENCE_DIR, engineId } = {}) {
  assert.ok(binDir, 'IMAGE2_CRAFT_BIN_DIR is required; real native tests are never replaced by mocks');
  const root = evidenceDir ? path.resolve(evidenceDir) : await fs.mkdtemp(path.join(os.tmpdir(), 'craft-native-acceptance-'));
  await fs.mkdir(root, { recursive: true });
  const image = Buffer.alloc(128 * 96 * 4);
  for (let y = 0; y < 96; y++) for (let x = 0; x < 128; x++) { const at = (y * 128 + x) * 4; image[at] = x * 2; image[at + 1] = y * 2; image[at + 2] = 128; image[at + 3] = 255; }
  const imagePath = path.join(root, 'fixture.png'), audioPath = path.join(root, 'fixture.wav');
  await sharp(image, { raw: { width: 128, height: 96, channels: 4 } }).png().toFile(imagePath); await fs.writeFile(audioPath, wavFixture());
  const cadReference = path.join(root, 'reference.dxf');
  await fs.writeFile(cadReference, '0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1032\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nCIRCLE\n5\nAA\n100\nAcDbEntity\n8\n0\n100\nAcDbCircle\n10\n0\n20\n0\n30\n0\n40\n4\n0\nENDSEC\n0\nEOF\n');
  const inputFiles = [{ assetId: 'cad-reference', filename: 'reference.dxf', path: cadReference }, { assetId: 'image', filename: 'fixture.png', path: imagePath }, { assetId: 'audio', filename: 'fixture.wav', path: audioPath }, { assetId: 'font', filename: 'CraftAcceptanceFace-Regular.ttf', path: fileURLToPath(new URL('./fixtures/CraftAcceptanceFace-Regular.ttf', import.meta.url)) }];
  const runtime = createCraftRuntime({ binDir, timeoutMs: 120000 }); const capabilities = await runtime.capabilities(engineId ? { engineId } : {});
  await fs.writeFile(path.join(root, 'capabilities.json'), JSON.stringify(capabilities, null, 2));
  const ids = engineId ? [engineId] : Object.keys(cases); const results = [];
  for (const id of ids) {
    const spec = cases[id]; assert.ok(spec, `Unknown probe engine ${id}`);
    const cap = capabilities.find(item => item.id === id); const engineRoot = path.join(root, `${id}-${Date.now()}`); await fs.mkdir(engineRoot);
    try {
      assert.ok(cap?.available, `${id} unavailable: ${cap?.reason} ${cap?.message}`);
      const first = await runtime.execute({ engineId: id, workDir: path.join(engineRoot, 'job1'), inputFiles, steps: [...spec.first, ...(exportCases[id]?.steps ?? [])] });
      const formats = [];
      for (const name of exportCases[id]?.files ?? []) { const file = first.files.find(item => item.name === name); assert.ok(file, `${id} did not export ${name}`); formats.push(await inspectFormat(file, engineRoot)); }
      assert.ok(first.checkpoint.bytes.length > 0); assert.equal(first.receipt.externalModelCalls, 0);
      const checkpoint = path.join(engineRoot, 'checkpoint.craftbundle'); await fs.writeFile(checkpoint, first.checkpoint.bytes);
      // Delete the original workspace. The second process must use only the immutable bundle.
      await fs.rm(path.join(engineRoot, 'job1'), { recursive: true, force: true });
      const second = await runtime.execute({ engineId: id, workDir: path.join(engineRoot, 'job2'), nativeFile: checkpoint, steps: spec.second });
      assert.equal(second.receipt.externalModelCalls, 0); assert.ok(second.state);
      if (id === 'wordcraft') { assert.match(JSON.stringify(second.state), /Craft Acceptance Face/); assert.ok(second.files.find(file => file.name === 'document.docx')); }
      if (id === 'cadcraft') { const refs = second.result[1]?.xrefs; assert.equal(refs?.length, 1); assert.equal(refs[0].status, 'Loaded'); assert.ok(refs[0].objects > 0); assert.ok(refs[0].path.startsWith('workspace:/inputs/')); }
      const a = spec.preview ? first.files.findLast(file => file.role === 'preview') : first.files.find(file => file.name === spec.compare);
      const b = spec.preview ? second.files.findLast(file => file.role === 'preview') : second.files.find(file => file.name === spec.compare);
      let comparison;
      if (spec.values) {
        assert.deepEqual(second.result[0], first.result[spec.first.length - 1]); assert.match(JSON.stringify(second.result[0]), /42/); comparison = { kind: 'cell-values', identical: true };
      } else {
        assert.ok(a && b, `${id} did not return its expected export`);
        if (a.mime.startsWith('image/') && a.mime !== 'image/svg+xml') {
          const av = await sharp(a.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true }), bv = await sharp(b.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
          const colors = new Set();
          for (let at = 0; at < av.data.length; at += 4) {
            const alpha = av.data[at + 3] / 255;
            const rgb = [0, 1, 2].map(channel => Math.round(av.data[at + channel] * alpha + 255 * (1 - alpha)));
            colors.add((rgb[0] << 16) | (rgb[1] << 8) | rgb[2]); if (colors.size >= 256) break;
          }
          assert.ok(colors.size >= (['photocraft', 'filmcraft'].includes(id) ? 16 : 2), `${id}: its real edit rendered a blank or uniform image`);
          assert.deepEqual(bv.info, av.info); assert.equal(Buffer.compare(av.data, bv.data), 0, `${id}: decoded pixels changed after checkpoint relocation`); comparison = { kind: 'decoded-rgba', width: av.info.width, height: av.info.height, differingChannels: 0, distinctColorsAtLeast: colors.size };
        } else if (a.mime === 'audio/wav') { const audio = pcm(a.bytes); assert.ok(audio.length > 1000 && audio.some(byte => byte !== 0), 'The native audio bounce is empty or silent'); assert.equal(Buffer.compare(audio, pcm(b.bytes)), 0); comparison = { kind: 'wav-pcm', identical: true, nonSilent: true }; }
        else { assert.equal(Buffer.compare(a.bytes, b.bytes), 0); comparison = { kind: 'bytes', identical: true }; }
        await fs.writeFile(path.join(engineRoot, a.name), a.bytes);
      }
      const record = { id, status: 'passed', tools: cap.tools.length, commands: cap.commands.length, version: cap.version, comparison, formats, first: describe(first), second: describe(second) };
      results.push(record); await fs.writeFile(path.join(engineRoot, 'result.json'), JSON.stringify(record, null, 2));
      console.log(JSON.stringify({ engine: id, status: 'passed', comparison, formats }));
    } catch (e) { const failure = { id, status: 'failed', code: e.code, error: e.message }; results.push(failure); console.error(JSON.stringify(failure)); }
    await fs.writeFile(path.join(root, 'results.json'), JSON.stringify({ root, results }, null, 2));
  }
  assert.equal(results.filter(result => result.status === 'failed').length, 0, 'Some real ArtCraft engine probes failed; see results.json');
  return { root, results };
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) await runNativeCraftAcceptance({ engineId: process.argv[2] });
