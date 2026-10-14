/** Per-engine real Chinese glyph rendering. PDF's WinAnsi-only insertion is deliberately excluded. */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { createCraftRuntime } from '../craft-runtime.mjs';
const step = (command, args = {}) => ({ command, args });
const font = 'Noto Sans CJK SC';
const specs = {
  filmcraft: text => [step('new'), step('file.newSequence', { name: 'Chinese acceptance', width: 256, height: 96, fps: 12, video: 1, audio: 0 }), step('graphics.newText', { text, position: [16, 70], size: 48, font, seconds: 1 }), step('render_preview', { seconds: 0, max_side: 256 })],
  lightcraft: text => [step('import', { paths: [{ assetId: 'image' }], mode: 'copy' }), watermark(text)],
  effectcraft: text => [step('new'), step('comp.new', { name: 'Chinese acceptance', width: 256, height: 96, duration: 1, frameRate: 12 }), step('layer.newText', { text, position: [16, 70], size: 48, font, fill: '#000000', justify: 'left' }), step('render_preview', { max_side: 256 })],
  designcraft: text => [step('new', { width: 256, height: 128 }), step('frame.create', { rect: [8, 8, 248, 120], content: 'text', text }), step('type.char', { attrs: { fontFamily: font, size: 48 } })],
  figcraft: text => [step('new'), step('create_node', { type: 'text', text, x: 16, y: 16, width: 256, height: 96, props: { fontFamily: font, fontSize: 48, fill: '#000000' } })],
  wordcraft: text => [step('new'), step('format.font', { name: font, eastAsia: font }), step('format.size', { size: 48 }), step('type_text', { text })],
  deckcraft: text => [step('new'), step('add_text_box', { x: 16, y: 16, w: 256, h: 96, text, size: 48, color: '#000000' }), step('format.font', { family: font })],
  cadcraft: text => [step('new'), step('text', { at: [16, 32], height: 48, text }), step('render', { width: 256, height: 128, window: [[0, 0], [256, 128]] })],
};
function watermark(text) { return step('export', { path: { outputName: 'chinese.png' }, format: 'png', watermark: { text, size: 0.5, opacity: 1, color: [0, 0, 0], anchor: 'center', shadow: false } }); }
const pickImage = (result, id) => id === 'lightcraft' ? result.files.find(file => file.name === 'chinese.png') : result.files.find(file => file.role === 'preview');
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
        const result = await runtime.execute({ engineId: id, workDir: job, steps: specs[id](character), inputFiles: inputs });
        const preview = pickImage(result, id); assert.ok(preview, `No real ${id} Chinese image: ${result.warnings.join('; ')}`);
        const pixels = await sharp(preview.bytes).flatten({ background: '#ffffff' }).raw().toBuffer({ resolveWithObject: true });
        const hash = createHash('sha256').update(pixels.data).digest('hex');
        const imageName = `${id}-glyph${index}.png`; await fs.writeFile(path.join(root, imageName), preview.bytes);
        glyphRecords.push({ character, sha256: hash, width: pixels.info.width, height: pixels.info.height, image: imageName });
        await fs.rm(job, { recursive: true });
      }
      assert.equal(new Set(glyphRecords.map(glyph => glyph.sha256)).size, glyphRecords.length, `${id}: Chinese characters rendered identically or as missing-glyph boxes`);
      const firstWork = path.join(root, `${id}-text`), first = await runtime.execute({ engineId: id, workDir: firstWork, steps: specs[id]('中文测试'), inputFiles: inputs });
      const file = path.join(root, `${id}.craftbundle`); await fs.writeFile(file, first.checkpoint.bytes); await fs.rm(firstWork, { recursive: true });
      const second = await runtime.execute({ engineId: id, workDir: path.join(root, `${id}-reopen`), nativeFile: file, steps: [id === 'lightcraft' ? watermark('中文测试') : id === 'filmcraft' ? step('preview', { seconds: 0, max_side: 256 }) : id === 'effectcraft' ? step('preview', { max_side: 256 }) : id === 'cadcraft' ? step('preview', { width: 256, height: 128, window: [[0, 0], [256, 128]] }) : step('preview')] });
      const before = pickImage(first, id), after = pickImage(second, id); assert.ok(before && after);
      assert.deepEqual(await sharp(before.bytes).ensureAlpha().raw().toBuffer(), await sharp(after.bytes).ensureAlpha().raw().toBuffer(), `${id}: Chinese image changed after native checkpoint relocation`);
      await fs.writeFile(path.join(root, `${id}-chinese.png`), after.bytes);
      const record = { engine: id, status: 'passed', version: first.receipt.version, glyphRecords, checkpointRgbaDifferences: 0, textPersistedInNative: id !== 'lightcraft', exportWatermark: id === 'lightcraft', externalModelCalls: 0 };
      records.push(record); console.log(JSON.stringify({ engine: id, status: 'passed', glyphs: glyphRecords.length, checkpointRgbaDifferences: 0 }));
    } catch (e) { records.push({ engine: id, status: 'failed', message: e.message, code: e.code, glyphRecords }); console.error(JSON.stringify(records.at(-1))); }
    await fs.writeFile(path.join(root, 'result.json'), JSON.stringify({ root, records }, null, 2));
  }
  assert.equal(records.filter(record => record.status === 'failed').length, 0, `Chinese native tests failed; see ${root}/result.json`);
  return { root, records };
}
if (import.meta.url === new URL(process.argv[1], 'file:').href) await runCraftTextAcceptance({ engineId: process.argv[2] });
