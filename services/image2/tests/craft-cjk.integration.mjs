/** Real native CJK shape/outline + checkpoint persistence acceptance. */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { createCraftRuntime } from '../craft-runtime.mjs';

export async function runCraftCjkAcceptance({ binDir = process.env.IMAGE2_CRAFT_BIN_DIR, evidenceDir = process.env.IMAGE2_CRAFT_EVIDENCE_DIR, engineId = 'vectorcraft' } = {}) {
  assert.ok(binDir, 'IMAGE2_CRAFT_BIN_DIR is required');
  const root = await fs.mkdtemp(path.join(evidenceDir ? path.resolve(evidenceDir) : os.tmpdir(), 'craft-cjk-'));
  assert.ok(['vectorcraft', 'photocraft'].includes(engineId), 'CJK probe requires a supported engine');
  const runtime = createCraftRuntime({ binDir });
  const step = (command, args = {}) => ({ command, args });
  const exportFile = (name, format) => step(engineId === 'photocraft' ? 'doc_export' : 'export', { path: { outputName: name }, format, ...(format === 'svg' ? { outlineText: true } : engineId === 'vectorcraft' ? { scale: 1 } : {}) });
  const steps = [];
  const glyphs = ['中', '文', '测', '试', '□'];
  for (let index = 0; index < glyphs.length; index++) steps.push(
    step('new', { width: 96, height: 96 }),
    step(engineId === 'photocraft' ? 'type.create' : 'add_text', { text: glyphs[index], x: 16, y: 70, size: 48, font: 'Noto Sans CJK SC', color: '#000000' }),
    exportFile(`glyph-${index}.png`, 'png'), ...(engineId === 'vectorcraft' ? [exportFile(`glyph-${index}.svg`, 'svg')] : []),
  );
  steps.push(step('new', { width: 256, height: 96 }), step(engineId === 'photocraft' ? 'type.create' : 'add_text', { text: '中文测试', x: 16, y: 70, size: 48, font: 'Noto Sans CJK SC', color: '#000000' }), exportFile('chinese.png', 'png'), ...(engineId === 'vectorcraft' ? [exportFile('chinese.svg', 'svg')] : []));
  const first = await runtime.execute({ engineId, workDir: path.join(root, 'job1'), steps });
  const hashes = [], glyphRecords = [];
  for (let index = 0; index < glyphs.length; index++) {
    const file = first.files.find(item => item.name === `glyph-${index}.png`); assert.ok(file);
    const pixels = await sharp(file.bytes).flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer();
    let inkPixels = 0; for (let at = 0; at < pixels.length; at += 3) if (pixels[at] < 200 || pixels[at + 1] < 200 || pixels[at + 2] < 200) inkPixels++;
    assert.ok(inkPixels > 50, `Glyph ${glyphs[index]} rendered empty`);
    const hash = createHash('sha256').update(pixels).digest('hex'); hashes.push(hash);
    let outlinePaths;
    if (engineId === 'vectorcraft') {
      const svg = first.files.find(item => item.name === `glyph-${index}.svg`); assert.ok(svg);
      const text = svg.bytes.toString(); assert.match(text, /<path\b/); assert.doesNotMatch(text, /<(?:image|text)\b/);
      outlinePaths = (text.match(/<path\b/g) ?? []).length; await fs.writeFile(path.join(root, svg.name), svg.bytes);
    }
    glyphRecords.push({ character: glyphs[index], inkPixels, pixelHash: hash, outlinePaths });
    await fs.writeFile(path.join(root, file.name), file.bytes);
  }
  // Different Han glyphs must have different visible outlines, and none may be
  // rendered as a repeated missing-glyph box. This checks pixels, not just text metadata.
  assert.equal(new Set(hashes).size, glyphs.length, 'CJK glyphs are duplicated or missing-glyph boxes');
  const checkpoint = path.join(root, 'checkpoint.craftbundle'); await fs.writeFile(checkpoint, first.checkpoint.bytes);
  await fs.rm(path.join(root, 'job1'), { recursive: true });
  const second = await runtime.execute({ engineId, workDir: path.join(root, 'job2'), nativeFile: checkpoint, steps: [exportFile('chinese.png', 'png'), ...(engineId === 'vectorcraft' ? [exportFile('chinese.svg', 'svg')] : [])] });
  const before = first.files.find(file => file.name === 'chinese.png'), after = second.files.find(file => file.name === 'chinese.png'); assert.ok(before && after);
  const a = await sharp(before.bytes).ensureAlpha().raw().toBuffer(), b = await sharp(after.bytes).ensureAlpha().raw().toBuffer(); assert.deepEqual(a, b);
  await fs.writeFile(path.join(root, 'chinese.png'), after.bytes); if (engineId === 'vectorcraft') await fs.writeFile(path.join(root, 'chinese.svg'), second.files.find(file => file.name === 'chinese.svg').bytes);
  const report = { status: 'passed', engine: engineId, version: first.receipt.version, font: 'Noto Sans CJK SC', glyphRecords, checkpointRgbaDifferences: 0, externalModelCalls: 0, root };
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); return report;
}
if (import.meta.url === new URL(process.argv[1], 'file:').href) await runCraftCjkAcceptance({ engineId: process.argv[2] });
