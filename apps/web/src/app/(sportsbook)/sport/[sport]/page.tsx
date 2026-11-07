import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { SportHome } from '@/components/sportsbook/SportHome';
import {
  listHref,
  parseCountry,
  parseDay,
  parseMarket,
  parseTab,
} from '@/components/sportsbook/tabs';
import { getT } from '@/i18n/server';
import { DEFAULT_SPORT, isSport, routes } from '@/lib/routes';

export async function generateMetadata(props: PageProps<'/sport/[sport]'>): Promise<Metadata> {
  const { sport } = await props.params;
  if (!isSport(sport)) return {};
  const t = await getT();
  return { title: t(`common.sports.${sport}`) };
}

/** A sport's lists; football lives at `/`. */
export default async function SportPage(props: PageProps<'/sport/[sport]'>) {
  const [{ sport }, searchParams] = await Promise.all([props.params, props.searchParams]);
  if (!isSport(sport)) notFound();
  if (sport === DEFAULT_SPORT) {
    redirect(
      listHref(routes.home, parseTab(searchParams.tab), undefined, {
        day: parseDay(searchParams.day, new Date()),
        country: parseCountry(searchParams.country),
        market: parseMarket(searchParams.market),
      }),
    );
  }
  return <SportHome sport={sport} searchParams={searchParams} />;
}
