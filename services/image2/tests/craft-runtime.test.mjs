import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createCraftRuntime, resolveCraftArguments, restoreCraftBundle, validateCraftSchema, craftPublicSchema, validateCraftBudgets } from '../craft-runtime.mjs';
import { craftEngines, isCraftCommandSafe, isCraftToolSafe } from '../craft-catalog.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'craft-runtime-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const binDir = path.join(dir, 'bin'); await fs.mkdir(binDir);
  const script = `import { createInterface } from 'node:readline'; import fs from 'node:fs';
let state={count:0};
const tool=(name,properties={},required=[])=>({name,inputSchema:{type:'object',properties,required,additionalProperties:false}});
const tools=[tool('doc_new',{width:{type:'integer'},height:{type:'integer'}}),tool('doc_open',{path:{type:'string'}},['path']),tool('doc_save',{path:{type:'string'}},['path']),tool('doc_inspect'),tool('render_preview',{max_side:{type:'integer'}}),tool('command_list'),tool('command_run',{id:{type:'string'},params:{type:'object'}},['id']),tool('ui_screenshot')];
const commands=[{id:'layer.add',params:'{ amount:number }',inputSchema:{type:'object',properties:{amount:{type:'integer',minimum:1,maximum:10}},additionalProperties:false}},{id:'script.run'},{id:'file.openRecent'},{id:'dialog.pick'},{id:'document.export',inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}}];
function result(value){return {content:[{type:'text',text:JSON.stringify(value)}]};}
for await (const line of createInterface({input:process.stdin})) {const request=JSON.parse(line);if(!request.id)continue; let out;
if(request.method==='initialize')out={protocolVersion:'2025-06-18'};else if(request.method==='tools/list')out={tools};else {const {name,arguments:a}=request.params;if(name==='command_list')out=result(commands);else if(name==='doc_new'){state={count:0};out=result(state);}else if(name==='doc_open'){state=JSON.parse(fs.readFileSync(a.path));out=result(state);}else if(name==='doc_save'){fs.writeFileSync(a.path,JSON.stringify(state));out=result({saved:true});}else if(name==='command_run'){if(a.id==='dialog.pick')out=result({pending:true});else if(a.id==='document.export'){fs.writeFileSync(a.params.path,JSON.stringify(state));out=result({saved:true});}else{state.count+=a.params.amount??1;out=result(state);}}else if(name==='render_preview')out={content:[{type:'image',mimeType:'image/png',data:Buffer.from(JSON.stringify(state)).toString('base64')}]};else out=result(state);}process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:out})+'\\n');}`;
  const file = path.join(binDir, 'photocraft-cli'); await fs.writeFile(file, script);
  const engine = craftEngines().find(item => item.id === 'photocraft');
  await fs.writeFile(path.join(binDir, 'manifest.json'), JSON.stringify({ platform: process.platform, arch: process.arch, engines: [{ id: engine.id, sourceCommit: engine.commit, binary: 'photocraft-cli', sha256: sha(script), bytes: Buffer.byteLength(script) }] }));
  const runtime = createCraftRuntime({ binDir, sandbox: async (binary, _args, { workDir }) => ({ file: process.execPath, args: [binary], env: {}, cwd: workDir }) });
  return { dir, runtime, binDir };
}

test('all 13 pinned engines have persistent protocol mappings', () => {
  const engines = craftEngines(); assert.equal(engines.length, 13); assert.equal(new Set(engines.map(item => item.id)).size, 13);
  for (const engine of engines) { assert.match(engine.commit, /^[a-f\d]{40}$/); assert.ok(engine.library || (engine.open && engine.save && engine.new)); }
});

test('arguments enforce native schema and owned file references', () => {
  const schema = { type: 'object', properties: { width: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['width'], additionalProperties: false };
  validateCraftSchema({ width: 40 }, schema);
  for (const bad of [{}, { width: 0 }, { width: '40' }, { width: 3.5 }, { width: 40, unknown: true }]) assert.throws(() => validateCraftSchema(bad, schema));
  const ctx = { workDir: '/job', inputs: new Map([['owned', '/job/inputs/img.png']]), results: [{ id: 23 }] };
  assert.deepEqual(resolveCraftArguments({ path: { assetId: 'owned' }, layer: { resultRef: '0.id' } }, ctx), { path: '/job/inputs/img.png', layer: 23 });
  assert.equal(resolveCraftArguments({ path: { outputName: 'export.svg' } }, ctx).path, '/job/exports/export.svg');
  for (const args of [{ path: '/etc/passwd' }, { path: { assetId: 'foreign' } }, { path: { outputName: '../out.png' } }, { nested: { fontPath: '/etc/passwd' } }, { url: 'https://example.com' }]) assert.throws(() => resolveCraftArguments(args, ctx));
});

test('runtime filters desktop, script and network commands rather than exposing raw generic execution', () => {
  for (const id of ['script.run', 'plugin.install', 'file.openRecent', 'ui.click', 'data.fromWeb', 'app.openUrl', 'command.batch', 'file.automate.batch', 'file.automate.runDroplet', 'file.scripts.scriptEventsManager']) assert.equal(isCraftCommandSafe(id), false, id);
  assert.equal(isCraftCommandSafe('shape.rectangle'), true);
  assert.equal(isCraftCommandSafe('file.revealInFinder'), false);
  assert.equal(isCraftCommandSafe('layer.smartObjects.revealInFinder'), false);
  assert.equal(isCraftCommandSafe('file.scripts.imageProcessor', '', 'photocraft'), false, 'native automation refuses this CPU command despite supporting it on the desktop');
  assert.equal(isCraftCommandSafe('file.scripts.flattenAllMasks', '', 'photocraft'), true);
  assert.equal(isCraftCommandSafe('file.executeFile', '', 'effectcraft'), false);
  assert.equal(isCraftToolSafe({ name: 'js_run' }, 'pdfcraft'), false);
  assert.equal(isCraftToolSafe({ name: 'ocr_recognize' }, 'pdfcraft'), false);
  assert.equal(isCraftToolSafe({ name: 'ocr_status' }, 'pdfcraft'), true);
  assert.equal(isCraftCommandSafe('ocr.enhance_camera', '', 'pdfcraft'), true);
  assert.equal(isCraftCommandSafe('filter.denoise', 'Traditional denoise', 'photocraft'), true);
  assert.equal(isCraftCommandSafe('denoise.queue', '', 'lightcraft'), false);
  assert.equal(isCraftCommandSafe('mask.refineDetail', '', 'lightcraft'), false);
  assert.equal(isCraftCommandSafe('mask.add', '', 'lightcraft'), true);
  assert.equal(isCraftCommandSafe('faces.nameFaces', '', 'lightcraft'), true);
  assert.equal(isCraftCommandSafe('transcript.set', 'Set transcript', 'filmcraft'), true);
  assert.equal(isCraftCommandSafe('transcript.generate', '', 'filmcraft'), false);
  assert.equal(isCraftCommandSafe('transport.record', '', 'soundcraft'), false);
  assert.equal(isCraftCommandSafe('setup.hardware', '', 'soundcraft'), false);
  assert.equal(isCraftCommandSafe('audio.voiceover.start', '', 'filmcraft'), false);
  assert.equal(isCraftCommandSafe('mixer.recordStart', '', 'filmcraft'), true);
  assert.equal(isCraftCommandSafe('multicam.recordStart', '', 'filmcraft'), true);
  assert.equal(isCraftCommandSafe('file.bounce_mix', '', 'soundcraft'), true);
  assert.equal(isCraftToolSafe({ name: 'command_run' }), false);
  assert.equal(isCraftToolSafe({ name: 'run_script' }), false);
  assert.equal(isCraftToolSafe({ name: 'doc_batch' }), false);
  assert.equal(isCraftToolSafe({ name: 'render_page', description: 'Render page' }), true);
});

test('public file roles survive nested alternatives and referenced schema definitions', () => {
  const original = { type: 'object', properties: { path: { $ref: '#/$defs/FilePath' }, nested: { anyOf: [{ type: 'null' }, { type: 'object', properties: { fontPath: { type: 'string' } } }] } }, $defs: { FilePath: { type: 'string' }, Import: { allOf: [{ properties: { paths: { type: 'array', items: { type: 'string' } } } }] } } };
  const schema = craftPublicSchema(original, 'open_document');
  assert.equal(schema.properties.path['x-craft-role'], 'input-asset');
  assert.equal(schema.properties.nested.anyOf[1].properties.fontPath['x-craft-role'], 'input-asset');
  assert.equal(schema.$defs.Import.allOf[0].properties.paths.items['x-craft-role'], 'input-asset');
  assert.equal(craftPublicSchema({ properties: { path: { type: 'string' } } }, 'save_document').properties.path['x-craft-role'], 'output');
  assert.equal(original.properties.path['x-craft-role'], undefined);
});

test('one process executes ordered edits and native bundle reopens in a new workspace', async t => {
  const { dir, runtime } = await fixture(t);
  const first = await runtime.execute({ engineId: 'photocraft', workDir: path.join(dir, 'job1'), steps: [{ command: 'layer.add', args: { amount: 2 } }, { command: 'layer.add', args: { amount: 3 } }] });
  assert.equal(first.state.count, 5); assert.equal(first.receipt.stepsCompleted, 2); assert.equal(first.receipt.externalModelCalls, 0); assert.equal(first.receipt.processor, 'native-cpu'); assert.ok(first.files.some(file => file.role === 'native'));
  const nativeFile = path.join(dir, 'checkpoint.craftbundle'); await fs.writeFile(nativeFile, first.checkpoint.bytes);
  const second = await runtime.execute({ engineId: 'photocraft', workDir: path.join(dir, 'job2'), nativeFile, steps: [{ command: 'layer.add', args: { amount: 4 } }] });
  assert.equal(second.state.count, 9);
});

test('targeted catalogs deduplicate concurrent native discovery and expose inspect alias', async t => {
  const { dir, runtime } = await fixture(t);
  const [a, b] = await Promise.all([runtime.engineCapability('photocraft'), runtime.capabilities({ engineId: 'photocraft' })]);
  assert.equal(a.available, true); assert.equal(b.length, 1); assert.deepEqual(a, b[0]); assert.equal(a.defaults.inspect, 'doc_inspect');
  const result = await runtime.execute({ engineId: 'photocraft', workDir: path.join(dir, 'inspect'), steps: [{ command: 'inspect', args: {} }] });
  assert.equal(result.result[0].count, 0);
});

test('runtime validates executable hash, blocked nested generic command and cancellation', async t => {
  const { dir, runtime, binDir } = await fixture(t);
  await assert.rejects(runtime.execute({ engineId: 'photocraft', workDir: path.join(dir, 'blocked'), steps: [{ command: 'command_run', args: { id: 'script.run', params: {} } }] }), { code: 'CRAFT_COMMAND_UNAVAILABLE' });
  await assert.rejects(runtime.execute({ engineId: 'photocraft', workDir: path.join(dir, 'domain-schema'), steps: [{ command: 'command_run', args: { id: 'layer.add', params: { amount: 100 } } }] }), { code: 'CRAFT_ARGS_INVALID' });
  await assert.rejects(runtime.execute({ engineId: 'photocraft', workDir: path.join(dir, 'pending-dialog'), steps: [{ command: 'dialog.pick', args: {} }] }), { code: 'CRAFT_INTERACTION_REQUIRED' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runtime.execute({ engineId: 'photocraft', workDir: path.join(dir, 'cancel'), signal: controller.signal, steps: [{ command: 'layer.add', args: {} }] }), { code: 'CRAFT_CANCELLED' });
  const executable = path.join(binDir, 'photocraft-cli'); const originalStat = await fs.stat(executable);
  const original = await fs.readFile(executable, 'utf8'); await fs.writeFile(executable, original.replace('count:0', 'count:9')); await fs.utimes(executable, originalStat.atime, originalStat.mtime);
  await assert.rejects(runtime.execute({ engineId: 'photocraft', workDir: path.join(dir, 'hash'), steps: [{ command: 'layer.add', args: {} }] }), { code: 'CRAFT_BINARY_MISMATCH' });
});

test('runtime rejects a foreign platform manifest before launching', async t => {
  const { dir, runtime, binDir } = await fixture(t);
  const manifestPath = path.join(binDir, 'manifest.json'); const manifest = JSON.parse(await fs.readFile(manifestPath));
  manifest.arch = 'wrong-architecture'; await fs.writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(runtime.execute({ engineId: 'photocraft', workDir: path.join(dir, 'wrong-platform'), steps: [{ command: 'layer.add', args: {} }] }), { code: 'CRAFT_BINARY_MISMATCH' });
});

test('raster job budgets reject oversized renders without limiting vector coordinates or transform scales', () => {
  assert.throws(() => validateCraftBudgets('doc_new', { width: 100000, height: 100000 }), { code: 'CRAFT_RESOURCE_BUDGET' });
  assert.throws(() => validateCraftBudgets('export', { scale: 100 }), { code: 'CRAFT_RESOURCE_BUDGET' });
  assert.throws(() => validateCraftBudgets('comp.new', { width: 8192, height: 8192 }), { code: 'CRAFT_RESOURCE_BUDGET' });
  validateCraftBudgets('shape.rectangle', { x: 100000, width: 20000, height: 10000 });
  validateCraftBudgets('transform.scale', { scale: 100 });
  validateCraftBudgets('render', { width: 4096, height: 4096, scale: 1 });
});

test('checkpoint restores only bounded, hashed safe files and remaps managed native references', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'craft-checkpoint-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'checkpoint'); const destination = path.join(dir, 'restore'); await fs.mkdir(destination);
  const bytes = Buffer.from(JSON.stringify({ source: '/old/inputs/a.png', exportSource: '/old/exports/b.png', text: '/old/inputs/a.png', title: '/old/exports/b.png' }));
  const bundle = { version: 1, engineId: 'photocraft', workDir: '/old', files: [{ path: 'native/document.pcraft', data: bytes.toString('base64'), sha256: sha(bytes) }] };
  await fs.writeFile(file, gzipSync(JSON.stringify(bundle))); await restoreCraftBundle(file, destination, 'photocraft');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(destination, 'native/document.pcraft'))), { source: `${destination}/inputs/a.png`, exportSource: `${destination}/exports/b.png`, text: '/old/inputs/a.png', title: '/old/exports/b.png' });
  bundle.files[0].path = 'native/../../escaped'; await fs.writeFile(file, gzipSync(JSON.stringify(bundle)));
  await assert.rejects(restoreCraftBundle(file, destination, 'photocraft'), { code: 'CRAFT_CHECKPOINT_INVALID' });
});


test('final candidates ignore intermediate previews and do not republish untouched restored exports', async t => {
  const { dir, runtime } = await fixture(t);
  const first = await runtime.execute({ engineId: 'photocraft', workDir: path.join(dir, 'candidate1'), steps: [
    { command: 'preview', args: {} }, { command: 'layer.add', args: { amount: 2 } }, { command: 'document.export', args: { path: { outputName: 'result.json' } } },
  ] });
  const preview = first.files.filter(file => file.role === 'preview');
  assert.equal(preview.length, 1); assert.equal(JSON.parse(preview[0].bytes).count, 2);
  assert.equal(JSON.parse(first.files.find(file => file.role === 'export').bytes).count, 2);
  const nativeFile = path.join(dir, 'candidate.craftbundle'); await fs.writeFile(nativeFile, first.checkpoint.bytes);
  await fs.rm(path.join(dir, 'candidate1'), { recursive: true });
  const second = await runtime.execute({ engineId: 'photocraft', workDir: path.join(dir, 'candidate2'), nativeFile, steps: [{ command: 'layer.add', args: { amount: 4 } }] });
  assert.equal(second.state.count, 6); assert.equal(JSON.parse(second.files.find(file => file.role === 'preview').bytes).count, 6);
  assert.deepEqual(second.files.filter(file => file.role === 'export'), []);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'candidate2/exports/result.json'))).count, 2, 'historical dependency is retained in the private workspace');
  const same = await runtime.execute({ engineId: 'photocraft', workDir: path.join(dir, 'candidate3'), nativeFile, steps: [{ command: 'document.export', args: { path: { outputName: 'result.json' } } }] });
  assert.equal(same.files.filter(file => file.role === 'export').length, 1, 'explicit rewriting of identical export bytes is a current output');
});
