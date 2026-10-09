/** Run after next build: real standalone process, local gateway fixture, no provider. */
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const web=resolve(import.meta.dirname,'..'),entry=resolve(web,'.next/standalone/server.js');
assert.ok(existsSync(entry),'Run next build before standalone origin acceptance');
const installation='isolated-standalone-origin-installation',upstream='isolated-standalone-origin-upstream';
const calls=[];
const gateway=createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);calls.push({path:req.url,method:req.method,authorization:req.headers.authorization});assert.equal(req.headers.authorization,`Bearer ${upstream}`);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:{id:'isolated-proxy-project',received:chunks.length?JSON.parse(Buffer.concat(chunks)):null}}));});
gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(r=>reservation.close(r));
const base=`http://127.0.0.1:${port}`,child=spawn(process.execPath,[entry],{cwd:dirname(entry),env:{PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'production',HOSTNAME:'0.0.0.0',PORT:String(port),REQUIRE_ACCESS_TOKEN:'1',VIDEO_API_TOKEN:installation,VIDEO_API_PROXY_TOKEN:upstream,STUDIO_GATEWAY_URL:`http://127.0.0.1:${gateway.address().port}`,NEXT_TELEMETRY_DISABLED:'1'},stdio:['ignore','pipe','pipe']});
let output='';child.stdout.on('data',bytes=>{output+=bytes;});child.stderr.on('data',bytes=>{output+=bytes;});
// Node fetch rewrites Host; a reverse proxy uses the wire-level Host header.
const proxyRequest=(path,options)=>new Promise((resolve,reject)=>{const request=httpRequest(base+path,{method:options.method,headers:options.headers},response=>{const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:response.statusCode,headers:Object.fromEntries(Object.entries(response.headers).map(([key,value])=>[key,Array.isArray(value)?value.join(','):value]))})));});request.on('error',reject);request.end(options.body);});
try{
  let ready=false;for(let i=0;i<100;i++){try{const response=await fetch(base+'/api/v3/projects');if(response.status===401){ready=true;break;}}catch{}if(child.exitCode!==null)throw Error(`standalone exited: ${output}`);await new Promise(r=>setTimeout(r,200));}assert.ok(ready,`standalone startup timeout: ${output}`);
  const videoPage=await (await fetch(base+'/video')).text(),studioPage=await (await fetch(base+'/video/studio')).text();
  assert.ok(videoPage.includes('图生视频')&&!videoPage.includes('正在打开视频工作台'),'/video must default to the legacy entry');assert.ok(studioPage.includes('正在打开视频工作台'),'explicit Studio route must remain available');
  const legacyChunks=[...videoPage.matchAll(/src="(\/_next\/static\/[^"?]+\.js)(?:\?[^\"]*)?"/g)].map(match=>resolve(web,'.next',match[1].slice('/_next/'.length)));
  assert.ok(legacyChunks.some(path=>existsSync(path)&&readFileSync(path,'utf8').includes('videoJobs')),'legacy page must reference the compiled videoJobs client');
  const publicHost='studio-origin-fixture.example',headers={'host':publicHost,'origin':`https://${publicHost}`,'x-forwarded-proto':'https','content-type':'application/json'};
  const login=await proxyRequest('/api/v3/session',{method:'POST',headers,body:JSON.stringify({token:installation})});assert.equal(login.status,200,await login.text());
  const rawCookie=login.headers.get('set-cookie');assert.ok(rawCookie);assert.match(rawCookie,/; Secure/);assert.ok(!rawCookie.includes(installation));const cookie=rawCookie.split(';')[0];
  const created=await proxyRequest('/api/v3/projects',{method:'POST',headers:{...headers,cookie},body:JSON.stringify({name:'reverse-proxy-host-proof'})});assert.equal(created.status,200);assert.equal((await created.json()).data.id,'isolated-proxy-project');
  const rejected=await proxyRequest('/api/v3/projects',{method:'POST',headers:{...headers,cookie,origin:'https://hostile.example','x-forwarded-host':'hostile.example'},body:'{}'});assert.equal(rejected.status,403);
  const local=await fetch(base+'/api/v3/session',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({token:installation})});assert.equal(local.status,200);assert.ok(!local.headers.get('set-cookie').includes('; Secure'));
  assert.equal(calls.length,1);
  const receipt={passed:true,realStandaloneProcess:true,bindHost:'0.0.0.0',publicHost,publicHttpsLogin:true,sameOriginMutation:true,forgedForwardedHostRejected:true,loopbackHttpLogin:true,secureCookie:true,defaultVideoIsLegacy:true,explicitStudioRouteAvailable:true,providerCalls:0,upstreamCalls:calls.length,buildId:readFileSync(resolve(web,'.next/BUILD_ID'),'utf8').trim()};
  const directory=resolve(web,process.env.STUDIO_ORIGIN_EVIDENCE || '../output/studio-v3-validation-20261001');mkdirSync(directory,{recursive:true});writeFileSync(resolve(directory,'standalone-origin-acceptance.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
}finally{
  child.kill('SIGTERM');await Promise.race([once(child,'exit'),new Promise(r=>setTimeout(r,5000))]);if(child.exitCode===null)child.kill('SIGKILL');gateway.closeAllConnections();await new Promise(r=>gateway.close(r));
}
