'use client';
import dynamic from 'next/dynamic';
const StudioWorkspace = dynamic(() => import('../../../components/studio/StudioWorkspace'), { ssr: false, loading: () => <main style={{ background: '#101113', color: '#d8dde4', height: '100vh', display: 'grid', placeItems: 'center' }}>正在打开视频工作台…</main> });
export default function Page() { return <StudioWorkspace />; }
