'use client';

import type { AmlFlagDetailResponse, AmlFlagView, ReviewAmlFlagResponse } from '@vamos/contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useFetch } from '@/components/hooks';
import { Badge, DefList, Loading, PageHeader, ReasonAction } from '@/components/ui';
import { api } from '@/lib/api';
import { reviewDecisions } from '@/lib/compliance';
import { formatDateTime, humanize } from '@/lib/format';

function tone(status: string) {
  return status === 'open' || status === 'escalated' ? 'warn' : 'muted';
}

export default function AmlFlagPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, loading, reload } = useFetch<AmlFlagDetailResponse>(
    `/admin/compliance/aml-flags/${id}`,
  );
  const flag: AmlFlagView | null = data?.flag ?? null;

  const review = async (decision: string, note: string) => {
    await api<ReviewAmlFlagResponse>(`/admin/compliance/aml-flags/${id}/review`, {
      method: 'POST',
      body: { decision, note },
    });
    reload();
  };

  return (
    <>
      <PageHeader title="AML flag">
        <Link href="/compliance/aml">Back to flags</Link>
      </PageHeader>
      <Loading loading={loading && data === null} error={error} />
      {flag !== null && data !== null && (
        <>
          <section className="panel">
            <DefList
              rows={[
                ['Rule', humanize(flag.rule)],
                [
                  'Severity',
                  <Badge
                    key="v"
                    value={flag.severity}
                    tone={flag.severity === 'high' ? 'bad' : 'warn'}
                  />,
                ],
                ['Status', <Badge key="s" value={flag.status} tone={tone(flag.status)} />],
                [
                  'Player',
                  <Link key="p" href={`/users/${flag.userId}`}>
                    {flag.userId}
                  </Link>,
                ],
                ['Window', flag.windowKey],
                ['Raised', `${formatDateTime(flag.triggeredAt)} (${flag.source})`],
                [
                  'Reviewed',
                  flag.reviewedAt === null
                    ? '–'
                    : `${formatDateTime(flag.reviewedAt)} by ${flag.reviewedBy ?? ''}`,
                ],
                ['Note', flag.reviewNote ?? '–'],
                [
                  'Held withdrawals',
                  data.heldWithdrawals.length === 0 ? (
                    '–'
                  ) : (
                    <Link key="w" href="/withdrawals">
                      {data.heldWithdrawals.length} waiting for staff
                    </Link>
                  ),
                ],
              ]}
            />
            <pre className="small">{JSON.stringify(flag.details, null, 2)}</pre>
            <div className="actions">
              {reviewDecisions(flag.status).map((decision) => (
                <ReasonAction
                  key={decision}
                  label={humanize(decision)}
                  prompt="Note (required)"
                  danger={decision === 'escalated'}
                  onSubmit={(note) => review(decision, note)}
                />
              ))}
            </div>
          </section>
          <h2>Other flags of this player</h2>
          {data.otherFlags.length === 0 && <p className="muted">None.</p>}
          <ul>
            {data.otherFlags.map((f) => (
              <li key={f.id}>
                <Link href={`/compliance/aml/${f.id}`}>
                  {humanize(f.rule)} {f.windowKey}
                </Link>{' '}
                <Badge value={f.status} tone={tone(f.status)} />
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
