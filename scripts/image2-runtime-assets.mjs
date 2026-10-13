import {createRequire} from 'node:module';
import {mkdir,copyFile,writeFile,readdir,readFile,chmod} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url),root=process.cwd(),vendor=join(root,'public/vendor/image2');
const files=[];
for(const [pkg,version,name] of [['canvaskit-wasm','0.42.0','canvaskit'],['pathkit-wasm','1.0.0','pathkit']]){
 const runtimePath=require.resolve(`${pkg}/bin/${name}.js`),folder=join(vendor,`${name}-${version}`);await mkdir(folder,{recursive:true});
 for(const file of [`${name}.js`,`${name}.wasm`,'LICENSE']){const target=join(folder,file),source=file==='LICENSE'?join(dirname(dirname(runtimePath)),file):join(dirname(runtimePath),file);await copyFile(source,target);await chmod(target,0o644);const bytes=await readFile(target);files.push({path:target.slice(root.length+1),sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});}
}
const core=join(root,'services/image2/core'),destination=join(vendor,'core-1');await mkdir(destination,{recursive:true});
for(const name of await readdir(core))if(name.endsWith('.mjs')||name.endsWith('.LICENSE')){const target=join(destination,name);await copyFile(join(core,name),target);const bytes=await readFile(target);files.push({path:target.slice(root.length+1),sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});}
await writeFile(join(vendor,'manifest.json'),JSON.stringify({version:1,files},null,2)+'\n');
console.log(`Image2 runtime: ${files.length} self-hosted assets`);
