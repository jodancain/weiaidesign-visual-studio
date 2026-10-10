/** Runs inside the freshly built, network-disabled gateway container. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const firstLine=program=>execFileSync(program,['-version'],{encoding:'utf8'}).split('\n')[0];
const ffmpeg=firstLine('ffmpeg'),ffprobe=firstLine('ffprobe');
const python=JSON.parse(execFileSync('python3',['-c',`import glob,json,sys
from PIL import Image,ImageFont,__version__
fonts=glob.glob('/usr/share/fonts/opentype/noto/*CJK*.ttc')
assert fonts, 'Noto CJK font missing'
font=ImageFont.truetype(fonts[0],24)
assert font.getbbox('视频导演台')[2]>0
print(json.dumps({'version':sys.version.split()[0],'pillow':__version__,'cjkFont':fonts[0],'chineseGlyphRasterization':True}))`],{encoding:'utf8'}));
const base='http://127.0.0.1:18082',headers={authorization:'Bearer isolated-image-test-capability','content-type':'application/json'};
let health;
for(let attempt=0;attempt<20;attempt++){try{const response=await fetch(base+'/health');if(response.ok){health=await response.json();break;}}catch{}await new Promise(resolve=>setTimeout(resolve,250));}
assert.equal(health?.status,'ok');assert.equal(health.video_key_set,false);
assert.equal((await fetch(base+'/api/v3/projects')).status,401);
const response=await fetch(base+'/api/v3/projects',{method:'POST',headers,body:JSON.stringify({name:'Isolated baked image acceptance'})});assert.equal(response.status,200);
const project=(await response.json()).data;assert.equal(project.totalFrames,240);assert.equal(project.scenes[0].objects.length,3);
const capabilities=(await (await fetch(base+'/api/v3/capabilities',{headers})).json()).data;assert.equal(capabilities.ffmpeg,true);assert.equal(capabilities.video,false);assert.equal(capabilities.llm,false);
const db=new DatabaseSync('/data/studio/studio.sqlite',{readOnly:true});const schemaVersion=db.prepare('PRAGMA user_version').get().user_version;db.close();assert.equal(schemaVersion,3);
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const sourceHashes=Object.fromEntries(['node-gateway.mjs',...readdirSync('/studio').filter(name=>name.endsWith('.mjs')).map(name=>`studio/${name}`)].map(path=>[path,hash('/'+path)]));
console.log(JSON.stringify({passed:true,node:process.version,ffmpeg,ffprobe,python,schemaVersion,healthVerified:true,authenticationVerified:true,projectCreationVerified:true,providerConfigured:false,network:'none',sourceHashes}));
