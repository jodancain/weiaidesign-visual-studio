import sharp from 'sharp';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';

const invalid = message => Object.assign(new Error(message), { status: 400, code: 'INVALID_PARAMS' });
function number(value, min, max, name, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw invalid(`${name} must be a finite number in ${min}..${max}`);
  return value;
}
const clamp = value => Math.round(Math.max(0, Math.min(255, value)));
export const adjustmentKinds = Object.freeze(['brightness','contrast','exposure','saturation','hue','gamma','grayscale','invert','threshold','levels']);
export const filterKinds = Object.freeze(['gaussian_blur','sharpen','median']);

/** RGB-only edits in the document's 8-bit sRGB space; alpha and dimensions are immutable. */
export function adjustPixels(raw, params) {
  const { kind } = params;
  if (!adjustmentKinds.includes(kind)) throw invalid('Unknown adjustment kind');
  const ranges = { brightness:[-100,100], contrast:[-100,100], exposure:[-5,5], saturation:[-100,200], hue:[-180,180], gamma:[.1,5], threshold:[0,255] };
  const value = ranges[kind] ? number(params.value, ...ranges[kind], 'value') : undefined;
  const black = kind === 'levels' ? number(params.black, 0, 254, 'black', 0) : 0;
  const white = kind === 'levels' ? number(params.white, 1, 255, 'white', 255) : 255;
  const gamma = kind === 'levels' ? number(params.gamma, .1, 5, 'gamma', 1) : value;
  if (black >= white) throw invalid('levels black must be smaller than white');
  const output = { ...raw, data: Buffer.from(raw.data) };
  // One final byte conversion avoids rounding between stages of an adjustment.
  for (let i = 0; i < raw.data.length; i += 4) {
    const rgb = [raw.data[i], raw.data[i+1], raw.data[i+2]];
    const luma = .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
    let next;
    switch (kind) {
      case 'brightness': next = rgb.map(c => c + value * 2.55); break;
      case 'contrast': { const scale = (100 + value) / Math.max(1, 100 - value); next = rgb.map(c => (c - 127.5) * scale + 127.5); break; }
      case 'exposure': next = rgb.map(c => c * 2 ** value); break;
      case 'saturation': next = rgb.map(c => luma + (c - luma) * (1 + value / 100)); break;
      case 'gamma': next = rgb.map(c => 255 * (c / 255) ** (1 / gamma)); break;
      case 'grayscale': next = [luma,luma,luma]; break;
      case 'invert': next = rgb.map(c => 255 - c); break;
      case 'threshold': next = Array(3).fill(luma >= value ? 255 : 0); break;
      case 'levels': next = rgb.map(c => 255 * Math.max(0, Math.min(1, (c - black) / (white - black))) ** (1 / gamma)); break;
      case 'hue': {
        const max = Math.max(...rgb), min = Math.min(...rgb), delta = max - min;
        if (!delta) { next = rgb; break; }
        let h = max === rgb[0] ? (rgb[1]-rgb[2])/delta : max === rgb[1] ? 2+(rgb[2]-rgb[0])/delta : 4+(rgb[0]-rgb[1])/delta;
        h = ((h + value / 60) % 6 + 6) % 6;
        const x = delta * (1 - Math.abs(h % 2 - 1));
        next = (h < 1 ? [delta,x,0] : h < 2 ? [x,delta,0] : h < 3 ? [0,delta,x] : h < 4 ? [0,x,delta] : h < 5 ? [x,0,delta] : [delta,0,x]).map(c => c + min);
        break;
      }
    }
    for (let c = 0; c < 3; c++) output.data[i+c] = clamp(next[c]);
  }
  return output;
}

async function alphaWeightedBlur(raw, radius) {
  // Keep premultiplied colour and coverage in floating point until the final
  // division. Eight-bit premultiplication destroys dark, low-alpha colours.
  // Two separable passes implement a Gaussian truncated at three sigma.
  const {width,height}=raw, half=Math.ceil(radius*3), kernel=new Float64Array(half*2+1);
  let sum=0;
  for(let offset=-half;offset<=half;offset++)sum+=(kernel[offset+half]=Math.exp(-(offset*offset)/(2*radius*radius)));
  for(let k=0;k<kernel.length;k++)kernel[k]/=sum;
  const horizontal=new Float32Array(width*height*4), data=Buffer.from(raw.data);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
    let r=0,g=0,b=0,a=0;
    for(let dx=-half;dx<=half;dx++) {
      const i=(y*width+Math.max(0,Math.min(width-1,x+dx)))*4;
      const weight=kernel[dx+half]*raw.data[i+3];
      r+=raw.data[i]*weight;g+=raw.data[i+1]*weight;b+=raw.data[i+2]*weight;a+=weight;
    }
    const i=(y*width+x)*4;
    horizontal[i]=r;horizontal[i+1]=g;horizontal[i+2]=b;horizontal[i+3]=a;
  }
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
    const out=(y*width+x)*4;
    if(!raw.data[out+3])continue; // Hidden RGB is not part of the visible filter.
    let r=0,g=0,b=0,a=0;
    for(let dy=-half;dy<=half;dy++) {
      const i=(Math.max(0,Math.min(height-1,y+dy))*width+x)*4, weight=kernel[dy+half];
      r+=horizontal[i]*weight;g+=horizontal[i+1]*weight;b+=horizontal[i+2]*weight;a+=horizontal[i+3]*weight;
    }
    if(a>0){data[out]=clamp(r/a);data[out+1]=clamp(g/a);data[out+2]=clamp(b/a);}
  }
  return data;
}

function alphaWeightedMedian(raw,size) {
  const data=Buffer.from(raw.data),half=(size-1)/2,channels=[new Uint32Array(256),new Uint32Array(256),new Uint32Array(256)];
  for(let y=0;y<raw.height;y++) {
    for(const histogram of channels)histogram.fill(0);
    let total=0;
    const column=(x,sign)=>{
      const xx=Math.max(0,Math.min(raw.width-1,x));
      for(let dy=-half;dy<=half;dy++) {
        const yy=Math.max(0,Math.min(raw.height-1,y+dy)),i=(yy*raw.width+xx)*4,weight=raw.data[i+3];
        total+=sign*weight;
        for(let c=0;c<3;c++)channels[c][raw.data[i+c]]+=sign*weight;
      }
    };
    for(let dx=-half;dx<=half;dx++)column(dx,1);
    for(let x=0;x<raw.width;x++) {
      const i=(y*raw.width+x)*4;
      if(raw.data[i+3]&&total)for(let c=0;c<3;c++) {
        let weight=0;
        for(let value=0;value<256;value++){weight+=channels[c][value];if(weight>total/2){data[i+c]=value;break;}}
      }
      column(x-half,-1);column(x+half+1,1);
    }
  }
  return data;
}

/** Blur/sharpen weight colour by alpha; every filter preserves the original alpha channel. */
export async function filterPixels(raw, params) {
  if (!filterKinds.includes(params.kind)) throw invalid('Unknown filter kind');
  const image = () => sharp(raw.data, { raw: { width:raw.width, height:raw.height, channels:4 } });
  let data;
  if (params.kind === 'gaussian_blur') {
    const radius = number(params.radius, .3, 20, 'radius', 1);
    data = await alphaWeightedBlur(raw, radius);
  } else if (params.kind === 'sharpen') {
    const amount = number(params.amount, 0, 3, 'amount', 1);
    const blurred = await alphaWeightedBlur(raw, 1);
    data = Buffer.from(raw.data);
    for (let i=0;i<data.length;i+=4) for(let c=0;c<3;c++) data[i+c]=clamp(raw.data[i+c]+amount*(raw.data[i+c]-blurred[i+c]));
  } else {
    const size = number(params.size, 3, 9, 'size', 3);
    if (![3,5,7,9].includes(size)) throw invalid('median size must be 3, 5, 7 or 9');
    data = raw.data.some((value,index)=>index%4===3&&value!==255) ? alphaWeightedMedian(raw,size) : await image().median(size).raw().toBuffer();
  }
  if (data.length !== raw.data.length) throw invalid('Filter returned unexpected dimensions');
  for (let i=3;i<data.length;i+=4) data[i]=raw.data[i];
  return { ...raw, data };
}

if(!isMainThread && workerData?.kind==='pixel-adjust') {
  try {
    const raw={...workerData.raw,data:Buffer.from(workerData.raw.data)};
    const result=workerData.operation==='adjust'?adjustPixels(raw,workerData.params):await filterPixels(raw,workerData.params);
    const data=Uint8Array.from(result.data);
    parentPort.postMessage({raw:{...result,data}},[data.buffer]);
  } catch(error) { parentPort.postMessage({error:error.message,code:error.code||'FILTER_FAILED'}); }
}
