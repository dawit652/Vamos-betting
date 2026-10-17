import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthGate } from '@/components/account/AuthGate';
import { betTab } from '@/components/account/bets';
import { JackpotEntriesList } from '@/components/jackpot/JackpotEntriesList';
import { MyBetsList } from '@/components/account/MyBetsList';
import { accountPaths, firstParam } from '@/components/account/paths';
import { PageTitle } from '@/components/account/ui';
import { getT } from '@/i18n/server';
import { routes } from '@/lib/routes';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('account.myBets.title') };
}

/** My Bets: Open / Settled tabs (`?tab=settled`), loaded in the browser with "load more". */
export default async function MyBetsPage(props: PageProps<'/my-bets'>) {
  const [t, query] = await Promise.all([getT(), props.searchParams]);
  const tab = betTab(firstParam(query.tab));
  const tabs = [
    { id: 'open', href: routes.myBets, label: t('account.myBets.tabs.open') },
    { id: 'settled', href: accountPaths.settledBets, label: t('account.myBets.tabs.settled') },
    { id: 'jackpot', href: accountPaths.jackpotBets, label: t('account.myBets.tabs.jackpot') },
  ] as const;
  return (
    <>
      <PageTitle>{t('account.myBets.title')}</PageTitle>
      <nav className="flex gap-2 px-3 pb-2" aria-label={t('account.myBets.title')}>
        {tabs.map((item) => (
          <Link
            key={item.id}
            href={item.href}
            replace
            scroll={false}
            prefetch={false}
            className="chip"
            aria-current={item.id === tab ? 'page' : undefined}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      <AuthGate>
        {tab === 'jackpot' ? <JackpotEntriesList /> : <MyBetsList key={tab} tab={tab} />}
      </AuthGate>
    </>
  );
}
