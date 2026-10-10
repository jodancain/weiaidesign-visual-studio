/** Browser-only Canvas2D evaluator. No accumulated simulation, clocks, assets or network. */
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
const mod=(n,m)=>((n%m)+m)%m;
function hashString(s){let h=2166136261;for(let i=0;i<s.length;i++)h=Math.imul(h^s.charCodeAt(i),16777619);return h>>>0;}
function rand(seed,index,salt=0){let n=(seed^Math.imul(index+1,0x9e3779b9)^Math.imul(salt+1,0x85ebca6b))>>>0;n=Math.imul(n^(n>>>16),0x21f0aaad);n=Math.imul(n^(n>>>15),0x735a2d97);return((n^(n>>>15))>>>0)/4294967296;}
function rgba(hex,alpha){return `rgba(${parseInt(hex.slice(1,3),16)},${parseInt(hex.slice(3,5),16)},${parseInt(hex.slice(5,7),16)},${clamp(alpha,0,1)})`;}
export function sampleEffectKeyframe(layer,frame){const keys=layer.keyframes;if(frame<=keys[0].frame)return{...keys[0],frame};if(frame>=keys.at(-1).frame)return{...keys.at(-1),frame};let i=1;while(keys[i].frame<frame)i++;const a=keys[i-1],b=keys[i],t=(frame-a.frame)/(b.frame-a.frame);return{frame,x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,scale:a.scale+(b.scale-a.scale)*t,opacity:a.opacity+(b.opacity-a.opacity)*t};}
export function protectionTop(program){return Math.max(0,Math.floor(program.height*(1-program.subtitleProtection.bottomFraction))-program.subtitleProtection.paddingPx);}
export function renderEffectsFrame(canvas,program,frame){
 if(!Number.isSafeInteger(frame)||frame<0||frame>=program.totalFrames)throw Error('Invalid absolute effects frame');
 if(canvas.width!==program.width)canvas.width=program.width;if(canvas.height!==program.height)canvas.height=program.height;
 const ctx=canvas.getContext('2d',{alpha:true}),w=canvas.width,h=canvas.height,unit=Math.min(w,h);
 ctx.resetTransform();ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';ctx.clearRect(0,0,w,h);ctx.save();ctx.beginPath();ctx.rect(0,0,w,protectionTop(program));ctx.clip();
 let activeLayers=0;
 for(const layer of program.layers){
  if(frame<layer.startFrame||frame>=layer.endFrame)continue;activeLayers++;
  const key=sampleEffectKeyframe(layer,frame),p=layer.parameters,x=key.x*w,y=key.y*h,s=key.scale,alpha=layer.opacity*key.opacity,time=(frame-layer.startFrame)/program.fps,seed=(program.seed^hashString(layer.id))>>>0;
  ctx.save();ctx.globalAlpha=alpha;ctx.lineCap='round';ctx.lineJoin='round';ctx.fillStyle=layer.color;ctx.strokeStyle=layer.color;
  if(layer.type==='glow'){
   const r=p.radius*unit*s,pulse=p.pulseHz===0?1:.8+.2*Math.cos(time*p.pulseHz*Math.PI*2),g=ctx.createRadialGradient(x,y,0,x,y,r);g.addColorStop(0,rgba(layer.color,pulse));g.addColorStop(1-p.softness,rgba(layer.color,.55*pulse));g.addColorStop(1,rgba(layer.color,0));ctx.fillStyle=g;ctx.fillRect(x-r,y-r,r*2,r*2);
  }else if(layer.type==='particles'){
   for(let i=0;i<p.count;i++){const phase=mod(frame-layer.startFrame+rand(seed,i)*p.lifeFrames,p.lifeFrames)/p.lifeFrames,cycle=Math.floor((frame-layer.startFrame+rand(seed,i)*p.lifeFrames)/p.lifeFrames),dx=(rand(seed,i,2+cycle)-.5)*p.spread*w,dy=(rand(seed,i,3+cycle)-.5)*p.spread*h,age=phase*p.lifeFrames/program.fps;ctx.globalAlpha=alpha*Math.sin(Math.PI*phase);ctx.beginPath();ctx.arc(x+dx+p.speedX*age*w,y+dy+p.speedY*age*h,p.size*unit*s*(.5+rand(seed,i,4)),0,Math.PI*2);ctx.fill();}
  }else if(layer.type==='rain'){
   ctx.lineWidth=p.width*unit*s;const dx=Math.sin(p.angle)*p.length*unit*s,dy=Math.cos(p.angle)*p.length*unit*s;
   for(let i=0;i<p.count;i++){const px=mod(rand(seed,i)*w+time*p.speed*w*Math.sin(p.angle)+(key.x-.5)*w,w),py=mod(rand(seed,i,1)*h+time*p.speed*h*Math.cos(p.angle)+(key.y-.5)*h,h);ctx.beginPath();ctx.moveTo(px,py);ctx.lineTo(px+dx,py+dy);ctx.stroke();}
  }else if(layer.type==='fog'){
   for(let i=0;i<p.count;i++){const r=p.radius*unit*s*(.7+rand(seed,i,2)),px=mod(rand(seed,i)*w+time*p.speedX*w+(key.x-.5)*w,w),py=mod(rand(seed,i,1)*h+time*p.speedY*h+(key.y-.5)*h,h),g=ctx.createRadialGradient(px,py,0,px,py,r);g.addColorStop(0,rgba(layer.color,.3));g.addColorStop(1,rgba(layer.color,0));ctx.fillStyle=g;ctx.fillRect(px-r,py-r,2*r,2*r);}
  }else if(layer.type==='ring'){
   const phase=mod(frame-layer.startFrame,p.periodFrames)/p.periodFrames;ctx.globalAlpha=alpha*Math.sin(Math.PI*phase);ctx.lineWidth=p.width*unit*s;ctx.beginPath();ctx.arc(x,y,p.radius*unit*s*(.2+.8*phase),0,Math.PI*2);ctx.stroke();
  }else if(layer.type==='light-trail'){
   for(let i=p.segments;i>0;i--){const a=sampleEffectKeyframe(layer,Math.max(layer.startFrame,frame-p.trailFrames*i/p.segments)),b=sampleEffectKeyframe(layer,Math.max(layer.startFrame,frame-p.trailFrames*(i-1)/p.segments));ctx.globalAlpha=alpha*(1-(i-.5)/p.segments);ctx.lineWidth=p.width*unit*s;ctx.beginPath();ctx.moveTo(a.x*w,a.y*h);ctx.lineTo(b.x*w,b.y*h);ctx.stroke();}
  }else if(layer.type==='vignette'){
   const radius=p.radius*unit*s,g=ctx.createRadialGradient(x,y,Math.max(0,radius*(1-p.softness)),x,y,radius);g.addColorStop(0,rgba(layer.color,0));g.addColorStop(1,rgba(layer.color,1));ctx.fillStyle=g;ctx.fillRect(0,0,w,h);
  }else throw Error('Unsupported effect');
  ctx.restore();
 }
 ctx.restore();
 const top=protectionTop(program);ctx.save();ctx.globalCompositeOperation='destination-in';const feather=ctx.createLinearGradient(0,Math.max(0,top-24),0,top);feather.addColorStop(0,'rgba(0,0,0,1)');feather.addColorStop(1,'rgba(0,0,0,0)');ctx.fillStyle=feather;ctx.fillRect(0,0,w,h);ctx.restore();
 const pixels=ctx.getImageData(0,0,w,h).data;let hasVisiblePixels=false;for(let i=3;i<pixels.length;i+=4)if(pixels[i]){hasVisiblePixels=true;break;}
 return{frame,activeLayers,protectionTop:top,featherPx:24,hasVisiblePixels};
}
