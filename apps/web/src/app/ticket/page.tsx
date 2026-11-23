import type { Metadata } from 'next';
import { StaticPage } from '@/components/account/StaticPage';
import { TicketCheck } from '@/components/ticket/TicketCheck';
import { getT } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('common.ticketCheck.title') };
}

function firstValue(value: string | string[] | undefined): string {
  const first = Array.isArray(value) ? value[0] : value;
  return (first ?? '').trim().slice(0, 24);
}

/**
 * Check coupon without logging in (docs/plans/guest-slips-and-staff.md, GS4; shop tickets since
 * docs/plans/counter-codes-and-deposit-recovery.md, G3): a slip ID's state, or a shop ticket's
 * state, what it pays and the shop that pays it. Never a payout code. `?number=` is checked at once.
 */
export default async function TicketCheckPage(props: PageProps<'/ticket'>) {
  const [searchParams, t] = await Promise.all([props.searchParams, getT()]);
  return (
    <StaticPage title={t('common.ticketCheck.title')} intro={t('common.ticketCheck.intro')}>
      <TicketCheck initial={firstValue(searchParams.number)} />
    </StaticPage>
  );
}
