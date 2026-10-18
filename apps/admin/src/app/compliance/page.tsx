'use client';

import type {
  ComplianceSettingsResponse,
  DailySummaryListResponse,
  ElsReportStatusResponse,
} from '@vamos/contracts';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { useFetch } from '@/components/hooks';
import { useSession } from '@/components/session';
import { Badge, DefList, Loading, Notice, PageHeader } from '@/components/ui';
import { apiText } from '@/lib/api';
import { formatBps, summaryCsvName, validateReportRange } from '@/lib/compliance';
import { describeError } from '@/lib/errors';
import { formatDateTime, formatEtb, toDay } from '@/lib/format';

function CsvDownload() {
  const today = new Date();
  const monthAgo = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 30);
  const [from, setFrom] = useState(toDay(monthAgo));
  const [to, setTo] = useState(toDay(today));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const problem = validateReportRange(from, to);
    if (problem !== null) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const text = await apiText('/admin/compliance/daily-summaries.csv', { from, to });
      const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = summaryCsvName(from, to);
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="inline-form" onSubmit={submit}>
      <input aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)} />
      <input aria-label="To" value={to} onChange={(e) => setTo(e.target.value)} />
      <button type="submit" disabled={busy}>
        Download CSV
      </button>
      {error !== null && <Notice>{error}</Notice>}
    </form>
  );
}

function ElsPanel() {
  const els = useFetch<ElsReportStatusResponse>('/admin/compliance/els');
  const d = els.data;
  return (
    <section className="panel">
      <h2>ELS transaction stream</h2>
      <Loading loading={els.loading && d === null} error={els.error} />
      {d !== null && (
        <DefList
          rows={[
            [
              'Reporter',
              d.reporter === null
                ? 'not configured'
                : `${d.reporter.mode} – ${d.reporter.ready ? 'ready' : 'not ready'} (${d.reporter.detail})`,
            ],
            ['Target', d.reporter?.target ?? '–'],
            ['Events written', String(d.written)],
            [
              'Events pending',
              d.pending > 0 ? <Badge key="p" value={`${d.pending} pending`} tone="warn" /> : '0',
            ],
            ['Last written', formatDateTime(d.lastWrittenAt)],
            ['Oldest pending', formatDateTime(d.oldestPendingAt)],
            ['Last error', d.lastError ?? '–'],
          ]}
        />
      )}
    </section>
  );
}

export default function CompliancePage() {
  const { can } = useSession();
  const list = useFetch<DailySummaryListResponse>('/admin/compliance/daily-summaries', {
    limit: 31,
  });
  const settings = useFetch<ComplianceSettingsResponse>('/admin/compliance/settings');
  return (
    <>
      <PageHeader title="Daily summaries">
        {can('reconciliation.run') && <Link href="/compliance/reconciliation">Reconciliation</Link>}
      </PageHeader>
      <p className="muted">
        Business days run midnight to midnight in Addis Ababa (UTC+3). Figures come from ledger
        postings. A provisional day can still change; a final day never does.
        {settings.data !== null &&
          ` ELS commission rate: ${formatBps(settings.data.settings.elsCommission.rateBps)} of positive GGR (to confirm with counsel).`}
      </p>
      <CsvDownload />
      <Loading loading={list.loading && list.data === null} error={list.error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Day</th>
              <th>Status</th>
              <th className="num">Turnover</th>
              <th className="num">Payouts</th>
              <th className="num">GGR</th>
              <th className="num">Tax</th>
              <th className="num">Commission</th>
              <th className="num">Active players</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.items.map((s) => (
              <tr key={s.businessDate}>
                <td>
                  <Link href={`/compliance/${s.businessDate}`}>{s.businessDate}</Link>
                </td>
                <td>
                  <Badge value={s.status} tone={s.status === 'final' ? 'good' : 'warn'} />
                </td>
                <td className="num">{formatEtb(s.turnover)}</td>
                <td className="num">{formatEtb(s.payouts)}</td>
                <td className="num">{formatEtb(s.ggr)}</td>
                <td className="num">{formatEtb(s.taxWithheld)}</td>
                <td className="num">{formatEtb(s.commissionDue)}</td>
                <td className="num">{s.activePlayers}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.data !== null && list.data.items.length === 0 && (
        <p className="muted">No summaries yet.</p>
      )}
      <ElsPanel />
    </>
  );
}
