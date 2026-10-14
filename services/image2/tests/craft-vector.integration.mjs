/** Opt-in native tracing quality evidence; preserves the separate exact-pixel tracer. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { createCraftRuntime } from '../craft-runtime.mjs';

function topology(mask, width, height, color) {
  const seen = new Uint8Array(mask.length); let components = 0, holes = 0;
  for (let at = 0; at < mask.length; at++) {
    if (seen[at] || mask[at] !== color) continue;
    components++; const queue = [at]; seen[at] = 1; let edge = false;
    for (let index = 0; index < queue.length; index++) {
      const p = queue[index], x = p % width, y = Math.floor(p / width); edge ||= x === 0 || y === 0 || x === width - 1 || y === height - 1;
      for (const n of [x ? p - 1 : -1, x < width - 1 ? p + 1 : -1, y ? p - width : -1, y < height - 1 ? p + width : -1]) if (n >= 0 && !seen[n] && mask[n] === color) { seen[n] = 1; queue.push(n); }
    }
    if (!edge) holes++;
  }
  return { components, holes };
}

export async function runVectorTraceAcceptance({ binDir = process.env.IMAGE2_CRAFT_BIN_DIR, evidenceDir = process.env.IMAGE2_CRAFT_EVIDENCE_DIR } = {}) {
  assert.ok(binDir, 'IMAGE2_CRAFT_BIN_DIR required');
  const root = await fs.mkdtemp(path.join(evidenceDir ?? os.tmpdir(), 'vector-detail-'));
  const width = 256, height = 192, raw = Buffer.alloc(width * height * 4, 255), inputMask = new Uint8Array(width * height);
  const black = (x, y) => { const at = y * width + x; inputMask[at] = 1; raw.fill(0, at * 4, at * 4 + 3); };
  const centers = [];
  for (let row = 0; row < 6; row++) for (let col = 0; col < 18; col++) {
    const cx = 8 + col * 13, cy = 8 + row * 13, radius = 1 + row % 3; centers.push([cx, cy]);
    for (let y = cy - radius; y <= cy + radius; y++) for (let x = cx - radius; x <= cx + radius; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2) black(x, y);
  }
  // Ring with a genuine transparent/white hole, one-pixel horizontal and diagonal lines.
  for (let y = 100; y <= 166; y++) for (let x = 10; x <= 76; x++) { const d = (x - 43) ** 2 + (y - 133) ** 2; if (d <= 30 ** 2 && d >= 19 ** 2) black(x, y); }
  for (let x = 100; x < 240; x++) black(x, 110);
  for (let x = 100; x < 180; x++) { black(x, 130 + Math.floor((x - 100) / 2)); black(x, 131 + Math.floor((x - 100) / 2)); }
  const fixture = path.join(root, 'fixture.png'); await sharp(raw, { raw: { width, height, channels: 4 } }).png().toFile(fixture);
  const runtime = createCraftRuntime({ binDir });
  const result = await runtime.execute({ engineId: 'vectorcraft', workDir: path.join(root, 'job'), inputFiles: [{ assetId: 'fixture', filename: 'fixture.png', path: fixture }], steps: [
    { command: 'new', args: { width, height } },
    { command: 'file.place', args: { path: { assetId: 'fixture' }, link: false, rect: [0, 0, width, height] } },
    { command: 'imageTrace.makeAndExpand', args: { params: { mode: 'blackAndWhite', threshold: 128, paths: 100, corners: 100, noise: 0, ignoreWhite: true, fills: true, strokes: false, snapCurvesToLines: false, shapes: false, gradients: false } } },
    { command: 'export', args: { path: { outputName: 'trace.svg' }, format: 'svg' } },
  ] });
  const svg = result.files.find(file => file.name === 'trace.svg'); assert.ok(svg); const text = svg.bytes.toString();
  const pathCount = (text.match(/<path[\s>]/g) ?? []).length; assert.ok(pathCount > 0); assert.doesNotMatch(text, /<image[\s>]|data:image/i);
  const traced = await sharp(svg.bytes).resize(width, height).flatten({ background: '#ffffff' }).ensureAlpha().raw().toBuffer(); const outputMask = new Uint8Array(inputMask.length);
  let differingChannels = 0, absoluteError = 0, maskDifferences = 0;
  for (let i = 0; i < inputMask.length; i++) { outputMask[i] = traced[i * 4] < 128 ? 1 : 0; maskDifferences += Number(outputMask[i] !== inputMask[i]); for (let c = 0; c < 4; c++) { differingChannels += Number(raw[i * 4 + c] !== traced[i * 4 + c]); absoluteError += Math.abs(raw[i * 4 + c] - traced[i * 4 + c]); } }
  const original = { foregroundComponents: topology(inputMask, width, height, 1).components, holes: topology(inputMask, width, height, 0).holes };
  const restored = { foregroundComponents: topology(outputMask, width, height, 1).components, holes: topology(outputMask, width, height, 0).holes };
  const retainedDotCenters = centers.filter(([x, y]) => outputMask[y * width + x]).length;
  const thinLineRetained = Array.from({ length: 140 }, (_, i) => outputMask[110 * width + 100 + i]).reduce((a, b) => a + b, 0);
  const report = { source: result.receipt.version, width, height, processor: result.receipt.processor, externalModelCalls: result.receipt.externalModelCalls, pathCount, closedSubpaths: (text.match(/[Zz](?=[\s"'])/g) ?? []).length, embeddedRaster: false, original, restored, dotCenters: centers.length, retainedDotCenters, thinLinePixels: 140, thinLineRetained, differingChannels, meanAbsoluteChannelError: absoluteError / raw.length, maskDifferences, exactPixels: differingChannels === 0, detailTopologyPreserved: original.foregroundComponents === restored.foregroundComponents && original.holes === restored.holes && retainedDotCenters === centers.length && thinLineRetained === 140, replacesPixelExactTracer: false, traceResult: result.result[2], warnings: result.warnings };
  await fs.writeFile(path.join(root, 'trace.svg'), svg.bytes); await sharp(traced, { raw: { width, height, channels: 4 } }).png().toFile(path.join(root, 'recomposed.png'));
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ root, ...report })); return report;
}
if (import.meta.url === new URL(process.argv[1], 'file:').href) await runVectorTraceAcceptance();
