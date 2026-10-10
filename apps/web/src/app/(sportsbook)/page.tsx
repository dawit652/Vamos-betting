import { SportHome } from '@/components/sportsbook/SportHome';
import { DEFAULT_SPORT } from '@/lib/routes';

/** Home: the football lists (Highlights / Today / Upcoming / Leagues). */
export default async function HomePage(props: PageProps<'/'>) {
  const searchParams = await props.searchParams;
  return <SportHome sport={DEFAULT_SPORT} searchParams={searchParams} />;
}
