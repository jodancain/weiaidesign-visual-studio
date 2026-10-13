import { randomUUID } from 'node:crypto';
import { fail, clone, validId, canonical, timestamp } from './domain.mjs';
export const CONTENT_MIME = 'application/vnd.weiai.image2-content+json';
export const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);
export const V3_FEATURES = Object.freeze(['matrix', 'content-assets', 'layer-masks', 'saved-selections', 'artboards', 'guides', 'blend-modes', 'layer-effects', 'clipping', 'passthrough-groups']);
const finite = n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e7;
const obj = (v, label) => fail(v && typeof v === 'object' && !Array.isArray(v), `${label} must be an object`);
const boundedString = (v, n = 500) => typeof v === 'string' && v.length <= n;
const fields = (v, keys, label) => fail(Object.keys(v).every(k => keys.includes(k)), `unsupported ${label} property`);
const optionalId = (v, label) => {
    if (v !== undefined)
        fail(validId(v), `invalid ${label}`);
};
export function matrix(value) {
    fail(Array.isArray(value) && value.length === 6 && value.every(finite), 'invalid six-parameter matrix');
    return [...value];
}
export function multiplyMatrix(a, b) {
    return matrix([a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]]);
}
export function inverseMatrix(m) {
    matrix(m);
    const det = m[0] * m[3] - m[1] * m[2];
    fail(Number.isFinite(det) && Math.abs(det) > 1e-12, '父图层变换不可逆，请恢复缩放后再执行世界坐标变换', 422, 'MATRIX_NOT_INVERTIBLE');
    return matrix([m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det]);
}
export function worldMatrix(document, layerId) {
    const byId = new Map(document.layers.map(l => [l.id, l]));
    let layer = byId.get(layerId);
    fail(layer, 'layer not found', 404);
    const chain = [], seen = new Set();
    while (layer) {
        fail(!seen.has(layer.id), 'cyclic layer groups');
        seen.add(layer.id);
        chain.unshift(layer.matrix);
        layer = layer.parentId ? byId.get(layer.parentId) : null;
    }
    return chain.reduce(multiplyMatrix, [...IDENTITY]);
}
export function bounds(value, label = 'localBounds') {
    obj(value, label);
    fields(value, ['x', 'y', 'width', 'height'], label);
    fail(['x', 'y', 'width', 'height'].every(k => finite(value[k])) && value.width >= 0 && value.height >= 0, `invalid ${label}`);
    return clone(value);
}
function metadata(v) {
    if (v === undefined)
        return;
    obj(v, 'metadata');
    fail(canonical(v).length <= 2000000, 'metadata too large');
    const walk = (x, depth = 0) => {
        fail(depth <= 64, 'metadata nesting exceeds limit');
        if (!x || typeof x !== 'object')
            return;
        for (const [k, v] of Object.entries(x)) {
            fail(!['paths', 'paragraphs', 'runs', 'tiles', 'pixels', 'shader', 'script'].includes(k), 'drawing content belongs in immutable content assets');
            walk(v, depth + 1);
        }
    };
    walk(v);
    return clone(v);
}
export function normalizeContentDescriptor(v) {
    obj(v, 'content descriptor');
    fields(v, ['id', 'kind', 'assetId', 'formatVersion'], 'content descriptor');
    fail(validId(v.id) && validId(v.assetId), 'invalid content identity');
    fail(['raster', 'svg', 'vector', 'text', 'preservedText', 'tiles'].includes(v.kind), 'invalid content kind');
    fail(v.formatVersion === 1, 'unsupported content format version', 422, 'CONTENT_FORMAT_UNSUPPORTED');
    return clone(v);
}
export function normalizeMask(v) {
    obj(v, 'mask');
    fields(v, ['id', 'kind', 'contentId', 'channel', 'coordinateSpace', 'matrix', 'linked', 'enabled', 'inverted', 'density', 'featherPx'], 'mask');
    const out = { channel: 'alpha', coordinateSpace: 'layerLocal', matrix: [...IDENTITY], linked: true, enabled: true, inverted: false, density: 1, featherPx: 0, ...clone(v) };
    fail(validId(out.id) && validId(out.contentId) && ['raster', 'vector'].includes(out.kind), 'invalid mask identity');
    fail(['alpha', 'luminance'].includes(out.channel) && ['layerLocal', 'document'].includes(out.coordinateSpace), 'invalid mask coordinates');
    out.matrix = matrix(out.matrix);
    for (const k of ['linked', 'enabled', 'inverted'])
        fail(typeof out[k] === 'boolean', `invalid mask ${k}`);
    fail(finite(out.density) && out.density >= 0 && out.density <= 1 && finite(out.featherPx) && out.featherPx >= 0 && out.featherPx <= 256, 'invalid mask density or feather');
    return out;
}
export function normalizeEffect(v) {
    obj(v, 'effect'); fields(v, ['id','type','enabled','params'], 'effect');
    const effect={enabled:true,...clone(v)};
    fail(validId(effect.id)&&typeof effect.enabled==='boolean','invalid effect identity');
    obj(effect.params,'effect params');
    if(effect.type==='colorMatrix'){fields(effect.params,['matrix'],'color matrix');fail(Array.isArray(effect.params.matrix)&&effect.params.matrix.length===20&&effect.params.matrix.every(finite),'color matrix requires 20 finite values');}
    else if(effect.type==='gaussianBlur'){fields(effect.params,['sigma'],'blur');fail(finite(effect.params.sigma)&&effect.params.sigma>=0&&effect.params.sigma<=256,'invalid gaussian blur sigma');}
    else fail(false,'图层效果尚不可用，请保留原内容',422,'unsupported_feature');
    return effect;
}
const LAYER_KEYS = ['id', 'type', 'name', 'parentId', 'z', 'visible', 'locked', 'opacity', 'contentId', 'localBounds', 'matrix', 'blendMode', 'compositeMode', 'clipToLayerId', 'masks', 'effects', 'metadata'];
export function normalizeV3Layer(v) {
    obj(v, 'layer');
    fields(v, LAYER_KEYS, 'layer');
    const out = { name: v.type || 'Layer', z: 0, visible: true, locked: false, opacity: 1, localBounds: { x: 0, y: 0, width: 1, height: 1 }, matrix: [...IDENTITY], blendMode: 'normal', compositeMode: 'isolated', masks: [], effects: [], ...clone(v) };
    fail(validId(out.id) && ['raster', 'vector', 'text', 'group', 'mask', 'adjustment'].includes(out.type), 'invalid layer identity');
    fail(boundedString(out.name) && finite(out.z) && typeof out.visible === 'boolean' && typeof out.locked === 'boolean', 'invalid layer properties');
    fail(finite(out.opacity) && out.opacity >= 0 && out.opacity <= 1, 'invalid layer opacity');
    out.localBounds = bounds(out.localBounds);
    out.matrix = matrix(out.matrix);
    for (const k of ['parentId', 'contentId', 'clipToLayerId'])
        optionalId(out[k], k);
    fail(['normal','multiply','screen','overlay','darken','lighten','difference','exclusion'].includes(out.blendMode), '混合模式尚不可用', 422, 'unsupported_feature');
    fail(['isolated', 'passthrough'].includes(out.compositeMode), 'invalid group composite mode');
    fail(out.type === 'group' || out.compositeMode === 'isolated', 'passthrough is only valid for groups');
    fail(Array.isArray(out.effects)&&out.effects.length<=100,'invalid layer effects');
    out.effects=out.effects.map(normalizeEffect);
    fail(new Set(out.effects.map(e=>e.id)).size===out.effects.length,'duplicate effect identity');
    const enabledEffects=out.effects.filter(e=>e.enabled);
    fail(new Set(enabledEffects.map(e=>e.type)).size===enabledEffects.length,'同种效果叠加尚不可用',422,'unsupported_feature');
    fail(out.type !== 'adjustment', '调整图层尚不可用', 422, 'unsupported_feature');
    fail(Array.isArray(out.masks) && out.masks.length <= 100, 'invalid layer masks');
    out.masks = out.masks.map(normalizeMask);
    fail(new Set(out.masks.map(m => m.id)).size === out.masks.length, 'duplicate mask identity');
    if(out.compositeMode==='passthrough')fail(out.opacity===1&&out.blendMode==='normal'&&!enabledEffects.length&&!out.masks.some(m=>m.enabled),'穿透组上的透明度、效果或蒙版尚不可用',422,'unsupported_feature');
    if (out.type === 'group')
        fail(out.contentId === undefined, 'group cannot own drawing content');
    else
        fail(validId(out.contentId), 'drawing layer requires contentId');
    if (out.metadata !== undefined)
        out.metadata = metadata(out.metadata);
    return out;
}
export function normalizeSelection(v) {
    obj(v, 'selection');
    fields(v, ['id', 'name', 'contentId', 'matrix', 'channel', 'inverted', 'density', 'featherPx'], 'selection');
    const out = { name: 'Selection', matrix: [...IDENTITY], channel: 'alpha', inverted: false, density: 1, featherPx: 0, ...clone(v) };
    fail(validId(out.id) && validId(out.contentId) && boundedString(out.name), 'invalid selection');
    out.matrix = matrix(out.matrix);
    fail(['alpha', 'luminance'].includes(out.channel) && typeof out.inverted === 'boolean' && finite(out.density) && out.density >= 0 && out.density <= 1 && finite(out.featherPx) && out.featherPx >= 0 && out.featherPx <= 256, 'invalid selection settings');
    return out;
}
export function normalizeArtboard(v) {
    obj(v, 'artboard');
    fields(v, ['id', 'name', 'bounds', 'background', 'visible'], 'artboard');
    const out = { name: 'Artboard', visible: true, ...clone(v) };
    fail(validId(out.id) && boundedString(out.name) && typeof out.visible === 'boolean', 'invalid artboard');
    out.bounds = bounds(out.bounds, 'artboard bounds');
    fail(out.bounds.width > 0 && out.bounds.height > 0, 'artboard must have positive dimensions');
    if (out.background !== undefined)
        fail(boundedString(out.background, 100) && !/(?:url|var)\s*\(/i.test(out.background), 'invalid artboard background');
    return out;
}
export function normalizeGuide(v) {
    obj(v, 'guide');
    fields(v, ['id', 'axis', 'position', 'locked', 'visible', 'artboardId'], 'guide');
    const out = { locked: false, visible: true, ...clone(v) };
    fail(validId(out.id) && ['x', 'y'].includes(out.axis) && finite(out.position) && typeof out.locked === 'boolean' && typeof out.visible === 'boolean', 'invalid guide');
    optionalId(out.artboardId, 'artboardId');
    return out;
}
export function validateV3Document(d) {
    obj(d, 'document');
    fail(d.schemaVersion === 3 && validId(d.id) && boundedString(d.name), 'invalid document identity');
    fail(Number.isSafeInteger(d.revision) && d.revision >= 0, 'invalid document revision');
    fail([d.width, d.height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 32768) && d.width * d.height <= 100000000, 'invalid document dimensions');
    obj(d.resolution, 'resolution');
    fields(d.resolution, ['dpiX', 'dpiY', 'unit'], 'resolution');
    fail([d.resolution.dpiX, d.resolution.dpiY].every(n => finite(n) && n > 0 && n <= 9600) && ['px', 'mm', 'in'].includes(d.resolution.unit), 'invalid resolution');
    fail(canonical(d.workingColor) === canonical({ space: 'srgb', bitDepth: 8, alphaEncoding: 'straight' }), 'unsupported working color', 422, 'unsupported_feature');
    fail(d.renderVersion === 'weiai-rg-1', 'unsupported render version', 422, 'unsupported_feature');
    fail(Array.isArray(d.requiredFeatures) && d.requiredFeatures.every(f => V3_FEATURES.includes(f)) && new Set(d.requiredFeatures).size === d.requiredFeatures.length, 'unsupported required feature', 422, 'unsupported_feature');
    for (const [k, max] of [['layers', 10000], ['assetIds', 50000], ['contentAssets', 50000], ['artboards', 1000], ['guides', 10000], ['savedSelections', 1000]])
        fail(Array.isArray(d[k]) && d[k].length <= max, `invalid document ${k}`);
    fail(d.assetIds.every(validId) && new Set(d.assetIds).size === d.assetIds.length, 'invalid asset registry');
    d.layers = d.layers.map(normalizeV3Layer);
    d.contentAssets = d.contentAssets.map(normalizeContentDescriptor);
    d.artboards = d.artboards.map(normalizeArtboard);
    d.guides = d.guides.map(normalizeGuide);
    d.savedSelections = d.savedSelections.map(normalizeSelection);
    for (const k of ['layers', 'contentAssets', 'artboards', 'guides', 'savedSelections'])
        fail(new Set(d[k].map(v => v.id)).size === d[k].length, `duplicate ${k} identity`);
    const layers = new Map(d.layers.map(l => [l.id, l])), contents = new Map(d.contentAssets.map(c => [c.id, c]));
    for (const c of contents.values())
        fail(d.assetIds.includes(c.assetId), 'content asset is not registered');
    const hasContent = id => fail(contents.has(id), 'content reference is not registered');
    const maskContent = m => {
        hasContent(m.contentId);
        fail(m.kind === 'raster' ? contents.get(m.contentId).kind === 'raster' : ['svg', 'vector'].includes(contents.get(m.contentId).kind), 'mask content kind does not match');
    };
    for (const l of d.layers) {
        if (l.contentId) {
            hasContent(l.contentId);
            const kind = contents.get(l.contentId).kind;
            fail(l.type === 'raster' ? ['raster', 'tiles'].includes(kind) : l.type === 'vector' ? ['svg', 'vector'].includes(kind) : l.type === 'text' ? ['text', 'preservedText'].includes(kind) : true, 'layer content kind does not match');
        }
        l.masks.forEach(maskContent);
        const seen = new Set([l.id]);
        let current = l;
        while (current.parentId) {
            fail(!seen.has(current.parentId), 'cyclic layer groups');
            const p = layers.get(current.parentId);
            fail(p?.type === 'group', 'layer parent must be a group');
            seen.add(p.id);
            current = p;
        }
        if (l.clipToLayerId) {
            const clip = layers.get(l.clipToLayerId);
            fail(clip && clip.id !== l.id && clip.parentId === l.parentId && clip.z < l.z, 'clipping base must be a lower sibling layer');
        }
    }
    for (const s of d.savedSelections) {
        hasContent(s.contentId);
        fail(['raster', 'svg', 'vector'].includes(contents.get(s.contentId).kind), 'selection requires mask-compatible content');
    }
    for (const g of d.guides)
        if (g.artboardId)
            fail(d.artboards.some(a => a.id === g.artboardId), 'guide artboard not found');
    if (d.metadata !== undefined)
        d.metadata = metadata(d.metadata);
    const required = new Set(d.requiredFeatures);
    for(const f of ['matrix','content-assets'])required.add(f);
    if(d.layers.some(l=>l.masks.length))required.add('layer-masks');
    if(d.layers.some(l=>l.blendMode!=='normal'))required.add('blend-modes');
    if(d.layers.some(l=>l.effects.length))required.add('layer-effects');
    if(d.layers.some(l=>l.clipToLayerId))required.add('clipping');
    if(d.layers.some(l=>l.compositeMode==='passthrough'))required.add('passthrough-groups');
    for(const [key,feature]of [['artboards','artboards'],['guides','guides'],['savedSelections','saved-selections']])if(d[key].length)required.add(feature);
    d.requiredFeatures=[...required];
    return d;
}
export function createV3Document(body = {}) {
    const now = timestamp();
    return validateV3Document({ id: randomUUID(), schemaVersion: 3, revision: 0, name: body.name || 'Untitled', width: body.width ?? 1024, height: body.height ?? 1024, assetIds: clone(body.assetIds || []), layers: clone(body.layers || []), contentAssets: clone(body.contentAssets || []), artboards: clone(body.artboards || []), guides: clone(body.guides || []), savedSelections: clone(body.savedSelections || []), resolution: clone(body.resolution || { dpiX: 300, dpiY: 300, unit: 'px' }), workingColor: clone(body.workingColor || { space: 'srgb', bitDepth: 8, alphaEncoding: 'straight' }), renderVersion: body.renderVersion || 'weiai-rg-1', requiredFeatures: clone(body.requiredFeatures || ['matrix', 'content-assets']), createdAt: now, updatedAt: now, ...(body.metadata === undefined ? {} : { metadata: clone(body.metadata) }) });
}
export function applyV3Commands(document, commands) {
    fail(Array.isArray(commands) && commands.length > 0 && commands.length <= 1000, 'commands must be a nonempty list');
    const out = clone(document);
    const get = id => {
        const l = out.layers.find(l => l.id === id);
        fail(l, 'layer not found', 404);
        return l;
    };
    const locked = l => {
        const seen = new Set();
        while (l) {
            fail(!seen.has(l.id), 'cyclic layer groups');
            seen.add(l.id);
            if (l.locked)
                return true;
            l = out.layers.find(p => p.id === l.parentId);
        }
        return false;
    };
    const mutable = id => {
        const l = get(id);
        fail(!locked(l), 'locked layer cannot be changed', 409, 'layer_locked');
        return l;
    };
    const update = (list, value) => {
        const i = list.findIndex(v => v.id === value.id);
        if (i < 0)
            list.push(value);
        else
            list[i] = value;
    };
    for (const c of commands) {
        obj(c, 'command');
        fail(typeof c.type === 'string', 'command type is required');
        const geometryBefore = ['layer.update','layer.transformWorld'].includes(c.type) ? clone(out) : null;
        if (c.type === 'content.add') {
            const content = normalizeContentDescriptor(c.content);
            const old = out.contentAssets.find(v => v.id === content.id);
            fail(!old || canonical(old) === canonical(content), 'content identity is immutable', 409, 'content_identity_conflict');
            if (!old)
                out.contentAssets.push(content);
        }
        else if (c.type === 'layer.add') {
            const l = normalizeV3Layer(c.layer);
            fail(!out.layers.some(v => v.id === l.id), 'layer already exists', 409);
            if (l.parentId)
                fail(!locked(get(l.parentId)), 'locked layer group cannot be changed', 409, 'layer_locked');
            out.layers.push(l);
        }
        else if (c.type === 'layer.update') {
            const l = get(c.layerId);
            obj(c.patch, 'patch');
            const unlock = Object.keys(c.patch).length === 1 && c.patch.locked === false && l.locked && !locked(out.layers.find(p => p.id === l.parentId));
            fail(!locked(l) || unlock, 'locked layer cannot be changed', 409, 'layer_locked');
            fail(!('id' in c.patch) && !('type' in c.patch), 'layer identity and type are immutable');
            if (c.patch.parentId)
                fail(!locked(get(c.patch.parentId)), 'locked layer group cannot be changed', 409, 'layer_locked');
            Object.assign(l, clone(c.patch));
            for (const k of ['parentId', 'clipToLayerId', 'metadata'])
                if (l[k] === null)
                    delete l[k];
        }
        else if (c.type === 'layer.content') {
            mutable(c.layerId).contentId = c.contentId;
            if (c.localBounds !== undefined)
                mutable(c.layerId).localBounds = bounds(c.localBounds);
        }
        else if (c.type === 'layer.transformWorld') {
            fail(Array.isArray(c.layerIds) && c.layerIds.length > 0 && new Set(c.layerIds).size === c.layerIds.length, 'invalid transform selection');
            const delta = matrix(c.deltaWorld), snapshot = clone(out), selected = new Set(c.layerIds);
            for (const id of selected) {
                const l = mutable(id);
                let ancestor = l.parentId;
                let selectedParent = false;
                while (ancestor) {
                    if (selected.has(ancestor))
                        selectedParent = true;
                    ancestor = get(ancestor).parentId;
                }
                if (selectedParent)
                    continue;
                const parent = l.parentId ? worldMatrix(snapshot, l.parentId) : [...IDENTITY];
                l.matrix = multiplyMatrix(inverseMatrix(parent), multiplyMatrix(delta, worldMatrix(snapshot, id)));
            }

        }
        else if (c.type === 'layer.remove') {
            mutable(c.layerId);
            const removed = new Set([c.layerId]);
            let count;
            do {
                count = removed.size;
                for (const l of out.layers)
                    if (removed.has(l.parentId))
                        removed.add(l.id);
            } while (count !== removed.size);
            fail(!out.layers.some(l => removed.has(l.id) && locked(l)), 'locked layer cannot be removed', 409, 'layer_locked');
            out.layers = out.layers.filter(l => !removed.has(l.id));
        }
        else if (c.type === 'layer.reorder') {
            fail(Array.isArray(c.layerIds) && c.layerIds.length === out.layers.length && new Set(c.layerIds).size === out.layers.length, 'reorder must include each layer once');
            const old = new Map(out.layers.map(l => [l.id, l]));
            out.layers = c.layerIds.map((id, z) => {
                fail(old.has(id), 'reordered layer not found');
                const l = old.get(id);
                fail(!locked(l) || l.z === z, 'locked layer cannot be reordered', 409, 'layer_locked');
                return { ...l, z };
            });
        }
        else if (c.type.startsWith('mask.')) {
            const l = mutable(c.layerId);
            if (c.type === 'mask.upsert')
                update(l.masks, normalizeMask(c.mask));
            else if (c.type === 'mask.remove') {
                fail(l.masks.some(m => m.id === c.maskId), 'mask not found', 404);
                l.masks = l.masks.filter(m => m.id !== c.maskId);
            }
            else if (c.type === 'mask.reorder') {
                fail(Array.isArray(c.maskIds) && c.maskIds.length === l.masks.length && new Set(c.maskIds).size === l.masks.length && c.maskIds.every(id => l.masks.some(m => m.id === id)), 'mask reorder must include each mask once');
                const byId = new Map(l.masks.map(m => [m.id, m]));
                l.masks = c.maskIds.map(id => byId.get(id));
            }
            else
                fail(false, 'unsupported command');
        }
        else if (/^(selection|artboard|guide)\.(upsert|remove)$/.test(c.type)) {
            const [kind, action] = c.type.split('.'), field = { selection: 'savedSelections', artboard: 'artboards', guide: 'guides' }[kind];
            if (action === 'upsert') {
                const v = { selection: normalizeSelection, artboard: normalizeArtboard, guide: normalizeGuide }[kind](c[kind]);
                const old = out[field].find(x => x.id === v.id);
                if (kind === 'guide' && old?.locked)
                    fail(canonical(old) === canonical(v) || canonical({ ...old, locked: false }) === canonical(v), 'locked guide cannot be changed', 409, 'guide_locked');
                update(out[field], v);
            }
            else {
                const id = c[`${kind}Id`];
                fail(out[field].some(v => v.id === id), `${kind} not found`, 404);
                if (kind === 'guide')
                    fail(!out[field].find(v => v.id === id).locked, 'locked guide cannot be removed', 409, 'guide_locked');
                out[field] = out[field].filter(v => v.id !== id);
            }
        }
        else if (c.type === 'document.update') {
            obj(c.patch, 'document patch');
            fields(c.patch, ['name', 'width', 'height', 'resolution', 'metadata'], 'document patch');
            Object.assign(out, clone(c.patch));
        }
        else
            fail(false, 'unsupported command');
        if(geometryBefore) preserveMaskLinkage(geometryBefore,out);
    }
    return validateV3Document(out);
}
function preserveMaskLinkage(before, after) {
    const oldLayers=new Map(before.layers.map(layer=>[layer.id,layer]));
    for(const layer of after.layers) {
        if(!layer.masks.length||!oldLayers.has(layer.id))continue;
        const oldWorld=worldMatrix(before,layer.id),newWorld=worldMatrix(after,layer.id);
        if(canonical(oldWorld)===canonical(newWorld))continue;
        const oldMasks=new Map(oldLayers.get(layer.id).masks.map(mask=>[mask.id,mask]));
        for(const mask of layer.masks) {
            const old=oldMasks.get(mask.id);
            // A mask's independently authored matrix/space takes precedence.
            if(!old||canonical(old.matrix)!==canonical(mask.matrix)||old.coordinateSpace!==mask.coordinateSpace)continue;
            if(!mask.linked&&mask.coordinateSpace==='layerLocal')mask.matrix=multiplyMatrix(multiplyMatrix(inverseMatrix(newWorld),oldWorld),mask.matrix);
            else if(mask.linked&&mask.coordinateSpace==='document')mask.matrix=multiplyMatrix(multiplyMatrix(newWorld,inverseMatrix(oldWorld)),mask.matrix);
        }
    }
}
function validatePathData(data) {
    const tokens = data.match(/[MmZzLlHhVvCcSsQqTtAa]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g) || [];
    fail(tokens.length > 0 && /^[Mm]$/.test(tokens[0]) && data.replace(/[MmZzLlHhVvCcSsQqTtAa]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g, '').replace(/[\s,]/g, '') === '', 'invalid SVG path grammar');
    const arity = {m:2,l:2,h:1,v:1,c:6,s:4,q:4,t:2,a:7,z:0};
    for (let i=0;i<tokens.length;) {
        const command=tokens[i++];
        fail(/^[MmZzLlHhVvCcSsQqTtAa]$/.test(command), 'SVG path command is required');
        const count=arity[command.toLowerCase()];
        let groups=0;
        while(i<tokens.length&&!/^[MmZzLlHhVvCcSsQqTtAa]$/.test(tokens[i])) {
            fail(count>0&&i+count<=tokens.length, 'incomplete SVG path coordinates');
            const args=tokens.slice(i,i+count).map(Number);
            fail(args.every(finite),'invalid SVG path coordinates');
            if(command.toLowerCase()==='a')fail(args[0]>=0&&args[1]>=0&&[0,1].includes(args[3])&&[0,1].includes(args[4]),'invalid SVG arc parameters');
            i+=count;groups++;
        }
        fail(count===0||groups>0, 'SVG path coordinates are required');
    }
}
const literalPaint = v => typeof v==='string' && /^(?:#[0-9a-f]{6}(?:[0-9a-f]{2})?|black|white|transparent|none)$/i.test(v);
const paint = v => boundedString(v, 500) && !/(?:url|var)\s*\(|javascript|https?:|data:/i.test(v);
export function validateContentJSON(value) {
    obj(value, 'content JSON');
    fail(value.formatVersion === 1 && ['svg', 'vector', 'text', 'preservedText', 'tiles'].includes(value.kind), 'unsupported content JSON format', 422, 'CONTENT_FORMAT_UNSUPPORTED');
    const visit = (v, depth = 0) => {
        fail(depth <= 64, 'content nesting exceeds limit');
        if (typeof v === 'number')
            fail(Number.isFinite(v), 'content contains nonfinite number');
        if (!v || typeof v !== 'object')
            return;
        for (const [k, x] of Object.entries(v)) {
            fail(!['__proto__', 'prototype', 'constructor', 'script', 'shader', 'url', 'href'].includes(k), 'unsafe content property');
            visit(x, depth + 1);
        }
    };
    visit(value);
    if (value.kind === 'svg') {
        fields(value, ['formatVersion', 'kind', 'sourceAssetId', 'fontAssetIds', 'fill', 'pathStyles', 'appearanceAssetId'], 'SVG content');
        fail(validId(value.sourceAssetId) && Array.isArray(value.fontAssetIds) && value.fontAssetIds.length <= 32 && value.fontAssetIds.every(validId), 'invalid SVG content references');
        optionalId(value.appearanceAssetId, 'appearanceAssetId');
        if (value.fill !== undefined)
            fail(paint(value.fill), 'invalid SVG fill');
        if (value.pathStyles !== undefined) {
            obj(value.pathStyles, 'SVG path styles');
            fail(Object.keys(value.pathStyles).length <= 100000, 'too many SVG path styles');
            for (const [id, style] of Object.entries(value.pathStyles)) {
                fail(boundedString(id, 500) && id.length > 0, 'invalid SVG drawing identity');
                obj(style, 'path style');
                fields(style, ['fill', 'stroke', 'strokeWidth'], 'path style');
                for (const k of ['fill', 'stroke'])
                    if (style[k] !== undefined)
                        fail(paint(style[k]), 'invalid SVG path paint');
                if (style.strokeWidth !== undefined)
                    fail(finite(style.strokeWidth) && style.strokeWidth >= 0, 'invalid SVG path stroke width');
                if (style.opacity !== undefined)
                    fail(finite(style.opacity) && style.opacity >= 0 && style.opacity <= 1, 'invalid SVG path opacity');
            }
        }
    }
    else if (value.kind === 'vector') {
        fields(value, ['formatVersion', 'kind', 'paths', 'resources', 'viewBox'], 'vector content');
        if (value.viewBox !== undefined)
            fail(Array.isArray(value.viewBox) && value.viewBox.length === 4 && value.viewBox.every(finite) && value.viewBox[2] > 0 && value.viewBox[3] > 0, 'invalid vector viewBox');
        fail(Array.isArray(value.paths) && value.paths.length <= 100000, 'invalid vector paths');
        const ids = new Set();
        for (const p of value.paths) {
            obj(p, 'path');
            fields(p, ['id', 'd', 'fill', 'stroke', 'strokeWidth', 'fillRule', 'matrix'], 'path');
            fail(validId(p.id) && !ids.has(p.id) && boundedString(p.d, 4000000) && p.d.length > 0 && !/[^MmZzLlHhVvCcSsQqTtAa0-9+\-.,\seE]/.test(p.d), 'invalid SVG path data');
            validatePathData(p.d);
            ids.add(p.id);
            for (const k of ['fill', 'stroke'])
                if (p[k] !== undefined)
                    fail(literalPaint(p[k]), `invalid path ${k}`);
            if (p.strokeWidth !== undefined)
                fail(finite(p.strokeWidth) && p.strokeWidth >= 0, 'invalid path stroke width');
            if (p.fillRule !== undefined)
                fail(['nonzero', 'evenodd'].includes(p.fillRule), 'invalid path fill rule');
            if (p.matrix !== undefined)
                matrix(p.matrix);
            if (p.opacity !== undefined)
                fail(finite(p.opacity) && p.opacity >= 0 && p.opacity <= 1, 'invalid path opacity');
        }
        if (value.resources !== undefined) {
            fail(Array.isArray(value.resources) && value.resources.length === 0, 'invalid vector resources');
            for (const r of value.resources) {
                obj(r, 'resource');
                fields(r, ['id', 'assetId'], 'resource');
                fail(validId(r.id) && validId(r.assetId), 'invalid resource reference');
            }
            fail(new Set(value.resources.map(r => r.id)).size === value.resources.length, 'duplicate resource identity');
        }
    }
    else if (value.kind === 'text') {
        fields(value, ['formatVersion', 'kind', 'text', 'fontAssetId', 'fontFamily', 'fontWeight', 'fontSize', 'fill', 'stroke', 'strokeWidth', 'tracking', 'lineHeight', 'align', 'locale', 'mode'], 'text content');
        fail(value.mode===undefined||value.mode==='legacy-lines','paragraph layout mode is unavailable',422,'unsupported_feature');
        fail(boundedString(value.text, 100000) && validId(value.fontAssetId), 'text requires actual font asset and text');
        fail(finite(value.fontSize) && value.fontSize > 0 && value.fontSize <= 32768, 'invalid text font size');
        for (const k of ['fill', 'stroke'])
            if (value[k] !== undefined)
                fail(literalPaint(value[k]), `invalid text ${k}`);
        for (const k of ['strokeWidth', 'tracking', 'lineHeight'])
            if (value[k] !== undefined)
                fail(finite(value[k]) && (k === 'tracking' || value[k] >= 0), 'invalid text metrics');
        if (value.lineHeight !== undefined)
            fail(value.lineHeight > 0, 'invalid line height');
        if (value.fontFamily !== undefined)
            fail(boundedString(value.fontFamily), 'invalid font family');
        if (value.fontWeight !== undefined)
            fail(finite(value.fontWeight) && value.fontWeight >= 1 && value.fontWeight <= 1000, 'invalid font weight');
        if (value.align !== undefined)
            fail(value.align === 'left', 'invalid text alignment');
        if (value.locale !== undefined)
            fail(boundedString(value.locale, 100), 'invalid text locale');
    }
    else if (value.kind === 'preservedText') {
        fields(value, ['formatVersion', 'kind', 'assetId', 'text', 'desiredText', 'fontStatus', 'sourceRect', 'originalStyle', 'status'], 'preserved text content');
        fail(boundedString(value.text, 100000) && value.fontStatus === 'unknown', 'invalid preserved text');
        optionalId(value.assetId, 'preserved text assetId');
        if (value.desiredText !== undefined)
            fail(boundedString(value.desiredText, 100000), 'invalid desired text');
        if (value.sourceRect !== undefined)
            bounds(value.sourceRect, 'sourceRect');
        if (value.status !== undefined)
            fail(['preserved', 'unavailable'].includes(value.status), 'invalid preserved text status');
        fail(value.status !== 'preserved' || validId(value.assetId), 'preserved text requires original pixels');
        if (value.originalStyle !== undefined) {
            obj(value.originalStyle, 'original text style');
            fields(value.originalStyle, ['fontFamily', 'fontSize', 'fontWeight', 'fill', 'stroke', 'strokeWidth', 'tracking', 'lineHeight'], 'original text style');
            for (const k of ['fill', 'stroke'])
                if (value.originalStyle[k] !== undefined)
                    fail(paint(value.originalStyle[k]), 'invalid original paint');
        }
    }
    else {
        fail(false, '瓦片内容尚不可用', 422, 'unsupported_feature');

    }
    return value;
}
export function contentAssetReferences(value) {
    const refs = [];
    const walk = v => {
        if (!v || typeof v !== 'object')
            return;
        for (const [k, x] of Object.entries(v)) {
            if (['assetId', 'fontAssetId', 'sourceAssetId', 'appearanceAssetId'].includes(k)) {
                fail(validId(x), `invalid recursive ${k}`);
                refs.push({ assetId: x, role: k === 'fontAssetId' ? 'font' : 'resource' });
            }
            else if (k === 'fontAssetIds') {
                fail(Array.isArray(x) && x.every(validId), 'invalid recursive fonts');
                for (const id of x)
                    refs.push({ assetId: id, role: 'font' });
            }
            else
                walk(x);
        }
    };
    walk(value);
    return refs;
}
