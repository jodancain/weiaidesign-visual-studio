#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareCraftFontInput } from './craft-font-inputs.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(await fs.readFile(path.join(repository, 'services/image2/craft-engines.lock.json'), 'utf8'));
const options = { root: path.join(repository, 'output/artcraft-native'), profile: 'release', jobs: '4', engine: 'all' };
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, '');
  if (!Object.hasOwn(options, key) || !process.argv[i + 1]) throw new Error('Usage: node scripts/build-craft-engines.mjs [--root DIR] [--engine all|ID] [--profile dev|release] [--jobs N]');
  options[key] = process.argv[i + 1];
}
if (!['dev', 'release'].includes(options.profile) || !/^[1-9][0-9]?$/.test(options.jobs)) throw new Error('Invalid build profile or job limit');
const selected = lock.engines.filter(engine => options.engine === 'all' || engine.id === options.engine);
if (!selected.length) throw new Error('Unknown locked engine');
if (process.env.CARGO_BUILD_TARGET) throw new Error('Native bundles must be built on their target host; unset CARGO_BUILD_TARGET');
const root = path.resolve(options.root), bin = path.join(root, 'bin');
await fs.mkdir(bin, { recursive: true });
if (!/^\d+\.\d+\.\d+$/.test(lock.rustToolchain || '')) throw new Error('The source lock must pin an exact Rust toolchain');
const env = { ...process.env, RUSTUP_TOOLCHAIN: lock.rustToolchain, CARGO_TARGET_DIR: path.join(root, 'target'), CARGO_BUILD_JOBS: options.jobs, CARGO_PROFILE_DEV_DEBUG: '0' };
const run = (file, args, cwd, capture = false) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { cwd, env, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
  let text = '';
  child.stdout?.on('data', bytes => { text += bytes; });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolve(text.trim()) : reject(new Error(`${file} exited ${code}`)));
});
const fonts=lock.fonts;
if(!fonts||fonts.repository!=='https://github.com/storytold/craft-fonts.git'||!/^[0-9a-f]{40}$/.test(fonts.commit))throw new Error('The source lock must pin the shared font repository');
const fontsSource=path.join(root,'sources','craft-fonts');await fs.mkdir(fontsSource,{recursive:true});
try{await fs.access(path.join(fontsSource,'.git'));}catch{await run('git',['init','--quiet',fontsSource],root);await run('git',['remote','add','origin',fonts.repository],fontsSource);}
if(await run('git',['status','--porcelain'],fontsSource,true))throw new Error('Refusing to use modified font source');
if(await run('git',['remote','get-url','origin'],fontsSource,true)!==fonts.repository)throw new Error('Unexpected shared font remote');
await run('git',['fetch','--depth=1','--filter=blob:none','origin',fonts.commit],fontsSource);await run('git',['checkout','--detach',fonts.commit],fontsSource);
if(await run('git',['rev-parse','HEAD'],fontsSource,true)!==fonts.commit)throw new Error('Shared font checkout does not match lock');
const fontsInput=path.join(root,'font-input',fonts.commit),fontProvenance=await prepareCraftFontInput(fontsSource,fontsInput,fonts.commit);
env.CRAFT_FONTS_DIR=fontsInput;env.CRAFT_FONTS_REQUIRED='1';env.FIGCRAFT_EMBED_CJK='1';
const fontLicenseRoot=path.join(bin,'licenses','craft-fonts');await fs.mkdir(fontLicenseRoot,{recursive:true});
for(const file of new Set(['ATTRIBUTION.md','LICENSE-MIT','LICENSE-APACHE','PROVENANCE.json',...fontProvenance.manifests.map(m=>m.name),...fontProvenance.transforms.map(m=>m.file),...fontProvenance.fonts.map(f=>f.licenseFile)])){const destination=path.join(fontLicenseRoot,file);await fs.mkdir(path.dirname(destination),{recursive:true});await fs.copyFile(path.join(fontsInput,file),destination);}
const rust = await run('rustc', ['--version'], repository, true);
if (!rust.startsWith(`rustc ${lock.rustToolchain} `)) throw new Error(`Install the pinned compiler: rustup toolchain install ${lock.rustToolchain}`);
const rustDetails = await run('rustc', ['-vV'], repository, true);
const cargoVersion = await run('cargo', ['--version'], repository, true);
const sourceLockHash = createHash('sha256').update(await fs.readFile(path.join(repository, 'services/image2/craft-engines.lock.json'))).digest('hex');
const version = /rustc (\d+)\.(\d+)/.exec(rust);
const minimum = lock.minimumRust.split('.').map(Number);
if (!version || Number(version[1]) < minimum[0] || (Number(version[1]) === minimum[0] && Number(version[2]) < minimum[1])) throw new Error(`Rust >= ${lock.minimumRust} is required`);
let manifest = { version: 1, platform: os.platform(), arch: os.arch(), engines: [] };
try {
  const previous = JSON.parse(await fs.readFile(path.join(bin, 'manifest.json'), 'utf8'));
  if (previous.platform === manifest.platform && previous.arch === manifest.arch) manifest = previous;
} catch { /* First build. */ }
for (const engine of selected) {
  if (!/^[a-z]+$/.test(engine.id) || !/^[0-9a-f]{40}$/.test(engine.commit) || engine.repository !== `https://github.com/storytold/${engine.id}.git` || engine.package !== `${engine.id}-cli`) throw new Error('Invalid source lock');
  const source = path.join(root, 'sources', engine.id);
  const buildOptions = { toolchain: lock.rustToolchain, rustc: rustDetails, cargo: cargoVersion, profile: options.profile, package: engine.package, defaultFeatures: engine.defaultFeatures !== false, features: engine.features, sourceLockHash, target: /^host: (.+)$/m.exec(rustDetails)?.[1] || null,fonts:{sourceCommit:fonts.commit,provenanceHash:createHash('sha256').update(JSON.stringify(fontProvenance)).digest('hex'),required:true,figcraftEmbedCjk:true,manifests:fontProvenance.manifests,transforms:fontProvenance.transforms} };
  await fs.mkdir(source, { recursive: true });
  try { await fs.access(path.join(source, '.git')); } catch {
    await run('git', ['init', '--quiet', source], root);
    await run('git', ['remote', 'add', 'origin', engine.repository], source);
  }
  if (await run('git', ['status', '--porcelain'], source, true)) throw new Error(`Refusing to overwrite modified source: ${engine.id}`);
  const origin = await run('git', ['remote', 'get-url', 'origin'], source, true);
  if (origin !== engine.repository) throw new Error(`Unexpected source remote for ${engine.id}`);
  await run('git', ['fetch', '--depth=1', '--filter=blob:none', 'origin', engine.commit], source);
  await run('git', ['checkout', '--detach', engine.commit], source);
  if (await run('git', ['rev-parse', 'HEAD'], source, true) !== engine.commit) throw new Error('Source checkout does not match lock');
  const args = ['build', '--locked', '-p', engine.package];
  if (options.profile === 'release') args.push('--release');
  if (engine.defaultFeatures === false) args.push('--no-default-features');
  if (engine.features.length) args.push('--features', engine.features.join(','));
  console.log(`Building ${engine.name} at ${engine.commit}`);
  if (await run('rustc', ['--version'], source, true) !== rust) throw new Error('Engine source selected a different compiler than the pinned toolchain');
  await run('cargo', args, source);
  if (await run('git', ['status', '--porcelain', '--untracked-files=no'], source, true)) throw new Error(`Build modified locked source files: ${engine.id}`);
  const name = `${engine.id}-cli${process.platform === 'win32' ? '.exe' : ''}`;
  const bytes = await fs.readFile(path.join(root, 'target', options.profile === 'dev' ? 'debug' : 'release', name));
  const binaryTemp = path.join(bin, `${name}.tmp-${process.pid}`);
  await fs.writeFile(binaryTemp, bytes, { mode: 0o755 });
  await fs.rename(binaryTemp, path.join(bin, name));
  const licenseRoot = path.join(bin, 'licenses', engine.id);
  await fs.mkdir(licenseRoot, { recursive: true });
  const files = (await run('git', ['ls-files', '-z'], source, true)).split('\0').filter(name => /(?:^|[-_. ])(?:licen[sc]e|copying|notice|ofl|copyright|third[-_. ]?party)(?:[._ -]|$)/i.test(path.basename(name)));
  for (const file of files) { const destination = path.join(licenseRoot, file); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.copyFile(path.join(source, file), destination); }
  const metadataArgs = ['metadata', '--locked', '--format-version', '1'];
  if (engine.defaultFeatures === false) metadataArgs.push('--no-default-features');
  if (engine.features.length) metadataArgs.push('--features', engine.features.join(','));
  const metadata = JSON.parse(await run('cargo', metadataArgs, source, true));
  await fs.writeFile(path.join(licenseRoot, 'dependencies.json'), JSON.stringify(metadata.packages.map(({ name, version, license, repository }) => ({ name, version, license, repository })), null, 2) + '\n');
  await fs.copyFile(path.join(source, 'Cargo.lock'), path.join(licenseRoot, 'Cargo.lock'));
  for (const dependency of metadata.packages) {
    const directory = path.dirname(dependency.manifest_path);
    const notices = (await fs.readdir(directory, { withFileTypes: true })).filter(entry => entry.isFile() && /(?:^|[-_. ])(?:licen[sc]e|copying|notice|ofl|copyright|third[-_. ]?party)(?:[._ -]|$)/i.test(entry.name));
    for (const notice of notices) {
      const destination = path.join(licenseRoot, 'dependencies', `${dependency.name}-${dependency.version}`, notice.name);
      await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.copyFile(path.join(directory, notice.name), destination);
    }
  }
  await fs.writeFile(path.join(licenseRoot, 'SOURCE.txt'), `${engine.repository}\ncommit ${engine.commit}\nBuilt with ${rust}\nRebuild: node scripts/build-craft-engines.mjs --engine ${engine.id}\n`);
  const cargoLockHash = createHash('sha256').update(await fs.readFile(path.join(source, 'Cargo.lock'))).digest('hex');
  await fs.writeFile(path.join(licenseRoot, 'BUILD.json'), JSON.stringify({ ...buildOptions, cargoLockHash }, null, 2) + '\n');
  const entry = { id: engine.id, sourceCommit: engine.commit, build: { ...buildOptions, cargoLockHash }, sha256: createHash('sha256').update(bytes).digest('hex'), binary: name, bytes: bytes.length };
  manifest.engines = [...manifest.engines.filter(item => item.id !== engine.id), entry];
  await fs.writeFile(path.join(bin, 'manifest.json.tmp'), JSON.stringify(manifest, null, 2) + '\n');
  await fs.rename(path.join(bin, 'manifest.json.tmp'), path.join(bin, 'manifest.json'));
  console.log(JSON.stringify(entry));
}
console.log(`Native engines ready: ${bin}`);
