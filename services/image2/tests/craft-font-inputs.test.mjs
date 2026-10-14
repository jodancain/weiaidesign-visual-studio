import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from '../domain.mjs';
import { prepareCraftFontInput } from '../../../scripts/craft-font-inputs.mjs';

test('pinned font inputs verify actual Chinese glyphs and preserve bytes while explicitly adding only an empty optional Latin list',async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'craft-font-inputs-')),source=join(root,'source'),output=join(root,'output');t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(join(source,'fonts/sc'),{recursive:true});
  const bytes=await fs.readFile(fileURLToPath(new URL('../fonts/NotoSansCJKsc-Regular.otf',import.meta.url))),license=await fs.readFile(fileURLToPath(new URL('../fonts/LICENSE',import.meta.url)));
  await fs.writeFile(join(source,'fonts/sc/font.otf'),bytes);await fs.writeFile(join(source,'fonts/sc/OFL.txt'),license);
  for(const name of ['ATTRIBUTION.md','LICENSE-MIT','LICENSE-APACHE'])await fs.writeFile(join(source,name),'Synthetic metadata fixture; font bytes/license are the repository Noto source.');
  const manifest=`Noto Sans CJK SC | Regular | fonts/sc/font.otf | Hans,Latn | OFL-1.1 | fonts/sc/OFL.txt | ${digest(bytes)} | https://example.invalid/pinned-font\n`;await fs.writeFile(join(source,'fonts/manifest.txt'),manifest);
  const result=await prepareCraftFontInput(source,output,'synthetic-source-commit');assert.equal(result.fonts.length,1);assert.equal(result.verification.glyphsWithOutlines,12);assert.deepEqual(await fs.readFile(join(output,'fonts/sc/font.otf')),bytes);assert.equal(result.transforms[0].operation,'add-empty-optional-manifest');assert.equal((await fs.readFile(join(output,'fonts/latin-manifest.txt'),'utf8')).split('\n').filter(line=>line&&!line.startsWith('#')).length,0);await assert.rejects(fs.access(join(source,'fonts/latin-manifest.txt')));
  await fs.writeFile(join(source,'fonts/manifest.txt'),manifest.replace(digest(bytes),'0'.repeat(64)));await assert.rejects(prepareCraftFontInput(source,output,'synthetic'),/mismatch/);
  await fs.writeFile(join(source,'fonts/manifest.txt'),manifest.replace('fonts/sc/font.otf','../outside.otf'));await assert.rejects(prepareCraftFontInput(source,output,'synthetic'),/Invalid/);
  await fs.writeFile(join(source,'fonts/manifest.txt'),manifest.replace('Noto Sans CJK SC','Unrelated face'));await assert.rejects(prepareCraftFontInput(source,output,'synthetic'),/Simplified Chinese/);
});
