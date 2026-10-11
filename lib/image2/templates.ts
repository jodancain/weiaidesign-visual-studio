import type { DocumentCommand, ImageAsset, ImageDocument, ImageLayer } from './types';

export type TemplateKind = 'poster' | 'logo' | 'print';
export const templateNames: Record<TemplateKind, string> = { poster: '中文海报', logo: 'Logo 展示', print: '服装印花' };

/** Code-only layout of existing immutable assets, next to the original artwork. */
export function buildTemplate({ document, selected, font, kind, paperAsset, idFactory = () => crypto.randomUUID() }: {
  document: ImageDocument; selected?: ImageLayer; font: ImageAsset; kind: TemplateKind; paperAsset?: ImageAsset; idFactory?: () => string;
}): DocumentCommand[] {
  if (!font.mime.startsWith('font/') || !document.assetIds.includes(font.id)) throw new Error('先为工程选择实际字体');
  if (!(kind in templateNames)) throw new Error('模板不存在');
  const w = document.width, h = document.height, nextWidth = 2 * w + 64;
  if (nextWidth > 32768 || nextWidth * h > 40000000) throw new Error('添加模板后画布过大，请先建立较小工程');
  if (paperAsset && (!document.assetIds.includes(paperAsset.id) || paperAsset.mime !== 'image/svg+xml')) throw new Error('模板底板必须是本工程的 SVG');
  const rootZ = Math.max(0, ...document.layers.filter(l => !l.parentId).map(l => l.z)) + 1;
  const group: ImageLayer = { id: idFactory(), type: 'group', name: templateNames[kind], x: w + 64, y: 0, width: w, height: h, rotation: 0, opacity: 1, visible: true, locked: false, z: rootZ, metadata: { template: kind } };
  const layers: ImageLayer[] = [group];
  if (paperAsset) layers.push({ ...group, id: idFactory(), parentId: group.id, type: 'vector', name: '模板底板', assetId: paperAsset.id, x: 0, z: 0, locked: true });
  const unit = Math.min(w, h), margin = unit * .06;
  function text(value: string, name: string, x: number, y: number, size: number, z: number, fill = '#20232b') {
    layers.push({ id: idFactory(), parentId: group.id, type: 'text', name, text: value, x, y, width: Math.max(1, w - x - margin), height: size * 1.5, rotation: 0, opacity: 1, visible: true, locked: false, z, fontAssetId: font.id, fontFamily: String(font.metadata?.family || ''), fontSize: size, fontWeight: 400, lineHeight: 1.2, tracking: 0, fill, editability: 'text', metadata: { fontConfirmed: true, template: kind } });
  }
  function copy(source: ImageLayer | undefined, x: number, y: number, width: number, height: number, z: number, name: string) {
    if (!source?.assetId || !['raster','vector'].includes(source.type) || !document.assetIds.includes(source.assetId)) return;
    const scale = Math.min(width / source.width, height / source.height), sw = source.width * scale, sh = source.height * scale;
    layers.push({ ...structuredClone(source), id: idFactory(), parentId: group.id, name, x: x + (width - sw) / 2, y: y + (height - sh) / 2, width: sw, height: sh, rotation: 0, opacity: 1, visible: true, locked: false, z, metadata: { ...source.metadata, template: kind, copiedFromLayerId: source.id } });
  }
  const logo = selected?.type === 'vector' ? selected : document.layers.find(l => l.type === 'vector' && l.visible && l.assetId);
  const raster = selected?.type === 'raster' ? selected : document.layers.find(l => l.type === 'raster' && l.visible && l.assetId);
  if (kind === 'poster') {
    text('把想法变成作品', '海报标题', margin, h * .05, unit * .075, 3);
    text('在这里填写你的中文副标题', '海报副标题', margin, h * .17, unit * .026, 3, '#5f6572');
    copy(raster || logo, margin, h * .27, w - margin * 2, h * .52, 1, '海报主视觉');
    copy(logo, w * .75, h * .87, w * .18, h * .075, 2, '品牌 Logo');
    text('日期 · 地点 · 联系方式', '海报说明', margin, h * .87, unit * .023, 3, '#5f6572');
  } else if (kind === 'logo') {
    text('品牌标识', '品牌标题', margin, h * .05, unit * .065, 3);
    copy(logo || raster, w * .15, h * .25, w * .7, h * .42, 1, 'Logo 原始素材');
    text('YOUR BRAND', '品牌名称', margin, h * .77, unit * .06, 3);
    text('编辑文字和路径，保存你的品牌版本', '品牌说明', margin, h * .89, unit * .022, 3, '#5f6572');
  } else {
    text('原创印花', '印花标题', margin, h * .05, unit * .06, 3);
    copy(raster || logo, w * .2, h * .21, w * .6, h * .52, 1, '印花原始素材');
    text('MADE TO CREATE', '印花文字', margin, h * .8, unit * .055, 3);
    text('在这里修改系列与年份', '印花说明', margin, h * .9, unit * .022, 3, '#5f6572');
  }
  return [{ type: 'document.update', patch: { width: nextWidth } }, ...layers.map(layer => ({ type: 'layer.add' as const, layer }))];
}
