import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { documentPng, documentPdf, documentSvg } from '../services/image2/exports.mjs';
import { decodeRGBA } from '../services/image2/processors.mjs';
import * as fontkit from '../services/image2/node_modules/fontkit/dist/module.mjs';

const output = resolve(process.env.IMAGE2_FONT_AUDIT_DIR || '../output/image2-browser-nonai-20261012/font-audit');
const fixed = process.env.IMAGE2_FONT_AUDIT_FIXED === '1';
mkdirSync(output, { recursive: true });
const bytes = readFileSync(new URL('../services/image2/fonts/NotoSansCJKsc-Regular.otf', import.meta.url));
const face = fontkit.create(bytes), asset = { id: 'regular', mime: 'font/otf', metadata: { family: face.familyName, weight: face['OS/2'].usWeightClass } };
const doc = { id: 'audit', name: 'audit', width: 400, height: 90, updatedAt: '2026-10-12T00:00:00Z', assetIds: ['regular'], layers: [{ id: 'text', type: 'text', text: '中文 MAI', x: 10, y: 10, width: 380, height: 80, visible: true, opacity: 1, z: 0, fontAssetId: 'regular', fontSize: 48, fontWeight: 400, fill: '#000000', metadata: { fontConfirmed: true } }] };
const dark = raw => { let sum=0; for(let i=0;i<raw.width*raw.height;i++) { const j=i*4; sum+=raw.data[j+3]/255*(1-(raw.data[j]+raw.data[j+1]+raw.data[j+2])/765); } return Math.round(sum); };
const report = { font: { family: face.familyName, subfamily: face.subfamilyName, actualWeight: face['OS/2'].usWeightClass }, png: {}, pdf: {}, browser: {} };
for (const weight of [400,700]) {
  const next={...doc,layers:doc.layers.map(layer=>({...layer,fontWeight:weight}))};
  const png=await documentPng(next,async()=>({asset,bytes})); writeFileSync(join(output,`export-${weight}.png`),png); report.png[weight]=dark(await decodeRGBA(png,'image/png'));
  const pdf=await documentPdf(next,async()=>({asset,bytes}));writeFileSync(join(output,`export-${weight}.pdf`),pdf);report.pdf[weight]={bytes:pdf.length};
}
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined});
try {
  const page=await browser.newPage({viewport:{width:400,height:90}});
  await page.goto('http://127.0.0.1:18109/image2');
  // Isolate glyph rasterization from Next dev hot reload while still using the same real browser.
  await page.goto('about:blank');
  await page.setContent('<style>html,body{margin:0;width:400px;height:90px;background:transparent}</style><svg width="400" height="90"><text id="glyph" x="10" y="58" font-family="audit" font-size="48" fill="black">中文 MAI</text></svg>');
  await page.evaluate(async ({source,fixed})=>{ const font=new FontFace('audit',`url(data:font/otf;base64,${source})`,fixed?{weight:'400'}:{}); await font.load();document.fonts.add(font);await document.fonts.ready; if(fixed)document.querySelector('#glyph').style.fontSynthesis='none'; },{source:bytes.toString('base64'),fixed});
  for(const weight of [400,700]){await page.locator('#glyph').evaluate((el,w)=>el.setAttribute('font-weight',String(w)),fixed?asset.metadata.weight:weight);const png=await page.screenshot({omitBackground:true});writeFileSync(join(output,`browser-${weight}.png`),png);report.browser[weight]=dark(await decodeRGBA(png,'image/png'));}
} finally {await browser.close();}
const subset=readFileSync(new URL('../public/fonts/source-han-sans.woff2',import.meta.url));
const assets=new Map([['regular',{asset,bytes}],['subset',{asset:{id:'subset',mime:'font/woff2',metadata:{family:face.familyName,weight:400}},bytes:subset}]]);
const mixed={...doc,height:180,layers:[{...doc.layers[0],text:'中文完整'}, {...doc.layers[0],id:'subset-text',text:'中',fontAssetId:'subset',y:100}]};
const svg=await documentSvg(mixed,async id=>assets.get(id));report.mixedFamilyFontEntries=svg.fonts.size;report.textFontFamilies=[...svg.svg.matchAll(/<text font-family="([^"]+)"/g)].map(m=>m[1]);
writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
