/** Per-engine real Chinese glyph rendering. PDF's WinAnsi-only insertion is deliberately excluded. */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { unzipSync } from 'fflate';
import { createCraftRuntime } from '../craft-runtime.mjs';
const execFileAsync = promisify(execFile);
const step = (command, args = {}) => ({ command, args });
const font = 'Noto Sans CJK SC';
const specs = {
  filmcraft: text => [step('new'), step('file.newSequence', { name: 'Chinese acceptance', width: 256, height: 96, fps: 12, video: 1, audio: 0 }), step('graphics.newText', { text, position: [16, 70], size: 48, font, seconds: 1 }), step('render_preview', { seconds: 0, max_side: 256 })],
  lightcraft: text => [step('import', { paths: [{ assetId: 'image' }], mode: 'copy' }), watermark(text)],
  effectcraft: text => [step('new'), step('comp.new', { name: 'Chinese acceptance', width: 256, height: 96, duration: 1, frameRate: 12 }), step('layer.newText', { text, position: [16, 70], size: 48, font, fill: '#ffffff', justify: 'left' }), step('render_preview', { max_side: 256 })],
  designcraft: text => [step('new', { width: 256, height: 128 }), step('frame.create', { rect: [8, 8, 248, 120], content: 'text', text }), step('text.select', { story: { resultRef: '1.story' }, anchor: 0, focus: Buffer.byteLength(text) }), step('type.char', { attrs: { fontFamily: font, size: 48 } })],
  figcraft: text => [step('new'), step('create_node', { type: 'text', text, x: 16, y: 16, width: 256, height: 96, props: { fontFamily: font, fontSize: 48, fill: '#000000' } })],
  wordcraft: text => [step('new'), step('format.font', { name: font, eastAsia: font }), step('format.size', { size: 48 }), step('type_text', { text })],
  deckcraft: text => [step('new'), step('add_text_box', { x: 16, y: 16, w: 256, h: 96, text, size: 48, color: '#000000' }), step('format.font', { family: font })],
  cadcraft: text => [step('new'), step('text', { at: [16, 32], height: 48, text }), step('render', { width: 256, height: 128, window: [[0, 0], [256, 128]] })],
};
function watermark(text) { return step('export', { path: { outputName: 'chinese.png' }, format: 'png', watermark: { text, size: 0.5, opacity: 1, color: [0, 0, 0], anchor: 'center', shadow: false } }); }
const pickImage = (result, id) => id === 'lightcraft' ? result.files.find(file => file.name === 'chinese.png') : result.files.find(file => file.role === 'preview');
const pdfWriter = { designcraft: 'file.exportPdf', wordcraft: 'save_document', cadcraft: 'save' };
function textSteps(id, text, full = false) {
  const steps = specs[id](text);
  if (pdfWriter[id]) steps.push(step(pdfWriter[id], { path: { outputName: 'chinese.pdf' } }));
  if (full && id === 'deckcraft') steps.push(step('export', { path: { outputName: 'chinese.pptx' }, format: 'pptx' }));
  return steps;
}
async function pdfEvidence(result, root, stem) {
  const pdf = result.files.find(file => file.name === 'chinese.pdf'); assert.ok(pdf, 'Native Chinese PDF export is absent');
  assert.ok(pdf.bytes.subarray(0, 8).toString().startsWith('%PDF-'), 'Native PDF export has no PDF signature');
  const file = path.join(root, `${stem}.pdf`), imageStem = path.join(root, `${stem}-pdf`);
  await fs.writeFile(file, pdf.bytes);
  await execFileAsync(process.env.IMAGE2_CRAFT_PDFTOPPM || 'pdftoppm', ['-f', '1', '-singlefile', '-scale-to', '1024', '-png', file, imageStem], { timeout: 30000, maxBuffer: 1024 * 1024 });
  const rendered = await sharp(`${imageStem}.png`).flatten({ background: '#ffffff' }).raw().toBuffer({ resolveWithObject: true });
  const { stdout } = await execFileAsync(process.env.IMAGE2_CRAFT_PDFTOTEXT || 'pdftotext', ['-enc', 'UTF-8', file, '-'], { timeout: 30000, maxBuffer: 1024 * 1024 });
  return { format: 'pdf', bytes: pdf.bytes.length, renderer: 'poppler-pdftoppm', image: `${stem}-pdf.png`, sha256: createHash('sha256').update(rendered.data).digest('hex'), width: rendered.info.width, height: rendered.info.height, extractedText: stdout.trim(), fullChineseTextExtractable: stdout.replace(/\s/g, '').includes('中文测试'), textAsOutlinesAllowed: true };
}
function officeEvidence(result, id) {
  const extension = id === 'wordcraft' ? 'docx' : 'pptx';
  const file = result.files.find(item => item.name.endsWith(`.${extension}`)); assert.ok(file);
  const entries = unzipSync(file.bytes), names = Object.keys(entries);
  const xml = names.filter(name => extension === 'docx' ? name === 'word/document.xml' : /^ppt\/slides\/slide\d+\.xml$/.test(name)).map(name => Buffer.from(entries[name]).toString()).join('\n');
  assert.ok(xml.replace(/<[^>]+>/g, '').includes('中文测试'), `${extension}: Chinese text was lost in the real OOXML package`);
  return { format: extension, bytes: file.bytes.length, chineseTextPreserved: true, embeddedFontParts: names.filter(name => /^(?:word|ppt)\/fonts\//.test(name)), crossDeviceFontParityVerified: false };
}
export async function runCraftTextAcceptance({ binDir = process.env.IMAGE2_CRAFT_BIN_DIR, evidenceDir = process.env.IMAGE2_CRAFT_EVIDENCE_DIR, engineId } = {}) {
  assert.ok(binDir, 'IMAGE2_CRAFT_BIN_DIR is required');
  const ids = engineId ? [engineId] : Object.keys(specs), runtime = createCraftRuntime({ binDir });
  const root = await fs.mkdtemp(path.join(evidenceDir ? path.resolve(evidenceDir) : os.tmpdir(), 'craft-text-'));
  const imagePath = path.join(root, 'white.png'); await sharp({ create: { width: 256, height: 128, channels: 4, background: '#ffffff' } }).png().toFile(imagePath);
  const inputs = [{ assetId: 'image', filename: 'white.png', path: imagePath }];
  const records = [];
  for (const id of ids) {
    assert.ok(specs[id], `Unknown text probe engine ${id}`);
    const glyphRecords = [];
    try {
      for (const [index, character] of ['中', '文', '测', '试', '□'].entries()) {
        const job = path.join(root, `${id}-glyph${index}`);
        const result = await runtime.execute({ engineId: id, workDir: job, steps: textSteps(id, character), inputFiles: inputs });
        const preview = pickImage(result, id); assert.ok(preview, `No real ${id} Chinese image: ${result.warnings.join('; ')}`);
        const pixels = await sharp(preview.bytes).flatten({ background: '#ffffff' }).raw().toBuffer({ resolveWithObject: true });
        const hash = createHash('sha256').update(pixels.data).digest('hex');
        const imageName = `${id}-glyph${index}.png`; await fs.writeFile(path.join(root, imageName), preview.bytes);
        glyphRecords.push({ character, sha256: hash, width: pixels.info.width, height: pixels.info.height, image: imageName, ...(pdfWriter[id] ? { pdf: await pdfEvidence(result, root, `${id}-glyph${index}`) } : {}) });
        await fs.rm(job, { recursive: true });
      }
      assert.equal(new Set(glyphRecords.map(glyph => glyph.sha256)).size, glyphRecords.length, `${id}: Chinese characters rendered identically or as missing-glyph boxes`);
      if (pdfWriter[id]) assert.equal(new Set(glyphRecords.map(glyph => glyph.pdf.sha256)).size, glyphRecords.length, `${id}: independent PDF rendering lost distinct Chinese glyphs`);
      const firstWork = path.join(root, `${id}-text`), first = await runtime.execute({ engineId: id, workDir: firstWork, steps: textSteps(id, '中文测试', true), inputFiles: inputs });
      const formats = [];
      if (pdfWriter[id]) formats.push(await pdfEvidence(first, root, `${id}-chinese`));
      if (['wordcraft', 'deckcraft'].includes(id)) formats.push(officeEvidence(first, id));
      const file = path.join(root, `${id}.craftbundle`); await fs.writeFile(file, first.checkpoint.bytes); await fs.rm(firstWork, { recursive: true });
      const second = await runtime.execute({ engineId: id, workDir: path.join(root, `${id}-reopen`), nativeFile: file, steps: [id === 'lightcraft' ? watermark('中文测试') : id === 'filmcraft' ? step('preview', { seconds: 0, max_side: 256 }) : id === 'effectcraft' ? step('preview', { max_side: 256 }) : id === 'cadcraft' ? step('preview', { width: 256, height: 128, window: [[0, 0], [256, 128]] }) : step('preview')] });
      const before = pickImage(first, id), after = pickImage(second, id); assert.ok(before && after);
      assert.deepEqual(await sharp(before.bytes).ensureAlpha().raw().toBuffer(), await sharp(after.bytes).ensureAlpha().raw().toBuffer(), `${id}: Chinese image changed after native checkpoint relocation`);
      await fs.writeFile(path.join(root, `${id}-chinese.png`), after.bytes);
      const record = { engine: id, status: 'passed', version: first.receipt.version, glyphRecords, formats, checkpointRgbaDifferences: 0, textPersistedInNative: id !== 'lightcraft', exportWatermark: id === 'lightcraft', externalModelCalls: 0 };
      records.push(record); console.log(JSON.stringify({ engine: id, status: 'passed', glyphs: glyphRecords.length, checkpointRgbaDifferences: 0 }));
    } catch (e) { records.push({ engine: id, status: 'failed', message: e.message, code: e.code, glyphRecords }); console.error(JSON.stringify(records.at(-1))); }
    await fs.writeFile(path.join(root, 'result.json'), JSON.stringify({ root, records }, null, 2));
  }
  assert.equal(records.filter(record => record.status === 'failed').length, 0, `Chinese native tests failed; see ${root}/result.json`);
  return { root, records };
}
if (import.meta.url === new URL(process.argv[1], 'file:').href) await runCraftTextAcceptance({ engineId: process.argv[2] });
