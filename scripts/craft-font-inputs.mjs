import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../services/image2/package.json', import.meta.url));
const fontkit = require('fontkit');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const relative = value => typeof value === 'string' && value.startsWith('fonts/') && !value.includes('\\') && !value.split('/').some(p => !p || p === '.' || p === '..');

/** Preserve upstream font bytes; the sole compatibility transform is an empty optional Latin list. */
export async function prepareCraftFontInput(source, destination, sourceCommit) {
  const manifests = [], entries = [], copies = new Map();
  for (const name of ['fonts/manifest.txt','fonts/latin-manifest.txt']) {
    let bytes;try { bytes=await fs.readFile(path.join(source,name)); }catch(error){if(error.code==='ENOENT'&&name==='fonts/latin-manifest.txt')continue;throw error;}
    manifests.push({name,sha256:hash(bytes)});copies.set(name,bytes);
    for(const line of bytes.toString('utf8').split(/\r?\n/).map(v=>v.trim()).filter(v=>v&&!v.startsWith('#'))){
      const [family,style,file,scripts,license,licenseFile,sha256,origin,...extra]=line.split(' | ').map(v=>v.trim());
      if(extra.length||!family||!style||!relative(file)||!relative(licenseFile)||license!=='OFL-1.1'||!/^[a-f0-9]{64}$/.test(sha256)||!origin?.startsWith('https://'))throw Error('Invalid pinned craft-fonts manifest entry');
      const data=await fs.readFile(path.join(source,file)),notice=await fs.readFile(path.join(source,licenseFile));
      if(hash(data)!==sha256||!notice.toString('utf8').includes('SIL OPEN FONT LICENSE'))throw Error(`Pinned font bytes/license mismatch: ${family}`);
      copies.set(file,data);copies.set(licenseFile,notice);entries.push({family,style,file,scripts:scripts.split(','),license,licenseFile,sha256,source:origin});
    }
  }
  const chinese=entries.find(entry=>entry.family==='Noto Sans CJK SC'&&entry.scripts.includes('Hans'));
  if(!chinese)throw Error('Pinned shared fonts must contain the Simplified Chinese face');
  const face=fontkit.create(copies.get(chinese.file)),probe='中文海报标志设计矢量编辑';
  for(const character of probe){const code=character.codePointAt(0),glyph=face.glyphForCodePoint(code);if(!face.hasGlyphForCodePoint(code)||glyph.id===0||!glyph.path.commands.length)throw Error(`Pinned Chinese font is missing an actual outlined glyph: ${character}`);}
  const transforms=[];
  if(!copies.has('fonts/latin-manifest.txt')){copies.set('fonts/latin-manifest.txt',Buffer.from('# Empty optional Latin font manifest. The pinned upstream checkout does not supply one.\n# Compatibility for FigCraft strict build input; no Latin/CJK coverage is inferred from this file.\n'));transforms.push({file:'fonts/latin-manifest.txt',operation:'add-empty-optional-manifest',reason:'FigCraft strict optional manifest compatibility; upstream missing; no font files added or removed'});}
  await fs.mkdir(destination,{recursive:true});
  for(const [file,bytes] of copies){const output=path.join(destination,file);await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,bytes);}
  for(const name of ['ATTRIBUTION.md','LICENSE-MIT','LICENSE-APACHE'])await fs.copyFile(path.join(source,name),path.join(destination,name));
  const provenance={repository:'https://github.com/storytold/craft-fonts.git',sourceCommit,manifests,fonts:entries,transforms,verification:{family:face.familyName,probe,glyphsWithOutlines:[...probe].length,scope:'font-file coverage only; each native engine still requires actual Chinese render verification'}};
  await fs.writeFile(path.join(destination,'PROVENANCE.json'),JSON.stringify(provenance,null,2)+'\n');return provenance;
}
