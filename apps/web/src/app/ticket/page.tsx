import type { Metadata } from 'next';
import { StaticPage } from '@/components/account/StaticPage';
import { TicketCheck } from '@/components/ticket/TicketCheck';
import { getT } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('common.ticketCheck.title') };
}

/**
 * Checks a shop ticket without logging in (docs/plans/counter-codes-and-deposit-recovery.md, G3):
 * its state, what it pays and the shop that pays it. Never its payout code.
 */
export default async function TicketCheckPage() {
  const t = await getT();
  return (
    <StaticPage title={t('common.ticketCheck.title')} intro={t('common.ticketCheck.intro')}>
      <TicketCheck />
    </StaticPage>
  );
}
