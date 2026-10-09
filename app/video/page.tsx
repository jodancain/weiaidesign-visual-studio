import StudioPage from './studio/page';
import LegacyPage from './legacy/page';

export const dynamic = 'force-dynamic';

/** Switch only after independent studio acceptance; the legacy route stays usable. */
export default function VideoPage() {
  return process.env.STUDIO_V3_DEFAULT === '1' ? <StudioPage /> : <LegacyPage />;
}
