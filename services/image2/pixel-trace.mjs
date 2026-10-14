import { isMainThread, parentPort, workerData } from 'node:worker_threads';

const budgetError = message => Object.assign(new Error(message), { code:'TRACE_BUDGET', status:422 });
/** Lossless visible-pixel geometry. No palette quantisation, threshold, blur or path pruning. */
export function exactPixelSvg({ width, height, data }, { maxPixels=4000000, maxRectangles=400000, maxBytes=24*1024*1024 } = {}) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width<1 || height<1 || width*height>maxPixels || data.length!==width*height*4) throw budgetError('原色网点描摹超出像素预算；请先裁切或明确选择近似描摹，原图已保留。');
  const palette = new Map(); let previous = new Map(), rectangles=0, pathBytes=0;
  const flush = rect => {
    const path=`M${rect.x} ${rect.y}h${rect.width}v${rect.height}h-${rect.width}Z`;
    pathBytes+=path.length;
    if(++rectangles>maxRectangles || pathBytes>maxBytes) throw budgetError('原色路径数量超出预算；没有自动删点或降低清晰度，请缩小选区或明确选择彩色近似描摹。');
    const existing=palette.get(rect.color); if(existing) existing.push(path); else palette.set(rect.color,[path]);
  };
  for(let y=0;y<height;y++) {
    const current=new Map();
    for(let x=0;x<width;) {
      const i=(y*width+x)*4, alpha=data[i+3];
      if(alpha===0) { x++; continue; }
      const color=(data[i]*16777216+data[i+1]*65536+data[i+2]*256+alpha)>>>0, start=x++;
      while(x<width) { const j=(y*width+x)*4; if(data[j]!==data[i]||data[j+1]!==data[i+1]||data[j+2]!==data[i+2]||data[j+3]!==alpha)break; x++; }
      const key=`${start}:${x-start}:${color}`, old=previous.get(key);
      if(old) { old.height++; previous.delete(key); current.set(key,old); }
      else current.set(key,{x:start,y,width:x-start,height:1,color});
    }
    for(const rect of previous.values())flush(rect);
    previous=current;
  }
  for(const rect of previous.values())flush(rect);
  const paths=[];let translucent=false;
  for(const [color,segments] of palette) {
    const alpha=color&255, rgb=(color>>>8).toString(16).padStart(6,'0');
    if(alpha!==255)translucent=true;
    paths.push(`<path fill="#${rgb}"${alpha===255?'':` fill-opacity="${(alpha/255).toFixed(8)}"`} d="${segments.join('')}"/>`);
  }
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges">${paths.join('')}</svg>`;
  if(Buffer.byteLength(svg)>maxBytes)throw budgetError('原色 SVG 超出大小预算；原图已保留。');
  return {svg,metadata:{traceVersion:'pixel-boundaries-rgba-v1',approximation:false,sourceColorAndAlphaPreserved:true,pixelBoundariesExact:true,opaquePixelsExact:true,translucentRenderRounding:translucent,rectangles,colors:palette.size,pathCount:palette.size,hiddenTransparentRgbPreserved:false}};
}

if(!isMainThread && workerData?.kind==='exact-pixel-trace') {
  try { parentPort.postMessage(exactPixelSvg(workerData.raw,workerData.limits)); }
  catch(error) { parentPort.postMessage({error:error.message,code:error.code||'TRACE_FAILED'}); }
}
