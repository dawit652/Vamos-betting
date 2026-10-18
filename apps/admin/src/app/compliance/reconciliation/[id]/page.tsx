'use client';

import type { ReconciliationRunDetailResponse } from '@vamos/contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useFetch } from '@/components/hooks';
import { Badge, DefList, Loading, PageHeader } from '@/components/ui';
import { describeMismatch, diffSantim } from '@/lib/compliance';
import { formatDateTime, humanize } from '@/lib/format';

export default function ReconciliationRunPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, loading } = useFetch<ReconciliationRunDetailResponse>(
    `/admin/compliance/reconciliation-runs/${id}`,
  );
  const run = data?.run ?? null;
  return (
    <>
      <PageHeader title="Reconciliation run">
        <Link href="/compliance/reconciliation">Back to runs</Link>
      </PageHeader>
      <Loading loading={loading && data === null} error={error} />
      {run !== null && data !== null && (
        <>
          <section className="panel">
            <DefList
              rows={[
                [
                  'Status',
                  <Badge
                    key="s"
                    value={run.status}
                    tone={
                      run.status === 'clean' ? 'good' : run.status === 'failed' ? 'bad' : 'warn'
                    }
                  />,
                ],
                ['Kind', humanize(run.kind)],
                ['Payment day', run.businessDate ?? '–'],
                ['Triggered by', run.triggeredBy],
                ['Started', formatDateTime(run.startedAt)],
                ['Finished', formatDateTime(run.finishedAt)],
                ['Mismatches', String(run.mismatchCount)],
                ['Error', run.error ?? '–'],
              ]}
            />
          </section>
          <h2>Checks</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Check</th>
                  <th>Result</th>
                  <th className="num">Checked</th>
                  <th className="num">Mismatches</th>
                </tr>
              </thead>
              <tbody>
                {run.checks.map((c) => (
                  <tr key={c.check}>
                    <td>{humanize(c.check)}</td>
                    <td>
                      <Badge value={c.ok ? 'ok' : 'failed'} tone={c.ok ? 'good' : 'bad'} />
                    </td>
                    <td className="num">{c.checked}</td>
                    <td className="num">{c.mismatches}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h2>Mismatches</h2>
          {data.mismatches.length === 0 && <p className="muted">None.</p>}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Check</th>
                  <th>Subject</th>
                  <th className="num">Expected</th>
                  <th className="num">Actual</th>
                  <th className="num">Difference</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {data.mismatches.map((m) => (
                  <tr key={m.id} title={describeMismatch(m)}>
                    <td>{humanize(m.check)}</td>
                    <td>
                      {humanize(m.subjectType)} <code>{m.subjectId}</code>
                    </td>
                    <td className="num">{m.expected ?? '–'}</td>
                    <td className="num">{m.actual ?? '–'}</td>
                    <td className="num">{diffSantim(m.expected, m.actual) ?? '–'}</td>
                    <td>
                      <code className="small">{JSON.stringify(m.details)}</code>
                    </td>
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
