import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as fontkit from 'fontkit';
import { documentPng, documentPdf } from '../exports.mjs';
import { decodeRGBA } from '../processors.mjs';

const root = new URL('../../../public/fonts/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

for (const entry of manifest.fonts) test(`original ${entry.target} contains real common Chinese glyphs and exports its actual face`, async () => {
  const bytes = readFileSync(new URL(entry.target, root));
  assert.equal(bytes.length, entry.woff2Bytes); assert.equal(digest(bytes), entry.woff2Sha256);
  assert.equal(digest(readFileSync(new URL(entry.licenseFile, root))), entry.licenseSha256);
  const face = fontkit.create(bytes);
  assert.equal(face.familyName, entry.family); assert.equal(face.postscriptName, entry.postscript);
  assert.equal(face.numGlyphs, entry.glyphs); assert.equal(face.characterSet.length, entry.encodedCodePoints);
  for (const character of new Set(manifest.verificationText)) assert.ok(face.hasGlyphForCodePoint(character.codePointAt(0)), `missing ${character}`);
  const assetId = `full-${entry.key}`, asset = { asset: { id: assetId, mime: 'font/woff2' }, bytes };
  const document = { id: 'original-font', name: 'original-font', updatedAt: '2026-10-12T00:00:00Z', width: 512, height: 96, layers: [{ id: 'title', type: 'text', text: '中文海报功能测试', fontAssetId: assetId, fontSize: 32, fontWeight: 400, lineHeight: 1.2,
    x: 8, y: 8, width: 480, height: 72, rotation: 0, opacity: 1, visible: true, z: 0, fill: '#000000', metadata: { fontConfirmed: true } }] };
  const png = await decodeRGBA(await documentPng(document, async () => asset), 'image/png');
  assert.equal(png.width, 512); assert.equal(png.height, 96);
  let ink = 0; for (let at = 3; at < png.data.length; at += 4) if (png.data[at]) ink++;
  assert.ok(ink > 800, 'actual Chinese glyph outlines must be rendered');
  const pdf = await documentPdf(document, async () => asset);
  assert.equal(pdf.toString('ascii', 0, 5), '%PDF-'); assert.ok(pdf.length > 1000);
});
