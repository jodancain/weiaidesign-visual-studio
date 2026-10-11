'use client';
import dynamic from 'next/dynamic';
const Workspace = dynamic(() => import('../../components/image2/ImageWorkspace'), { ssr: false });
export default function Image2Page() { return <Workspace />; }
