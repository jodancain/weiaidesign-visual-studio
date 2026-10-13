const finite=n=>typeof n==='number'&&Number.isFinite(n);
export function matrixError(message,code='RENDER_MATRIX'){return Object.assign(new Error(message),{status:422,code});}
export const IDENTITY=Object.freeze([1,0,0,1,0,0]);
export function validateMatrix(m){if(!Array.isArray(m)||m.length!==6||!m.every(finite)||m.some(n=>Math.abs(n)>1e10))throw matrixError('Invalid finite affine matrix');return m;}
export function multiply(a,b){validateMatrix(a);validateMatrix(b);return [a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];}
export function inverse(m){validateMatrix(m);const d=m[0]*m[3]-m[1]*m[2];if(Math.abs(d)<1e-12)throw matrixError('Transform cannot be inverted','NONINVERTIBLE_TRANSFORM');return[m[3]/d,-m[1]/d,-m[2]/d,m[0]/d,(m[2]*m[5]-m[3]*m[4])/d,(m[1]*m[4]-m[0]*m[5])/d];}
export const point=(m,p)=>({x:m[0]*p.x+m[2]*p.y+m[4],y:m[1]*p.x+m[3]*p.y+m[5]});
export function bounds(m,b){const [x,y,w,h]=b,p=[[x,y],[x+w,y],[x,y+h],[x+w,y+h]].map(([x,y])=>point(m,{x,y}));const left=Math.min(...p.map(p=>p.x)),top=Math.min(...p.map(p=>p.y));return{x:left,y:top,width:Math.max(...p.map(p=>p.x))-left,height:Math.max(...p.map(p=>p.y))-top};}
export const skiaMatrix=m=>[m[0],m[2],m[4],m[1],m[3],m[5],0,0,1];
export function worldDelta(local,parentWorld,deltaWorld){return multiply(inverse(parentWorld),multiply(deltaWorld,multiply(parentWorld,local)));}
export function rectArray(value){const b=Array.isArray(value)?value:[value?.x,value?.y,value?.width,value?.height];if(b.length!==4||!b.every(Number.isFinite)||b[2]<0||b[3]<0)throw matrixError('Invalid local content bounds');return b;}
