/** Explicit real-worker acceptance. No generation/GPU call. Invoke with worker URL and source PNG. */
import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {executeOperation,decodeRGBA,inspectAsset} from '../processors.mjs';
import {requestOCR} from '../providers.mjs';

const options={};for(let i=2;i<process.argv.length;i+=2)options[process.argv[i].replace(/^--/,'')]=process.argv[i+1];
if(!options.url||!options.image||!options.report)throw new Error('Required: --url URL --image PNG --report JSON; token comes from IMAGE2_OCR_TOKEN');
const source=await readFile(options.image),info=await inspectAsset(source,'image/png'),assets=new Map([['source',{asset:{id:'source',...info},bytes:source}]]);
const checkpoints={};
const ctx={document:{id:'smoke',width:info.width,height:info.height,layers:[{id:'base',type:'raster',assetId:'source',x:0,y:0,width:info.width,height:info.height,z:0}]},config:{ocrUrl:options.url,ocrToken:process.env.IMAGE2_OCR_TOKEN||'',comfyBaseUrl:''},getAsset:async id=>assets.get(id),saveAsset:async(key,descriptor,bytes)=>{const asset={id:randomUUID(),...descriptor};assets.set(asset.id,{asset,bytes:Buffer.from(bytes)});return asset;},checkpoint:async patch=>Object.assign(checkpoints,patch),cancelled:()=>false};
const started=Date.now(),ocr=await requestOCR(source,ctx),ocrMs=Date.now()-started;
ctx.checkpoints={restoreOCR:ocr};
const restoreStart=Date.now(),result=await executeOperation({operation:'restore_layers',inputs:[{role:'base',assetId:'source'}],params:{segment:false},idempotencyKey:randomUUID()},ctx);
const layers=result.commands.filter(x=>x.type==='layer.add').map(x=>x.layer);
const composited=await sharp({create:{width:info.width,height:info.height,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).composite(layers.map(layer=>({input:assets.get(layer.assetId).bytes,left:layer.x,top:layer.y}))).png().toBuffer();
const original=await decodeRGBA(source,'image/png'),restored=await decodeRGBA(composited,'image/png');
let differentChannels=0;for(let i=0;i<original.data.length;i++)if(original.data[i]!==restored.data[i])differentChannels++;
const report={models:ocr.models,ocrMs,restoreMs:Date.now()-restoreStart,texts:ocr.items.map(x=>({text:x.text,confidence:x.confidence,bbox:x.bbox})),layers:layers.map(x=>({type:x.type,name:x.name,ownedPixelCount:x.metadata.ownedPixelCount,fontStatus:x.metadata.fontStatus})),coverage:result.output.coverage,partitionDifferentChannels:result.output.differentChannels,renderedDifferentChannels:differentChannels,fontsConfirmed:false,gpuCalled:false,generationCalled:false,needsReview:result.needsReview};
await writeFile(options.report,JSON.stringify(report,null,2)+'\n');
if(options.output)await writeFile(options.output,composited);
console.log(JSON.stringify(report));
if(differentChannels||result.output.coverage!==1||!ocr.items.length)process.exitCode=1;
