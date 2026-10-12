import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import PDFDocument from 'pdfkit';
import SVGtoPDF from 'svg-to-pdfkit';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import * as cssTree from 'css-tree';
import * as fontkit from 'fontkit';
import { fontWeight, pdfFontBytes } from './fonts.mjs';
import { decodeRGBA, encodePNG } from './processors.mjs';

const MAX_BUNDLE = 128 * 1024 * 1024;
const MAX_ARCHIVE = 64 * 1024 * 1024; // Base64 plus JSON fits the 96 MiB BFF body budget.
const escape = value => String(value ?? '').replace(/[<>&"']/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[ch]));
const fail = (ok, detail, code = 'invalid_export') => { if (!ok) throw Object.assign(new Error(detail), { status: 422, code }); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const uri = record => `data:${record.asset.mime};base64,${record.bytes.toString('base64')}`;
const fontAlias = id => `i2-font-${hash(Buffer.from(id)).slice(0,24)}`;

/** A scoped export is a view of the frozen document, never an authored revision. */
export function scopedExportDocument(document, options = {}) {
  const byId = new Map(document.layers.map(layer => [layer.id, layer]));
  let layers = document.layers;
  if (options.layerIds !== undefined) {
    fail(Array.isArray(options.layerIds) && options.layerIds.length > 0 && options.layerIds.length <= 10000 && new Set(options.layerIds).size === options.layerIds.length && options.layerIds.every(id => typeof id === 'string' && byId.has(id)), '导出图层选择无效', 'invalid_export_selection');
    const selected = new Set(options.layerIds), kept = new Set(selected);
    // Selecting a group includes its subtree; merely retaining an ancestor must
    // not pull unrelated siblings into the selection.
    let changed;
    do {
      changed = false;
      for (const layer of document.layers) if (layer.parentId && selected.has(layer.parentId) && !selected.has(layer.id)) { selected.add(layer.id); kept.add(layer.id); changed = true; }
    } while (changed);
    for (const id of selected) {
      let ancestor = byId.get(id)?.parentId;
      while (ancestor) { fail(byId.has(ancestor), '导出图层父级无效'); kept.add(ancestor); ancestor = byId.get(ancestor).parentId; }
    }
    layers = layers.filter(layer => kept.has(layer.id));
  }
  const bounds = options.bounds;
  if (bounds !== undefined) {
    fail(bounds && typeof bounds === 'object' && !Array.isArray(bounds) && ['x','y','width','height'].every(key => Number.isFinite(bounds[key])) && Math.abs(bounds.x) <= 1e7 && Math.abs(bounds.y) <= 1e7 && Number.isSafeInteger(bounds.width) && Number.isSafeInteger(bounds.height) && bounds.width > 0 && bounds.height > 0 && bounds.width <= 32768 && bounds.height <= 32768 && bounds.width * bounds.height <= 100000000, '导出边界无效；宽高需要正整数像素', 'invalid_export_bounds');
    layers = layers.map(layer => layer.parentId ? layer : { ...layer, x: layer.x - bounds.x, y: layer.y - bounds.y });
  }
  return { ...document, layers, ...(bounds ? { width: bounds.width, height: bounds.height } : {}) };
}

/** Canvas content bounds, composed through ancestor transforms and visibility. */
export function exportCanvasBounds(document, layerIds) {
  const view=scopedExportDocument(document,{layerIds}),byId=new Map(view.layers.map(layer=>[layer.id,layer]));
  const point=(x,y,layer)=>{const angle=(layer.rotation||0)*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle),next={x:layer.x+x*c-y*s,y:layer.y+x*s+y*c};const parent=byId.get(layer.parentId);return parent?point(next.x,next.y,parent):next;};
  const visible=layer=>{let node=layer;while(node){if(!node.visible||node.opacity===0)return false;node=byId.get(node.parentId);}return true;};
  const nodes=view.layers.filter(layer=>!['group','mask'].includes(layer.type)&&visible(layer));
  const corners=nodes.flatMap(layer=>[[0,0],[layer.width,0],[0,layer.height],[layer.width,layer.height]].map(([x,y])=>point(x,y,layer)));
  if(!corners.length)return {x:0,y:0,width:document.width,height:document.height};
  const x=Math.min(...corners.map(p=>p.x)),y=Math.min(...corners.map(p=>p.y));
  return {x,y,width:Math.max(1,Math.ceil(Math.max(...corners.map(p=>p.x))-x)),height:Math.max(1,Math.ceil(Math.max(...corners.map(p=>p.y))-y))};
}

function glyphPaths(layer, face) {
  const size = layer.fontSize || 24, scale = size / face.unitsPerEm, leading = size * (layer.lineHeight || 1.2);
  const paint = `fill="${escape(layer.fill || '#20232b')}"${layer.stroke ? ` stroke="${escape(layer.stroke)}" stroke-width="${(layer.strokeWidth || 1) / scale}" paint-order="stroke fill"` : ''}`;
  const paths = [];
  for (const [lineIndex, line] of String(layer.text || '').split('\n').entries()) {
    const run = face.layout(line.replace(/[\p{Cc}\p{Cf}]/gu, '')); let x = 0, y = 0;
    for (const [index, glyph] of run.glyphs.entries()) {
      const position = run.positions[index], baseline = size + lineIndex * leading;
      paths.push(`<path d="${escape(glyph.path.toSVG())}" transform="translate(${x + position.xOffset * scale} ${baseline - y - position.yOffset * scale}) scale(${scale} ${-scale})" ${paint}/>`);
      x += position.xAdvance * scale + (index < run.glyphs.length - 1 ? layer.tracking || 0 : 0); y += position.yAdvance * scale;
    }
  }
  return paths.join('');
}

function stylePaths(svg, styles = {}) {
  // Uploaded SVG is validated by inspectAsset; overrides only change known path paint.
  const parser = new XMLParser({ ignoreAttributes: false, preserveOrder: true });
  const tree = parser.parse(svg);
  const pathIndices = {};
  function walk(value) {
    if (!value || typeof value !== 'object') return;
    const tag = Object.keys(value).find(tag => ['path','polygon','polyline','rect','circle','ellipse','line'].includes(tag));
    if (tag) {
      value[':@'] ||= {};
      const attrs = value[':@'];
      const id = attrs['@_id'] || `${tag}-${pathIndices[tag] || 0}`;
      pathIndices[tag] = (pathIndices[tag] || 0) + 1;
      const paint = { ...styles['*'], ...styles[id] };
      const changed = [];
      for (const key of ['fill', 'stroke', 'stroke-width']) if (paint[key] !== undefined) {
        fail(!/url\s*\(|[{}<>]/i.test(String(paint[key])), '路径颜色无效');
        attrs[`@_${key}`] = paint[key]; changed.push(key);
      }
      if (changed.length) {
        const prior = String(attrs['@_style'] || '').split(';').filter(rule => !changed.includes(rule.split(':')[0].trim()));
        attrs['@_style'] = [...prior, ...changed.map(k => `${k}:${paint[k]} !important`)].filter(Boolean).join(';');
      }
    }
    for (const [key, v] of Object.entries(value)) if (key !== ':@') { if (Array.isArray(v)) v.forEach(walk); else walk(v); }
  }
  walk(tree);
  return new XMLBuilder({ ignoreAttributes: false, preserveOrder: true }).build(tree);
}

function scopedSvg(svg, scope, width, height, fallbackViewBox) {
  const tree = new XMLParser({ ignoreAttributes: false, preserveOrder: true }).parse(svg);
  const root = tree.find(node => node.svg);
  fail(root, 'SVG元素无效');
  const ids = new Map(); let index = 0;
  function visit(value, fn) { if (!value || typeof value !== 'object') return; fn(value); for (const [key, v] of Object.entries(value)) if (key !== ':@') { if (Array.isArray(v)) v.forEach(n => visit(n, fn)); else visit(v, fn); } }
  visit(tree, node => { if (node[':@']?.['@_id']) ids.set(node[':@']['@_id'], `s_${scope}_${index++}`); });
  if (root[':@']?.['@_id']) ids.set(root[':@']['@_id'], scope);
  const refs = value => String(value).replace(/url\(\s*(['"]?)#([^)'"\s]+)\1\s*\)/g, (_, quote, id) => `url(#${ids.get(id) || id})`);
  visit(tree, node => {
    const attrs = node[':@'];
    if (attrs) for (const [key, value] of Object.entries(attrs)) {
      if (key === '@_id') attrs[key] = ids.get(value) || value;
      else if (key === '@_href' || key === '@_xlink:href') attrs[key] = String(value).startsWith('#') ? `#${ids.get(String(value).slice(1)) || String(value).slice(1)}` : value;
      else attrs[key] = refs(value);
    }
    if (Array.isArray(node.style)) for (const text of node.style) if (text['#text']) {
      const ast = cssTree.parse(refs(text['#text']));
      cssTree.walk(ast, { visit: 'IdSelector', enter(selector) { selector.name = ids.get(selector.name) || selector.name; } });
      cssTree.walk(ast, { visit: 'Rule', enter(rule) {
        if (rule.prelude?.type !== 'SelectorList') return;
        const selectors = [];
        rule.prelude.children.forEach(selector => {
          const original = cssTree.generate(selector);
          selectors.push(`${original.replace(/:root/g, `#${scope}`)}.${scope}_content`);
        });
        rule.prelude = cssTree.parse(selectors.join(','), { context: 'selectorList' });
      } });
      text['#text'] = cssTree.generate(ast);
    }
  });
  root[':@'] ||= {}; Object.assign(root[':@'], { '@_id': scope, '@_width': width, '@_height': height, '@_viewBox': root[':@']['@_viewBox'] || fallbackViewBox, '@_preserveAspectRatio': 'none' });
  visit(tree, node => {
    const element = Object.keys(node).find(key => key !== ':@' && key !== '#text' && Array.isArray(node[key]));
    if (!element) return;
    node[':@'] ||= {};
    node[':@']['@_class'] = `${node[':@']['@_class'] || ''} ${scope}_content`.trim();
  });
  // resvg applies nested <svg opacity> twice; a real compositing group applies it once.
  if (root[':@']['@_opacity'] !== undefined) {
    const opacity = root[':@']['@_opacity']; delete root[':@']['@_opacity'];
    root.svg = [{ g: root.svg, ':@': { '@_opacity': opacity } }];
  }
  return new XMLBuilder({ ignoreAttributes: false, preserveOrder: true }).build([root]);
}

export async function documentSvg(document, getAsset, { textAsPaths = false } = {}) {
  const cache = new Map();
  const load = async id => { if (!cache.has(id)) cache.set(id, await getAsset(id)); return cache.get(id); };
  const fonts = new Map();
  const faces = new Map();
  for (const layer of document.layers) if (layer.fontAssetId && !fonts.has(fontAlias(layer.fontAssetId))) {
    const f = await load(layer.fontAssetId); fonts.set(fontAlias(layer.fontAssetId), f);
    const face = fontkit.create(f.bytes); faces.set(layer.fontAssetId, face); faces.set(fontAlias(layer.fontAssetId), face);
  }
  const css = textAsPaths ? '' : [...fonts].map(([family, f]) => `@font-face{font-family:'${family}';font-weight:${fontWeight(faces.get(family))};src:url('${uri(f)}');}`).join('');
  const byParent = new Map();
  for (const layer of [...document.layers].sort((a, b) => a.z - b.z)) {
    const key = layer.parentId || '';
    byParent.set(key, [...(byParent.get(key) || []), layer]);
  }
  const defs = [];
  async function render(layer, ancestors) {
    if (!layer.visible || layer.type === 'mask') return '';
    fail(!ancestors.has(layer.id), '图层父级循环');
    const next = new Set([...ancestors, layer.id]);
    const transform = `translate(${layer.x} ${layer.y}) rotate(${layer.rotation || 0})`;
    const opacity = layer.opacity ?? 1;
    let body = '';
    let mask = '';
    let clip = '';
    if(layer.type==='group'&&layer.metadata?.frameClip===true){const id=`c_${hash(Buffer.from(layer.id)).slice(0,24)}`;defs.push(`<clipPath id="${id}" clipPathUnits="userSpaceOnUse"><rect x="0" y="0" width="${layer.width}" height="${layer.height}"/></clipPath>`);clip=` clip-path="url(#${id})"`;}
    if (layer.maskAssetId) {
      const m = await load(layer.maskAssetId), id = `m_${hash(Buffer.from(layer.id)).slice(0,24)}`;
      defs.push(`<mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="${layer.width}" height="${layer.height}" style="mask-type:luminance"><image href="${uri(m)}" width="${layer.width}" height="${layer.height}" preserveAspectRatio="none"/></mask>`);
      mask = ` mask="url(#${id})"`;
    }
    const preservedText = layer.type === 'text' && layer.assetId && layer.metadata?.fontConfirmed !== true;
    if (layer.type === 'raster' || preservedText) {
      if (layer.assetId) {
        const original = await load(layer.assetId);
        const record = { ...original, bytes: await encodePNG(await decodeRGBA(original.bytes, original.asset.mime)), asset: { ...original.asset, mime: 'image/png' } };
        body = `<image href="${uri(record)}" width="${layer.width}" height="${layer.height}" preserveAspectRatio="none"/>`;
      }
    } else if (layer.type === 'vector' && layer.assetId) {
      const record = await load(layer.assetId);
      const parsed = stylePaths(record.bytes.toString('utf8'), { ...(layer.fill ? { '*': { fill: layer.fill } } : {}), ...layer.metadata?.pathStyles });
      body = scopedSvg(parsed, `v_${hash(Buffer.from(layer.id)).slice(0,24)}`, layer.width, layer.height, `0 0 ${record.asset.width || layer.width} ${record.asset.height || layer.height}`);
    } else if (layer.type === 'text') {
      const size = layer.fontSize || 24, leading = (layer.lineHeight || 1.2) * size;
      const lines = String(layer.text || '').split('\n');
      const face = faces.get(layer.fontAssetId);
      fail(face, '文字导出需要工程中的实际字体，请先选择字体', 'font_unavailable');
      body = textAsPaths ? glyphPaths(layer, face) : `<text font-family="${fontAlias(layer.fontAssetId)}" font-size="${size}" font-weight="${fontWeight(face)}" letter-spacing="${layer.tracking || 0}" fill="${escape(layer.fill || '#20232b')}"${layer.stroke ? ` stroke="${escape(layer.stroke)}" stroke-width="${layer.strokeWidth || 1}" paint-order="stroke fill"` : ''}>${lines.map((line, index) => `<tspan x="0" y="${size + index * leading}">${escape(line)}</tspan>`).join('')}</text>`;
      if (layer.metadata?.backgroundDetached !== true && layer.metadata?.cleanBackgroundAssetId) {
        const background = await load(layer.metadata.cleanBackgroundAssetId);
        body = `<image href="${uri(background)}" width="${layer.width}" height="${layer.height}" preserveAspectRatio="none"/>${body}`;
      }
    }
    for (const child of byParent.get(layer.id) || []) body += await render(child, next);
    return `<g data-layer-id="${escape(layer.id)}" transform="${transform}" opacity="${opacity}"${mask}${clip}>${body}</g>`;
  }
  let content = '';
  for (const layer of byParent.get('') || []) content += await render(layer, new Set());
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${document.width}" height="${document.height}" viewBox="0 0 ${document.width} ${document.height}"><defs>${css ? `<style>${css}</style>` : ''}${defs.join('')}</defs>${content}</svg>`, fonts };
}

export async function documentPng(document, getAsset) {
  // resvg resolves fonts by their embedded family name and does not load SVG @font-face aliases.
  // Render registered text from its own actual glyph paths; downloadable SVG keeps semantic text.
  const { svg, fonts } = await documentSvg(document, getAsset, { textAsPaths: true });
  const dir = mkdtempSync(join(tmpdir(), 'image2-fonts-'));
  try {
    const files = [...fonts.values()].map((font, index) => {
      const file = join(dir, `${index}.ttf`); writeFileSync(file, font.bytes); return file;
    });
    return Buffer.from(new Resvg(svg, { font: { loadSystemFonts: false, fontFiles: files, defaultFontFamily: 'Noto Sans CJK SC' } }).render().asPng());
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export async function documentPdf(document, getAsset) {
  const pdf = new PDFDocument({ size: [document.width, document.height], margin: 0, compress: true, info: { Title: document.name, CreationDate: new Date(document.updatedAt), ModDate: new Date(document.updatedAt) } });
  const chunks = [], result = new Promise((resolve, reject) => { pdf.on('data', chunk => chunks.push(chunk)); pdf.on('end', () => resolve(Buffer.concat(chunks))); pdf.on('error', reject); });
  const embeddedFonts = new Map();
  const layers = [...document.layers].sort((a, b) => a.z - b.z);
  const byId = new Map(layers.map(l => [l.id, l]));
  const children = new Map();
  for (const layer of layers) { const key = layer.parentId || ''; children.set(key, [...children.get(key) || [], layer]); }
  const ordered = [];
  function order(parent = '') {
    for (const layer of children.get(parent) || []) {
      if (!layer.visible) continue;
      if (layer.type === 'group' && (layer.opacity < 1 || layer.maskAssetId) || layer.maskAssetId && layer.type === 'text') {
        const kept = new Set([layer.id]);
        function descend(id) { for (const child of children.get(id) || []) { kept.add(child.id); descend(child.id); } }
        descend(layer.id);
        let ancestor = layer.parentId;
        while (ancestor) { kept.add(ancestor); ancestor = byId.get(ancestor)?.parentId; }
        ordered.push({ flattened: { ...document, layers: layers.filter(l => kept.has(l.id)) } });
      } else { if (!['group','mask'].includes(layer.type)) ordered.push({ layer }); order(layer.id); }
    }
  }
  order();
  function ancestry(layer) { const nodes = [layer], seen = new Set([layer.id]); let parent = layer.parentId; while (parent) { fail(!seen.has(parent) && byId.has(parent), '图层父级无效'); seen.add(parent); const p = byId.get(parent); nodes.unshift(p); parent = p.parentId; } return nodes; }
  for (const entry of ordered) {
    // PDF alpha on individual paths cannot represent a composited group's alpha.
    // Preserve that group's visible pixels; the SVG/project retains its editable tree.
    if (entry.flattened) { pdf.image(await documentPng(entry.flattened, getAsset), 0, 0, { width: document.width, height: document.height }); continue; }
    const { layer } = entry;
    const lineage = ancestry(layer);
    if (lineage.some(l => !l.visible)) continue;
    pdf.save();
    for (const l of lineage) {pdf.translate(l.x, l.y).rotate(l.rotation || 0);if(l.type==='group'&&l.metadata?.frameClip===true)pdf.rect(0,0,l.width,l.height).clip();}
    pdf.opacity(lineage.reduce((a, l) => a * (l.opacity ?? 1), 1));
    if (layer.type === 'text' && !(layer.assetId && layer.metadata?.fontConfirmed !== true)) {
      if (layer.metadata?.backgroundDetached !== true && layer.metadata?.cleanBackgroundAssetId) {
        const background = await getAsset(layer.metadata.cleanBackgroundAssetId);
        pdf.image(await encodePNG(await decodeRGBA(background.bytes, background.asset.mime)), 0, 0, { width: layer.width, height: layer.height });
      }
      fail(layer.fontAssetId, '文字PDF导出需要工程中的实际字体，请先选择字体', 'font_unavailable');
      if (!embeddedFonts.has(layer.fontAssetId)) embeddedFonts.set(layer.fontAssetId, await pdfFontBytes((await getAsset(layer.fontAssetId)).bytes));
      pdf.font(embeddedFonts.get(layer.fontAssetId));
      const size = layer.fontSize || 24;
      pdf.fontSize(size).fillColor(layer.fill || '#20232b');
      if (layer.stroke) pdf.strokeColor(layer.stroke).lineWidth(layer.strokeWidth || 1);
      // Explicit lines share the SVG baseline. The editing box is not a text clipping box.
      for (const [index, line] of String(layer.text || '').split('\n').entries()) pdf.text(line, 0, size + index * size * (layer.lineHeight || 1.2), { lineBreak: false, baseline: 'alphabetic', characterSpacing: layer.tracking || 0, fill: true, stroke: Boolean(layer.stroke) });
    } else if (layer.type === 'vector' && layer.assetId && !layer.maskAssetId) {
      const record = await getAsset(layer.assetId);
      SVGtoPDF(pdf, stylePaths(record.bytes.toString('utf8'), { ...(layer.fill ? { '*': { fill: layer.fill } } : {}), ...layer.metadata?.pathStyles }), 0, 0, { width: layer.width, height: layer.height, preserveAspectRatio: 'none', assumePt: true });
    } else {
      // Raster/vector effects retain appearance; standalone SVG keeps true paths.
      const record = await getAsset(layer.assetId);
      const raw = await decodeRGBA(record.bytes, record.asset.mime);
      if (layer.maskAssetId) {
        const mask = await getAsset(layer.maskAssetId), pixels = await decodeRGBA(mask.bytes, mask.asset.mime);
        fail(pixels.width === raw.width && pixels.height === raw.height, '图层遮罩尺寸不匹配');
        for (let i = 0; i < raw.width * raw.height; i++) raw.data[i * 4 + 3] = Math.round(raw.data[i * 4 + 3] * (pixels.data[i * 4] * .2126 + pixels.data[i * 4 + 1] * .7152 + pixels.data[i * 4 + 2] * .0722) * pixels.data[i * 4 + 3] / 65025);
      }
      const png = await encodePNG(raw);
      pdf.image(png, 0, 0, { width: layer.width, height: layer.height });
    }
    pdf.restore();
  }
  pdf.end(); return result;
}

export async function projectBundle(document, revisions, getAsset) {
  const ids = new Set(document.assetIds || []);
  for (const revision of revisions) for (const id of (revision.document || revision.snapshot || revision).assetIds || []) ids.add(id);
  const files = {}, assets = [];
  const direct = new Set();
  for (const doc of [document, ...revisions.map(r => r.document || r.snapshot || r)]) for (const layer of doc.layers || []) {
    for (const key of ['assetId','sourceAssetId','maskAssetId','fontAssetId']) if (layer[key]) direct.add(layer[key]);
    for (const key of ['cleanBackgroundAssetId','sourcePatchAssetId']) if (layer.metadata?.[key]) direct.add(layer.metadata[key]);
  }
  const included = new Set(); let totalBytes = 0;
  for (const id of ids) {
    const { asset, bytes } = await getAsset(id);
    if (asset.metadata?.role === 'export' && !direct.has(id)) continue;
    fail(included.size < 1999, '工程包素材数量超过重新导入上限', 'bundle_too_large');
    fail(bytes.length <= 64 * 1024 * 1024, '单份素材超过64MB工程包上限', 'bundle_too_large');
    totalBytes += bytes.length;
    fail(totalBytes <= MAX_BUNDLE, '工程包解压内容超过128MB重新导入上限', 'bundle_too_large');
    included.add(id);
    const path = `assets/${asset.id}`;
    files[path] = new Uint8Array(bytes);
    const { url: _url, documentId: _documentId, ...descriptor } = asset;
    void _url; void _documentId;
    assets.push({ ...descriptor, file: path, hash: hash(bytes) });
  }
  const clean = doc => ({ ...doc, assetIds: (doc.assetIds || []).filter(id => included.has(id)) });
  files['manifest.json'] = strToU8(JSON.stringify({ format: 'weiai-image2-project', version: 2, document: clean(document), revisions: revisions.map(r => clean(r.document || r.snapshot || r)), assets }));
  fail(totalBytes + files['manifest.json'].length <= MAX_BUNDLE, '工程包解压内容超过128MB重新导入上限', 'bundle_too_large');
  const bytes = Buffer.from(zipSync(files, { level: 6, mtime: new Date('2000-01-01T00:00:00Z') }));
  fail(bytes.length <= MAX_ARCHIVE, '工程包超过64MB传输上限，请拆分工程后导出', 'bundle_too_large');
  return bytes;
}

export async function exportDocument(format, document, ctx) {
  const name = (document.name || '设计工程').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 100);
  if (format === 'project') return { bytes: await projectBundle(document, ctx.revisions || [], ctx.getAsset), mime: 'application/zip', name: `${name}.image2.zip` };
  document = scopedExportDocument(document, ctx);
  if (format === 'svg') return { bytes: Buffer.from((await documentSvg(document, ctx.getAsset)).svg), mime: 'image/svg+xml', name: `${name}.svg` };
  if (format === 'png') return { bytes: await documentPng(document, ctx.getAsset), mime: 'image/png', name: `${name}.png` };
  if (format === 'pdf') return { bytes: await documentPdf(document, ctx.getAsset), mime: 'application/pdf', name: `${name}.pdf` };
  fail(false, '不支持的导出格式');
}

export async function importProjectBundle(store, owner, input, inspectAsset) {
  fail(typeof input.data === 'string' && input.data.length <= 96 * 1024 * 1024, '工程包过大或无效');
  const zipped = Buffer.from(input.data, 'base64');
  fail(zipped.length <= MAX_ARCHIVE, '工程包超过64MB传输上限');
  let total = 0, rejected = false, count = 0;
  let files;
  try { files = unzipSync(new Uint8Array(zipped), { filter: file => {
    total += file.originalSize; count++;
    const allowed = count <= 2000 && total <= MAX_BUNDLE && file.originalSize <= 64 * 1024 * 1024 && /^(manifest\.json|assets\/[a-zA-Z0-9-]+)$/.test(file.name);
    if (!allowed) rejected = true; return allowed;
  } }); } catch { fail(false, '工程包无法读取'); }
  fail(!rejected && files['manifest.json'], '工程包内容超限或路径无效');
  let manifest;
  try { manifest = JSON.parse(strFromU8(files['manifest.json'])); } catch { fail(false, '工程清单无效'); }
  fail(manifest.format === 'weiai-image2-project' && manifest.version === 2 && manifest.document && Array.isArray(manifest.assets), '不支持的工程版本');
  // Validate all bytes before exposing an authored document.
  const inspected = [];
  const ids = new Set();
  for (const a of manifest.assets) {
    fail(typeof a.id === 'string' && !ids.has(a.id) && /^assets\/[a-zA-Z0-9-]+$/.test(a.file), '工程资产描述无效');
    ids.add(a.id);
    const bytes = Buffer.from(files[a.file] || []);
    fail(bytes.length && hash(bytes) === a.hash, '工程资产校验失败');
    inspected.push({ descriptor: a, bytes, info: await inspectAsset(bytes, a.mime) });
  }
  const idMap = new Map(inspected.map(item => [item.descriptor.id, randomUUID()]));
  for (const layer of manifest.document.layers || []) idMap.set(layer.id, randomUUID());
  for (const revision of manifest.revisions || []) for (const layer of (revision.document || revision.snapshot || revision).layers || []) if (!idMap.has(layer.id)) idMap.set(layer.id, randomUUID());
  const remap = value => typeof value === 'string' ? idMap.get(value) || value : Array.isArray(value) ? value.map(remap) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remap(v)])) : value;
  return store.transaction(() => {
  const doc = store.createDocument(owner, { name: input.name || manifest.document.name, width: manifest.document.width, height: manifest.document.height });
  idMap.set(manifest.document.id, doc.id);
  const remaining = [...inspected], added = new Set();
  while (remaining.length) {
    const index = remaining.findIndex(item => (item.descriptor.inputs || []).every(ref => added.has(ref.assetId)));
    fail(index >= 0, '工程素材引用缺失或形成循环');
    const [item] = remaining.splice(index, 1);
    store.addAsset(doc.id, owner, { assignedId: idMap.get(item.descriptor.id), name: item.descriptor.name, mime: item.info.mime, width: item.info.width, height: item.info.height, inputs: (item.descriptor.inputs || []).map(ref => ({ ...ref, assetId: idMap.get(ref.assetId) })), metadata: { ...remap(item.descriptor.metadata), ...item.info.metadata, importedAssetId: item.descriptor.id } }, item.bytes);
    added.add(item.descriptor.id);
  }
  const currentDocument = { ...remap(manifest.document), id: doc.id, createdAt: doc.createdAt, updatedAt: doc.updatedAt };
  const revisions = (manifest.revisions || []).map(revision => ({ ...remap(revision.document || revision.snapshot || revision), id: doc.id, createdAt: doc.createdAt }));
  if (revisions.length && store.importRevisions) return store.importRevisions(doc.id, owner, { revisions, currentDocument });
  const commands = (currentDocument.layers || []).map(layer => ({ type: 'layer.add', layer }));
  return commands.length ? store.command(doc.id, owner, { baseRevision: doc.revision, commandId: randomUUID(), commands }) : doc;
  });
}
