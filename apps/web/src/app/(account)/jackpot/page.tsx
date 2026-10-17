import type { Metadata } from 'next';
import Link from 'next/link';
import { templateTab, TEMPLATE_CODES } from '@/components/jackpot/jackpot';
import { MultiBonusLadder, OpenRound, RecentRound } from '@/components/jackpot/JackpotRounds';
import { firstParam } from '@/components/account/paths';
import { Alert, PageTitle } from '@/components/account/ui';
import { getT } from '@/i18n/server';
import { getJackpots, getPromotions } from '@/lib/api/jackpots-server';
import { routes } from '@/lib/routes';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('account.jackpot.title') };
}

/**
 * Jackpot: one tab per template (`?tab=daily9|weekly13`). The open round with its
 * prize tiers and the entry form (the only client island), the recent rounds
 * with results, and the multi-bonus ladder. Viewing is public; entering needs a session.
 */
export default async function JackpotPage(props: PageProps<'/jackpot'>) {
  const [t, query] = await Promise.all([getT(), props.searchParams]);
  const tab = templateTab(firstParam(query.tab));
  const [jackpots, promotions] = await Promise.all([
    getJackpots(tab).catch(() => null),
    getPromotions().catch(() => null),
  ]);
  return (
    <>
      <PageTitle>{t('account.jackpot.title')}</PageTitle>
      <p className="px-3 pb-2 text-xs text-muted">{t('account.jackpot.intro')}</p>
      <nav className="flex gap-2 px-3 pb-2" aria-label={t('account.jackpot.title')}>
        {TEMPLATE_CODES.map((code) => (
          <Link
            key={code}
            href={`${routes.jackpot}?tab=${code}`}
            replace
            scroll={false}
            prefetch={false}
            className="chip"
            aria-current={code === tab ? 'page' : undefined}
          >
            {t(`account.jackpot.tabs.${code}`)}
          </Link>
        ))}
      </nav>
      <div className="space-y-3 px-3 pb-3">
        {jackpots === null ? (
          <Alert>{t('account.jackpot.loadFailed')}</Alert>
        ) : (
          <>
            {jackpots.open.length === 0 ? (
              <p className="card text-center text-muted">{t('account.jackpot.noOpen')}</p>
            ) : (
              jackpots.open.map((round) => <OpenRound key={round.id} round={round} />)
            )}
            <h2 className="pt-2 text-sm font-bold">{t('account.jackpot.recent.title')}</h2>
            {jackpots.recent.length === 0 ? (
              <p className="text-xs text-muted">{t('account.jackpot.recent.empty')}</p>
            ) : (
              jackpots.recent.map((round) => <RecentRound key={round.id} round={round} />)
            )}
          </>
        )}
        {promotions ? <MultiBonusLadder bonus={promotions.multiBonus} /> : null}
      </div>
    </>
  );
}
