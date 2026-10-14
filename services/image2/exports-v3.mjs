import { randomUUID, createHash } from 'node:crypto';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import PDFDocument from 'pdfkit';
import { renderNode } from './render-node.mjs';
import { CONTENT_MIME, validateContentJSON, contentAssetReferences } from './domain-v3.mjs';
import { validateDocument, validId, clone } from './domain.mjs';
import { inspectAsset } from './processors.mjs';
import { craftPackageAssetIds, prepareCraftPackage, installCraftPackage, isCraftOpaqueAsset, craftImportMetadataRef } from './craft-package.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (ok, message) => {
    if (!ok)
        throw Object.assign(new Error(message), { status: 422, code: 'V3_EXPORT_INVALID', retryable: false });
};
const MAX_ARCHIVE = 64 * 1024 * 1024, MAX_EXPANDED = 128 * 1024 * 1024;
export function validateV3Export(document, options = {}) {
    if (options.layerIds !== undefined)
        fail(Array.isArray(options.layerIds) && options.layerIds.length > 0 && new Set(options.layerIds).size === options.layerIds.length && options.layerIds.every(id => document.layers.some(layer => layer.id === id)), '导出图层不存在。');
    if (options.bounds)
        fail(['x', 'y', 'width', 'height'].every(key => typeof options.bounds[key] === 'number' && Number.isFinite(options.bounds[key]) && Math.abs(options.bounds[key]) <= 1e7) && options.bounds.width > 0 && options.bounds.height > 0 && options.bounds.width <= 32768 && options.bounds.height <= 32768 && Math.ceil(options.bounds.width) * Math.ceil(options.bounds.height) <= 40000000, '导出范围无效或过大。');
}
export async function exportV3Document(format, document, ctx) {
    validateV3Export(document, ctx);
    const name = (document.name || '设计工程').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 100);
    if (format === 'project') {
        const docs = [document, ...(ctx.revisions || []).map(revision => revision.document || revision.snapshot || revision)], ids = new Set([...docs.flatMap(d => d.assetIds),...craftPackageAssetIds(ctx.craft)]), direct = new Set(craftPackageAssetIds(ctx.craft)), files = {}, assets = [];
        let size = 0;
        // Automatically saved exports do not recursively enlarge the next package.
        const references = value => {
            if (!value || typeof value !== 'object')
                return;
            for (const [key, child] of Object.entries(value)) {
                if (/^(?:assetId|[a-zA-Z]+AssetId)$/.test(key) && typeof child === 'string')
                    direct.add(child);
                else
                    references(child);
            }
        };
        for (const doc of docs) {
            references(doc.layers);
            references(doc.contentAssets);
            references(doc.metadata);
        }
        const records = new Map();
        async function add(id) {
            if (records.has(id))
                return;
            fail(ids.has(id), '工程素材引用不在冻结版本中。');
            const record = await ctx.getAsset(id);
            fail(record.asset.id === id && (!record.asset.hash || record.asset.hash === sha(record.bytes)), '工程素材身份或hash不匹配。');
            records.set(id, record);
            for (const input of record.asset.inputs || []) {
                direct.add(input.assetId);
                await add(input.assetId);
            }
            if (record.asset.mime === CONTENT_MIME) {
                const value = validateContentJSON(JSON.parse(record.bytes.toString('utf8')));
                for (const ref of contentAssetReferences(value)) {
                    direct.add(ref.assetId);
                    await add(ref.assetId);
                }
            }
        }
        for (const id of ids)
            await add(id);
        for (const [id, { asset, bytes }] of records) {
            if (asset.metadata?.role === 'export' && !direct.has(id))
                continue;
            fail(assets.length < 2000 && bytes.length <= MAX_ARCHIVE, '工程素材超过数量或单文件上限。');
            size += bytes.length;
            fail(size <= MAX_EXPANDED, '工程包解压大小超过128MB。');
            const file = `assets/${id}`;
            files[file] = bytes;
            const { documentId: _doc, url: _url, ...descriptor } = asset;
            void _doc;
            void _url;
            assets.push({ ...descriptor, file, hash: sha(bytes) });
        }
        const included = new Set(assets.map(asset => asset.id)), clean = doc => {
            const value = clone(doc);
            value.assetIds = value.assetIds.filter(id => included.has(id));
            delete value.parentDocumentId;
            delete value.baseRevision;
            return value;
        };
        files['manifest.json'] = strToU8(JSON.stringify({ format: 'weiai-image2-project', version: 3, document: clean(document), revisions: docs.slice(1).map(clean), assets,...(ctx.craft?{craft:ctx.craft}:{}) }));
        fail(size + files['manifest.json'].length <= MAX_EXPANDED, '工程包清单及素材超过128MB。');
        const bytes = Buffer.from(zipSync(files, { level: 6, mtime: new Date('2000-01-01T00:00:00Z') }));
        fail(bytes.length <= MAX_ARCHIVE, '工程包超过64MB。');
        return { bytes, mime: 'application/zip', name: `${name}.image2.zip` };
    }
    fail(['png', 'pdf', 'svg'].includes(format), '不支持的导出格式。');
    const rendered = await renderNode(document, ctx.getAsset, ctx);
    if (format === 'png')
        return { bytes: rendered.png, mime: 'image/png', name: `${name}.png` };
    if (format === 'pdf') {
        const dpiX = document.resolution.dpiX, dpiY = document.resolution.dpiY, pageW = rendered.width * 72 / dpiX, pageH = rendered.height * 72 / dpiY;
        const pdf = new PDFDocument({ size: [pageW, pageH], margin: 0 }), chunks = [];
        const completed = new Promise((resolve, reject) => {
            pdf.on('data', chunk => chunks.push(chunk));
            pdf.on('end', () => resolve(Buffer.concat(chunks)));
            pdf.on('error', reject);
        });
        pdf.image(rendered.png, 0, 0, { width: pageW, height: pageH });
        pdf.end();
        return { bytes: await completed, mime: 'application/pdf', name: `${name}.pdf` };
    }
    // Explicit appearance proxy; editable content, fonts and paths remain in the native package.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${rendered.width}" height="${rendered.height}" viewBox="0 0 ${rendered.width} ${rendered.height}"><metadata>Image2 v3 appearance export; editable sources are retained in the native project.</metadata><image width="${rendered.width}" height="${rendered.height}" href="data:image/png;base64,${rendered.png.toString('base64')}"/></svg>`;
    return { bytes: Buffer.from(svg), mime: 'image/svg+xml', name: `${name}.svg` };
}
export function readProjectArchive(input) {
    fail(typeof input?.data === 'string' && input.data.length > 0 && input.data.length <= 96 * 1024 * 1024, '工程包过大或无效。');
    const encoded = input.data.replace(/^data:application\/zip;base64,/, '');
    fail(encoded.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded), '工程包base64无效。');
    const compressed = Buffer.from(encoded, 'base64');
    fail(compressed.length <= MAX_ARCHIVE, '工程包超过64MB。');
    let size = 0, count = 0, rejected = false, files;
    const names = new Set();
    try {
        files = unzipSync(compressed, { filter: file => {
                size += file.originalSize;
                count++;
                const allowed = Number.isSafeInteger(file.originalSize) && file.originalSize > 0 && file.originalSize <= MAX_ARCHIVE && size <= MAX_EXPANDED && count <= 2001 && !names.has(file.name) && /^(manifest\.json|assets\/[a-zA-Z0-9_-]+)$/.test(file.name);
                names.add(file.name);
                if (!allowed)
                    rejected = true;
                return allowed;
            } });
    }
    catch {
        fail(false, '工程包无法安全读取。');
    }
    fail(!rejected && files['manifest.json'], '工程包结构、路径或解压尺寸无效。');
    let manifest;
    try {
        manifest = JSON.parse(strFromU8(files['manifest.json']));
    }
    catch {
        fail(false, '工程清单无效。');
    }
    fail(manifest?.format === 'weiai-image2-project' && [2, 3].includes(manifest.version), '不支持的工程包版本。');
    return { manifest, files };
}
export async function importV3Project(store, owner, input, bundle = readProjectArchive(input)) {
    const { manifest, files } = bundle;
    fail(manifest.version === 3 && manifest.document?.schemaVersion === 3 && Array.isArray(manifest.assets) && manifest.assets.length <= 2000 && Array.isArray(manifest.revisions) && manifest.revisions.length > 0 && manifest.revisions.length <= 10000, 'v3工程清单无效或缺少历史。');
    const craft=await prepareCraftPackage(store,manifest,files);
    const docs = [manifest.document, ...manifest.revisions], ids = new Map(), assets = new Map(), fileNames = new Set(), categories = { layers: new Map(), contentAssets: new Map(), artboards: new Map(), guides: new Map(), savedSelections: new Map(), masks: new Map() }, documentIds = new Map();
    for (const asset of manifest.assets) {
        fail(asset && validId(asset.id) && !assets.has(asset.id) && asset.file === `assets/${asset.id}` && !fileNames.has(asset.file) && /^[a-f0-9]{64}$/.test(asset.hash), '素材身份、路径或hash无效。');
        assets.set(asset.id, asset);
        fileNames.add(asset.file);
        ids.set(asset.id, randomUUID());
    }
    fail(Object.keys(files).every(name => name === 'manifest.json' || fileNames.has(name)), '工程包含清单以外的文件。');
    for (const source of docs) {
        const document = clone(source);
        delete document.kind;
        validateDocument(document);
        fail(document.schemaVersion === 3 && document.id === manifest.document.id && document.assetIds.every(id => assets.has(id)), '历史工程身份或素材登记无效。');
        for (const key of ['layers', 'contentAssets', 'artboards', 'guides', 'savedSelections'])
            for (const value of document[key])
                if (!categories[key].has(value.id))
                    categories[key].set(value.id, randomUUID());
        for (const layer of document.layers)
            for (const mask of layer.masks)
                if (!categories.masks.has(mask.id))
                    categories.masks.set(mask.id, randomUUID());
    }
    const mapRef = (key, value) => {
        const native=craftImportMetadataRef(craft,key,value);if(native!==undefined)return native;
        let map;
        if (/^(?:assetId|[a-zA-Z]+AssetId)s?$/.test(key))
            map = ids;
        else if (/^(?:layerId|[a-zA-Z]+LayerId)s?$/.test(key) || ['parentId', 'clipToLayerId'].includes(key))
            map = categories.layers;
        else if (/^(?:contentId|[a-zA-Z]+ContentId)s?$/.test(key))
            map = categories.contentAssets;
        else if (/^(?:documentId|[a-zA-Z]+DocumentId)s?$/.test(key))
            map = documentIds;
        else if (key === 'artboardId')
            map = categories.artboards;
        return map ? (Array.isArray(value) ? value.map(id => map.get(id) || id) : map.get(value) || value) : undefined;
    };
    const remap = value => Array.isArray(value) ? value.map(remap) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, mapRef(key, child) ?? remap(child)])) : value;
    const remapDocument = value => {
        const doc = remap(value);
        for (const key of ['layers', 'contentAssets', 'artboards', 'guides', 'savedSelections'])
            for (const item of doc[key])
                item.id = categories[key].get(item.id);
        for (const layer of doc.layers)
            for (const mask of layer.masks)
                mask.id = categories.masks.get(mask.id);
        return doc;
    };
    const prepared = [];
    for (const asset of assets.values()) {
        const bytes = Buffer.from(files[asset.file] || []);
        fail(bytes.length > 0 && sha(bytes) === asset.hash, '素材hash不匹配。');
        const dependencies = new Set();
        for (const ref of asset.inputs || []) {
            fail(assets.has(ref.assetId) && (!ref.hash || assets.get(ref.assetId).hash === ref.hash), '素材来源缺失或hash不匹配。');
            dependencies.add(ref.assetId);
        }
        let data = bytes, info;
        if (asset.mime === CONTENT_MIME) {
            let value;
            try {
                value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
            }
            catch {
                fail(false, '内容JSON无效。');
            }
            validateContentJSON(value);
            for (const ref of contentAssetReferences(value)) {
                fail(assets.has(ref.assetId), '递归资源不在工程包中。');
                dependencies.add(ref.assetId);
            }
            data = Buffer.from(JSON.stringify(remap(value)));
            info = { mime: CONTENT_MIME };
        }
        else if(isCraftOpaqueAsset(craft,asset))info={mime:asset.mime,craftOpaque:true};
        else
            info = await inspectAsset(bytes, asset.mime);
        prepared.push({ asset, bytes: data, info, dependencies });
    }
    return store.transaction(() => {
        const fresh = store.createDocument(owner, { schemaVersion: 3, name: input.name || manifest.document.name, width: manifest.document.width, height: manifest.document.height, resolution: manifest.document.resolution });
        documentIds.set(manifest.document.id, fresh.id);
        const remaining = [...prepared], done = new Set();
        while (remaining.length) {
            const index = remaining.findIndex(record => [...record.dependencies].every(id => done.has(id)));
            fail(index >= 0, '素材来源或递归资源形成循环。');
            const record = remaining.splice(index, 1)[0], asset = record.asset;
            // JSON resource IDs change its bytes/hash. Recompute every authoritative
            // provenance hash from the imported immutable source, not the old manifest.
            const descriptor={ name: asset.name, ...record.info, assignedId: ids.get(asset.id), inputs: (asset.inputs || []).map(ref => ({ role: ref.role, assetId: ids.get(ref.assetId) })), metadata: { ...remap(asset.metadata), ...record.info.metadata, importedAssetId: asset.id } };
            if(record.info.craftOpaque)store.craftService.addAsset(fresh.id,owner,descriptor,record.bytes);else store.addAsset(fresh.id,owner,descriptor,record.bytes);
            done.add(asset.id);
        }
        const current = { ...remapDocument(manifest.document), id: fresh.id, createdAt: fresh.createdAt }, revisions = manifest.revisions.map(revision => ({ ...remapDocument(revision), id: fresh.id }));
        const importedCraft=installCraftPackage(store,fresh.id,owner,craft,ids);if(importedCraft)current.metadata={...current.metadata,craftImport:importedCraft};
        for (const document of [current, ...revisions]) {
            delete document.parentDocumentId;
            delete document.baseRevision;
        }
        return store.importRevisions(fresh.id, owner, { revisions, currentDocument: current });
    });
}
