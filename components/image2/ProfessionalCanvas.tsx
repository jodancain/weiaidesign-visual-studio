'use client';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useEditor, useValue } from 'tldraw';
import type { ImageDocument } from '../../lib/image2/types';

export const ProfessionalCanvasContext = createContext<{ document: ImageDocument | null; onError: (message: string) => void }>({ document: null, onError: () => {} });
type Frame = { id: number; documentId: string; revision: number; bounds: {x:number;y:number;width:number;height:number}; width: number; height: number; pixels: ArrayBuffer };
/** Mounted inside the existing tldraw canvas, underneath its interaction overlays. */
export function ProfessionalCanvas() {
  const { document, onError } = useContext(ProfessionalCanvasContext), editor = useEditor();
  const viewport = useValue('image2 software viewport', () => ({ bounds: editor.getViewportPageBounds().toJson(), zoom: editor.getZoomLevel() }), [editor]);
  const canvas = useRef<HTMLCanvasElement>(null), worker = useRef<Worker | null>(null), request = useRef(0), errorHandler = useRef(onError), watchdog = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [frame, setFrame] = useState<Frame | null>(null);
  useEffect(() => { errorHandler.current = onError; }, [onError]);
  const startWorker = () => {
    const instance = new Worker('/image2-render-worker.js'); worker.current = instance;
    instance.onmessage = ({data}) => {
      if (data.id !== request.current) return;
      clearTimeout(watchdog.current);
      if (data.type === 'error') { errorHandler.current(data.message); return; }
      if (data.type === 'frame') setFrame(data as Frame);
    };
    instance.onerror = () => errorHandler.current('软件渲染器加载失败，请检查本机 WASM 资源');
    return instance;
  };
  useEffect(() => {
    // Termination, rather than a queued cancel message, can stop synchronous WASM drawing.
    return () => { clearTimeout(watchdog.current); worker.current?.terminate(); worker.current = null; };
  }, [document?.id]);
  useEffect(() => {
    const id = ++request.current;
    if (document?.schemaVersion !== 3) { worker.current?.terminate(); worker.current=null; return; }
    const timer = requestAnimationFrame(() => {
      const bounds = viewport.bounds;
      const desired = viewport.zoom * Math.min(window.devicePixelRatio || 1, 2);
      const pixelScale = Math.min(desired, Math.sqrt(16000000 / (bounds.w * bounds.h)));
      const instance=worker.current || startWorker();
      clearTimeout(watchdog.current);
      watchdog.current=setTimeout(()=>{if(request.current===id){instance.terminate();if(worker.current===instance)worker.current=null;errorHandler.current('预览渲染耗时超限，本次已停止；重新操作可恢复');}},30000);
      instance.postMessage({type:'render', id, document, bounds: {x:bounds.x,y:bounds.y,width:bounds.w,height:bounds.h}, pixelScale});
    });
    return () => cancelAnimationFrame(timer);
  }, [document, viewport]);
  useEffect(() => {
    if (!frame || !canvas.current || frame.documentId !== document?.id) return;
    const node = canvas.current; node.width = frame.width; node.height = frame.height;
    node.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(frame.pixels), frame.width, frame.height), 0, 0);
  }, [frame, document?.id]);
  if (document?.schemaVersion !== 3) return null;
  return <>
    {document.artboards?.filter(board => board.visible).map(board => <div key={board.id} aria-label={`画板 ${board.name}`} style={{position:'absolute',pointerEvents:'none',left:board.bounds.x,top:board.bounds.y,width:board.bounds.width,height:board.bounds.height,border:'1px solid #d7d9df',background:board.background || 'transparent'}} />)}
    <canvas ref={canvas} data-testid="image2-professional-canvas" aria-label="设计画面" style={{position:'absolute',pointerEvents:'none',left:frame?.bounds.x || 0,top:frame?.bounds.y || 0,width:frame?.bounds.width || 0,height:frame?.bounds.height || 0,visibility:frame?.documentId === document.id ? 'visible' : 'hidden'}} />
    {document.guides?.filter(guide => guide.visible).map(guide => {
      const board=guide.artboardId?document.artboards?.find(item=>item.id===guide.artboardId):undefined;
      if(guide.artboardId&&!board?.visible)return null;
      const b=board?.bounds || {x:viewport.bounds.x,y:viewport.bounds.y,width:viewport.bounds.w,height:viewport.bounds.h};
      return <div key={guide.id} style={{position:'absolute',pointerEvents:'none',background:'#26b8cf',opacity:.65,...(guide.axis === 'x' ? {left:guide.position,top:b.y,width:1/viewport.zoom,height:b.height} : {left:b.x,top:guide.position,width:b.width,height:1/viewport.zoom})}} />;
    })}
  </>;
}
export const professionalCanvasComponents = {OnTheCanvas:ProfessionalCanvas};
