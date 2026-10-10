import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { LiveList } from '@/components/sportsbook/LiveList';
import { getT } from '@/i18n/server';
import { DEFAULT_SPORT, isSport, routes } from '@/lib/routes';

export async function generateMetadata(props: PageProps<'/live/[sport]'>): Promise<Metadata> {
  const { sport } = await props.params;
  if (!isSport(sport)) return {};
  const t = await getT();
  return { title: `${t('sportsbook.live.title')} · ${t(`common.sports.${sport}`)}` };
}

export default async function LiveSportPage(props: PageProps<'/live/[sport]'>) {
  const { sport } = await props.params;
  if (!isSport(sport)) notFound();
  if (sport === DEFAULT_SPORT) redirect(routes.live());
  return <LiveList sport={sport} />;
}
