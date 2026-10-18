'use client';

import type { DailySummaryDetailResponse, RecomputeDailySummaryResponse } from '@vamos/contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useFetch } from '@/components/hooks';
import { useSession } from '@/components/session';
import { ActionButton, Badge, DefList, Loading, Notice, PageHeader } from '@/components/ui';
import { api } from '@/lib/api';
import { figureRows } from '@/lib/compliance';
import { formatDateTime, formatEtb } from '@/lib/format';

export default function DailySummaryPage() {
  const { date } = useParams<{ date: string }>();
  const { can } = useSession();
  const { data, error, loading, reload } = useFetch<DailySummaryDetailResponse>(
    `/admin/compliance/daily-summaries/${date}`,
  );
  const [outcome, setOutcome] = useState<string | null>(null);
  const s = data?.summary ?? null;

  return (
    <>
      <PageHeader title={`Summary ${date}`}>
        <Link href="/compliance">Back to summaries</Link>
      </PageHeader>
      <Loading loading={loading && data === null} error={error} />
      {s !== null && (
        <>
          <section className="panel">
            <DefList
              rows={[
                [
                  'Status',
                  <Badge key="s" value={s.status} tone={s.status === 'final' ? 'good' : 'warn'} />,
                ],
                ['Version', String(s.version)],
                ['Window', `${formatDateTime(s.windowStart)} to ${formatDateTime(s.windowEnd)}`],
                ['Computed', formatDateTime(s.computedAt)],
                [
                  'Finalised',
                  s.finalizedAt === null
                    ? '–'
                    : `${formatDateTime(s.finalizedAt)} by ${s.finalizedBy ?? ''}`,
                ],
                ['Hash', <code key="h">{s.hash}</code>],
                ...figureRows(s),
              ]}
            />
            {s.status === 'provisional' && can('reconciliation.run') && (
              <ActionButton
                label="Recompute from ledger"
                onAction={async () => {
                  const result = await api<RecomputeDailySummaryResponse>(
                    `/admin/compliance/daily-summaries/${date}/recompute`,
                    { method: 'POST', body: {} },
                  );
                  setOutcome(result.outcome);
                  reload();
                }}
              />
            )}
            {outcome !== null && <Notice kind="ok">Recompute: {outcome}</Notice>}
          </section>
          <h2>Versions</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Reason</th>
                  <th>Computed</th>
                  <th>By</th>
                  <th className="num">Turnover</th>
                  <th className="num">GGR</th>
                  <th className="num">Commission</th>
                </tr>
              </thead>
              <tbody>
                {data?.versions.map((v) => (
                  <tr key={v.version}>
                    <td>{v.version}</td>
                    <td>{v.reason}</td>
                    <td>{formatDateTime(v.computedAt)}</td>
                    <td>{v.computedBy}</td>
                    <td className="num">{formatEtb(v.figures.turnover)}</td>
                    <td className="num">{formatEtb(v.figures.ggr)}</td>
                    <td className="num">{formatEtb(v.figures.commissionDue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
