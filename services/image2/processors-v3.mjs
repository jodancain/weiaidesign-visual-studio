import { randomUUID } from 'node:crypto';
import { CONTENT_MIME, IDENTITY, multiplyMatrix, inverseMatrix, worldMatrix, validateContentJSON } from './domain-v3.mjs';
import { executeOperation, encodePNG } from './processors.mjs';
import { createNodeResolver } from './render-node.mjs';
export const V3_CPU_OPERATIONS = Object.freeze(['resize', 'crop', 'pad', 'rotate', 'flip', 'recolor', 'erase', 'color_key', 'trace', 'fill', 'repair', 'prepare_text', 'adjust', 'filter']);
const unavailable = message => {
    throw Object.assign(new Error(message), { status: 422, code: 'V3_OPERATION_UNAVAILABLE', retryable: false });
};
const translation = (x, y) => [1, 0, 0, 1, x, y];
const rotation = degrees => {
    const angle = degrees * Math.PI / 180;
    return [Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0];
};
export function validateV3Operation(document, request) {
    if (!V3_CPU_OPERATIONS.includes(request.operation))
        unavailable('专业工程尚未接通此模型或后台 Agent 操作；原工程与任务回执保留，请使用现有生成入口。');
    const target = document.layers.find(layer => layer.id === request.targetLayerId), content = document.contentAssets.find(content => content.id === target?.contentId);
    if (!target)
        unavailable('请选择当前图层。');
    if (!(target.type === 'raster' && content?.kind === 'raster' || target.type === 'text' && content?.kind === 'preservedText'))
        unavailable('文字和矢量请直接编辑内容与图层属性；像素处理需要真实位图或原文字裁片。');
    let cursor = target;
    while (cursor) {
        if (cursor.masks.some(mask => mask.enabled) || cursor.effects.some(effect => effect.enabled) || cursor.clipToLayerId)
            unavailable('此图层含有非破坏蒙版、效果或剪切关系，请先明确烘焙可见外观后再做像素操作；原内容保持。');
        cursor = document.layers.find(layer => layer.id === cursor.parentId);
    }
    if (request.inputs?.some(input => input.role === 'active_mask'))
        unavailable('显示蒙版不能隐式烘焙；请先明确烘焙可见外观。');
    if (request.operation === 'prepare_text' && content.kind !== 'preservedText')
        unavailable('请先把扁平图中的文字区域保留为原文字裁片，再准备清底。');
    if (request.params?.purpose === 'text_background' && (!['prepare_text', 'fill', 'repair'].includes(request.operation) || content.kind !== 'preservedText'))
        unavailable('文字背景处理需要原文字裁片，以及明确的填色或传统修补操作。');
    if (request.operation === 'trace' && content.kind === 'preservedText')
        unavailable('原文字裁片需保留待确认状态；请复制为位图后描摹。');
    return { target, content };
}
/** Reuses tested pixel kernels, while v3 content, geometry and receipts stay authoritative. */
export async function executeV3Operation(request, ctx, legacy = executeOperation) {
    if (ctx.checkpoints?.v3ProcessorResult)
        return ctx.checkpoints.v3ProcessorResult;
    const { target, content } = validateV3Operation(ctx.document, request);
    const preserved = content.kind === 'preservedText' ? JSON.parse((await ctx.getAsset(content.assetId)).bytes.toString('utf8')) : null;
    const currentAssetId = preserved?.assetId || content.assetId;
    if (!currentAssetId)
        unavailable('此文字没有原像素裁片，无法可靠执行像素处理。');
    const baseId = request.inputs?.find(input => input.role === 'base')?.assetId || currentAssetId, source = await ctx.getAsset(baseId), width = source.asset.width, height = source.asset.height;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(source.asset.mime) || !(width > 0 && height > 0))
        unavailable('所选输入必须是具有实际尺寸的位图。');
    // Preflight inverses before the kernel writes any output/checkpoint assets.
    const parent = target.parentId ? worldMatrix(ctx.document, target.parentId) : [...IDENTITY];
    if (request.operation === 'rotate')
        inverseMatrix(parent);
    if ((request.operation === 'prepare_text' || request.params?.purpose === 'text_background') && baseId !== currentAssetId)
        unavailable('清底必须针对当前原文字裁片；历史裁片请先复制到新的图层。');
    const projected = { id: target.id, name: target.name, type: preserved ? 'text' : 'raster', assetId: currentAssetId, x: 0, y: 0, rotation: 0, width, height, opacity: 1, visible: true, locked: false, z: 0, ...(preserved ? { text: preserved.text || '' } : {}), metadata: { ...target.metadata, ...(preserved ? { role: 'sourcePatch', sourcePatchAssetId: baseId, fontConfirmed: false, fontStatus: 'unknown' } : {}) } };
    const temporary = { ...ctx.document, schemaVersion: 2, layers: [projected] };
    const legacyRequest = { ...request, inputs: [...(request.inputs || []).filter(input => input.role !== 'base'), { role: 'base', assetId: baseId }] };
    const result = await legacy(legacyRequest, { ...ctx, document: temporary });
    if (ctx.cancelled?.())
        throw Object.assign(new Error('任务已取消，已完成产物和回执保留'), { status: 409, code: 'CANCELLED' });
    const patch = result.commands.find(command => command.type === 'layer.update' && command.layerId === target.id)?.patch;
    if (!patch)
        unavailable('像素操作没有返回可靠的图层修改。');
    let final;
    if (request.operation === 'prepare_text' || request.params?.purpose === 'text_background' && preserved && result.output.cleanBackgroundAssetId && !patch.assetId) {
        final = { ...result, commands: [{ type: 'layer.update', layerId: target.id, patch: { metadata: { ...target.metadata, ...patch.metadata } } }], output: { ...result.output, contentId: target.contentId } };
    }
    else {
        if (!patch.assetId)
            unavailable('像素操作没有返回新的不可变素材。');
        const next = await ctx.getAsset(patch.assetId), outW = next.asset.width, outH = next.asset.height;
        let kind = patch.type === 'vector' ? 'svg' : preserved ? 'preservedText' : 'raster', descriptor;
        if (kind === 'raster')
            descriptor = { id: randomUUID(), kind, assetId: next.asset.id, formatVersion: 1 };
        else {
            const payload = validateContentJSON(kind === 'svg' ? { formatVersion: 1, kind: 'svg', sourceAssetId: next.asset.id, fontAssetIds: [] } : { ...preserved, assetId: next.asset.id, status: 'preserved' });
            const asset = await ctx.saveAsset('v3_content', { name: `${kind} content.json`, mime: CONTENT_MIME, inputs: [{ role: 'source', assetId: next.asset.id, hash: next.asset.hash }] }, Buffer.from(JSON.stringify(payload)));
            descriptor = { id: randomUUID(), kind, assetId: asset.id, formatVersion: 1 };
        }
        const b = target.localBounds, frame = multiplyMatrix(translation(b.x, b.y), [b.width / width, 0, 0, b.height / height, 0, 0]), baseMatrix = multiplyMatrix(target.matrix, frame);
        let delta = [...IDENTITY], pixelMap = [...IDENTITY], physicalDelta;
        if (request.operation === 'crop') {
            const x = Number(request.params?.x), y = Number(request.params?.y);
            delta = translation(x, y);
            pixelMap = translation(-x, -y);
        }
        else if (request.operation === 'pad') {
            delta = translation(patch.x || 0, patch.y || 0);
            pixelMap = translation(-(patch.x || 0), -(patch.y || 0));
        }
        else if (request.operation === 'resize') {
            pixelMap = [outW / width, 0, 0, outH / height, 0, 0];
            if (request.params?.resizeLayout !== true)
                delta = inverseMatrix(pixelMap);
        }
        else if (request.operation === 'flip')
            pixelMap = ['horizontal', 'x'].includes(request.params?.axis) ? [-1, 0, 0, 1, width, 0] : [1, 0, 0, -1, 0, height];
        else if (request.operation === 'rotate') {
            pixelMap = multiplyMatrix(translation(outW / 2, outH / 2), multiplyMatrix(rotation(Number(request.params.degrees)), translation(-width / 2, -height / 2)));
            const sourceWorld = multiplyMatrix(parent, baseMatrix), cx = sourceWorld[0] * width / 2 + sourceWorld[2] * height / 2 + sourceWorld[4], cy = sourceWorld[1] * width / 2 + sourceWorld[3] * height / 2 + sourceWorld[5];
            physicalDelta = multiplyMatrix(translation(cx, cy), multiplyMatrix(rotation(Number(request.params.degrees)), translation(-cx, -cy)));
            delta = null;
        }
        const matrix = delta ? multiplyMatrix(baseMatrix, delta) : multiplyMatrix(inverseMatrix(parent), multiplyMatrix(physicalDelta, multiplyMatrix(multiplyMatrix(parent, baseMatrix), inverseMatrix(pixelMap))));
        // Preserve disabled authoring masks; explicitly transform linked mask content
        // with the pixel operation, while domain commands preserve unlinked world masks.
        const masks = target.masks.map(mask => {
            if (!mask.linked)
                return { ...mask };
            if (mask.coordinateSpace === 'layerLocal')
                return { ...mask, matrix: multiplyMatrix(multiplyMatrix(pixelMap, inverseMatrix(frame)), mask.matrix) };
            const oldWorld = multiplyMatrix(parent, baseMatrix), newWorld = multiplyMatrix(parent, matrix), d = physicalDelta || multiplyMatrix(multiplyMatrix(newWorld, pixelMap), inverseMatrix(oldWorld));
            return { ...mask, matrix: multiplyMatrix(d, mask.matrix) };
        });
        const metadata = { ...target.metadata, ...patch.metadata };
        if (preserved) {
            for (const key of ['cleanBackgroundAssetId', 'glyphMaskAssetId', 'backgroundStatus', 'backgroundMethod', 'backgroundRGBA'])
                delete metadata[key];
            Object.assign(metadata, { role: 'sourcePatch', sourcePatchAssetId: next.asset.id, fontConfirmed: false, fontStatus: 'unknown' });
        }
        const updated = { ...target, type: kind === 'svg' ? 'vector' : preserved ? 'text' : 'raster', contentId: descriptor.id, localBounds: { x: 0, y: 0, width: outW, height: outH }, matrix, masks, metadata };
        const commands = [{ type: 'content.add', content: descriptor }];
        if (updated.type !== target.type)
            commands.push({ type: 'layer.remove', layerId: target.id }, { type: 'layer.add', layer: updated });
        else
            commands.push({ type: 'layer.content', layerId: target.id, contentId: descriptor.id, localBounds: updated.localBounds }, { type: 'layer.update', layerId: target.id, patch: { matrix, metadata, masks } });
        final = { ...result, commands, output: { ...result.output, contentId: descriptor.id } };
    }
    await ctx.checkpoint({ v3ProcessorResult: final });
    return final;
}
export async function rasterReference(document, layer, getAsset) {
    const content = document.contentAssets.find(content => content.id === layer.contentId), resource = await createNodeResolver(getAsset)(content, { document, layer, role: 'content' });
    if (resource.kind !== 'raster')
        unavailable('此引用需要使用文档渲染接口生成实际像素。');
    return encodePNG({ data: Buffer.from(resource.pixels), width: resource.width, height: resource.height });
}
