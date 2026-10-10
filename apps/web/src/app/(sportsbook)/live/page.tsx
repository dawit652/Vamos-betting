import type { Metadata } from 'next';
import { LiveList } from '@/components/sportsbook/LiveList';
import { getT } from '@/i18n/server';
import { DEFAULT_SPORT } from '@/lib/routes';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('sportsbook.live.title') };
}

/** Live football (other sports at `/live/[sport]`). */
export default function LivePage() {
  return <LiveList sport={DEFAULT_SPORT} />;
}
