'use client';

import type { PlayerDetailView, StaffLimitSlotView } from '@vamos/contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useFetch } from '@/components/hooks';
import { Badge, DefList, Loading, PageHeader } from '@/components/ui';
import { formatDateTime, formatEtb, formatOdds, humanize } from '@/lib/format';

function limit(slot: StaffLimitSlotView): string {
  const now = slot.amount === null ? 'none' : formatEtb(slot.amount);
  return slot.pending === null
    ? now
    : `${now} (raise to ${slot.pending.amount === null ? 'none' : formatEtb(slot.pending.amount)} from ${formatDateTime(slot.pending.effectiveFrom)})`;
}

export default function UserDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: p, error, loading } = useFetch<PlayerDetailView>(`/admin/users/${id}`);

  return (
    <>
      <PageHeader title={p === null ? 'Player' : `Player ${p.phone}`}>
        <Link href="/users">Back to players</Link>
      </PageHeader>
      <Loading loading={loading} error={error} />
      {p !== null && (
        <>
          <section className="panel">
            <DefList
              rows={[
                ['Name', p.fullName ?? '–'],
                ['Status', <Badge key="s" value={p.status} />],
                ['Date of birth', p.dateOfBirth],
                ['Phone verified', formatDateTime(p.phoneVerifiedAt)],
                ['Joined', formatDateTime(p.createdAt)],
                ['Cash balance', formatEtb(p.balances.cash)],
                ['Bonus balance', formatEtb(p.balances.bonus)],
                ['Wagering still to do', formatEtb(p.remainingWagering)],
                ['Open bets', `${p.openBets.count} (${formatEtb(p.openBets.amount)} staked)`],
              ]}
            />
          </section>
          <h2>KYC</h2>
          <section className="panel">
            <DefList
              rows={[
                ['Status', <Badge key="k" value={p.kyc.status} />],
                ['Provider', p.kyc.provider ?? '–'],
                ['ID number', p.kyc.idNumberLast4 === null ? '–' : `…${p.kyc.idNumberLast4}`],
                ['Verified name', p.kyc.verifiedName ?? '–'],
                ['Submitted', formatDateTime(p.kyc.submittedAt)],
                ['Reviewed', formatDateTime(p.kyc.reviewedAt)],
                ['Rejection reason', p.kyc.rejectionReason ?? '–'],
              ]}
            />
          </section>
          <h2>Limits and exclusions</h2>
          <section className="panel">
            <DefList
              rows={[
                ['Deposit / day', limit(p.limits.deposit.day)],
                ['Deposit / week', limit(p.limits.deposit.week)],
                ['Deposit / month', limit(p.limits.deposit.month)],
                ['Loss / day', limit(p.limits.loss.day)],
                ['Loss / week', limit(p.limits.loss.week)],
                ['Loss / month', limit(p.limits.loss.month)],
                ['Stake per bet', limit(p.limits.stake.bet)],
                [
                  'Active exclusion',
                  p.activeExclusion === null
                    ? 'none'
                    : `${humanize(p.activeExclusion.kind)} until ${formatDateTime(p.activeExclusion.endsAt)}`,
                ],
              ]}
            />
            {p.exclusions.length > 0 && (
              <ul>
                {p.exclusions.map((e) => (
                  <li key={e.createdAt}>
                    {humanize(e.kind)}: {formatDateTime(e.startsAt)} to {formatDateTime(e.endsAt)}
                    {e.reason !== null && ` (${e.reason})`}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <h2>Recent bets</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Bet</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th className="num">Stake</th>
                  <th className="num">Odds</th>
                  <th className="num">Potential net</th>
                  <th className="num">Settled net</th>
                  <th>Placed</th>
                </tr>
              </thead>
              <tbody>
                {p.recentBets.map((b) => (
                  <tr key={b.id}>
                    <td>
                      <Link href={`/bets?shortId=${b.shortId}`}>{b.shortId}</Link>
                    </td>
                    <td>{b.betType}</td>
                    <td>
                      <Badge value={b.status} />
                    </td>
                    <td className="num">{formatEtb(b.stake)}</td>
                    <td className="num">{formatOdds(b.totalOddsMilli)}</td>
                    <td className="num">{formatEtb(b.potentialNetPayout)}</td>
                    <td className="num">{formatEtb(b.settledNetPayout)}</td>
                    <td>{formatDateTime(b.placedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h2>Recent payments</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Provider</th>
                  <th className="num">Amount</th>
                  <th>Status</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {p.recentPayments.map((x) => (
                  <tr key={x.id}>
                    <td>{x.kind}</td>
                    <td>{x.provider}</td>
                    <td className="num">{formatEtb(x.amount)}</td>
                    <td>
                      <Badge value={x.status} />
                      {x.flagged && <Badge value="flagged" tone="warn" />}
                    </td>
                    <td>{formatDateTime(x.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h2>Recent cash transactions</h2>
          <pre className="panel small">{JSON.stringify(p.recentTransactions, null, 1)}</pre>
        </>
      )}
    </>
  );
}
