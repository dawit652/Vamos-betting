'use client';

import type {
  ImportPspStatementResponse,
  PspStatementView,
  ReconciliationRequestResponse,
  ReconciliationRunDetailResponse,
  ReconciliationRunView,
} from '@vamos/contracts';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { usePaged } from '@/components/hooks';
import { useSession } from '@/components/session';
import { Badge, LoadMore, Loading, Notice, PageHeader } from '@/components/ui';
import { api } from '@/lib/api';
import {
  failedChecks,
  isBusinessDate,
  RECONCILIATION_POLL_LIMIT_MS,
  RECONCILIATION_POLL_MS,
  reconciliationRequestMessage,
  validateStatementUpload,
} from '@/lib/compliance';
import { describeError } from '@/lib/errors';
import { formatDateTime, formatEtb } from '@/lib/format';

const statusTone = (s: string) => (s === 'clean' ? 'good' : s === 'failed' ? 'bad' : 'warn');

/**
 * "Run now": the API queues the run (202) and the worker runs it off the
 * request path; the form polls the request until it is done (then shows the
 * run's outcome and links to it) or failed.
 */
function RunNow({ onDone }: { onDone: () => void }) {
  const [date, setDate] = useState('');
  const [message, setMessage] = useState<{
    kind: 'ok' | 'error' | 'pending';
    text: string;
  } | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (date.trim() !== '' && !isBusinessDate(date.trim())) {
      setMessage({
        kind: 'error',
        text: 'Enter the day as YYYY-MM-DD, or leave it empty for today.',
      });
      return;
    }
    setBusy(true);
    setMessage(null);
    setRunId(null);
    try {
      let { request } = await api<ReconciliationRequestResponse>(
        '/admin/compliance/reconciliation-runs',
        { method: 'POST', body: date.trim() === '' ? {} : { businessDate: date.trim() } },
      );
      setMessage(reconciliationRequestMessage(request));
      const deadline = Date.now() + RECONCILIATION_POLL_LIMIT_MS;
      while (
        (request.status === 'queued' || request.status === 'running') &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, RECONCILIATION_POLL_MS));
        ({ request } = await api<ReconciliationRequestResponse>(
          `/admin/compliance/reconciliation-requests/${request.id}`,
        ));
        setMessage(reconciliationRequestMessage(request));
      }
      if (request.status === 'done' && request.runId !== null) {
        const detail = await api<ReconciliationRunDetailResponse>(
          `/admin/compliance/reconciliation-runs/${request.runId}`,
        );
        setMessage(reconciliationRequestMessage(request, detail.run));
        setRunId(detail.run.id);
      } else if (request.status === 'queued' || request.status === 'running') {
        setMessage({
          kind: 'error',
          text: 'Still running after 10 minutes: check the list of runs later.',
        });
      }
      onDone();
    } catch (e) {
      setMessage({ kind: 'error', text: describeError(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="inline-form" onSubmit={submit}>
      <input
        aria-label="Payment day"
        placeholder="Payment day (YYYY-MM-DD, default today)"
        value={date}
        onChange={(e) => setDate(e.target.value)}
      />
      <button type="submit" className="primary" disabled={busy}>
        {busy ? 'Running…' : 'Run reconciliation now'}
      </button>
      {message !== null && (
        <Notice kind={message.kind === 'pending' ? 'info' : message.kind}>
          {message.text}
          {runId !== null && (
            <>
              {' '}
              <Link href={`/compliance/reconciliation/${runId}`}>Open the run</Link>
            </>
          )}
        </Notice>
      )}
    </form>
  );
}

function StatementUpload({ onDone }: { onDone: () => void }) {
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [provider, setProvider] = useState('');
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const problem = validateStatementUpload({ csv, provider });
    if (problem !== null) {
      setMessage({ kind: 'error', text: problem });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const result = await api<ImportPspStatementResponse>('/admin/compliance/psp-statements', {
        method: 'POST',
        body: {
          csv,
          ...(fileName !== '' ? { fileName } : {}),
          ...(provider.trim() !== '' ? { provider: provider.trim() } : {}),
        },
      });
      setMessage({
        kind: result.run.status === 'clean' ? 'ok' : 'error',
        text: `Imported ${result.statement.lineCount} lines: ${result.run.mismatchCount} differences.`,
      });
      setCsv('');
      setFileName('');
      onDone();
    } catch (e) {
      setMessage({ kind: 'error', text: describeError(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel" onSubmit={submit}>
      <h2>Upload a PSP statement</h2>
      <p className="muted small">
        CSV columns: provider, reference, amount (birr), date; optional type (deposit or payout).
        Every line must match exactly one payment record, and every record one line.
      </p>
      <div className="inline-form">
        <input
          type="file"
          accept=".csv,text/csv"
          aria-label="Statement file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file === undefined) return;
            setFileName(file.name);
            void file.text().then(setCsv);
          }}
        />
        <input
          aria-label="Provider"
          placeholder="Provider (optional)"
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
        />
        <button type="submit" disabled={busy}>
          {busy ? 'Uploading…' : 'Upload and match'}
        </button>
      </div>
      {message !== null && <Notice kind={message.kind}>{message.text}</Notice>}
    </form>
  );
}

export default function ReconciliationPage() {
  const { can } = useSession();
  const runs = usePaged<ReconciliationRunView>('/admin/compliance/reconciliation-runs');
  const statements = usePaged<PspStatementView>('/admin/compliance/psp-statements', { limit: 10 });
  const manage = can('reconciliation.run');
  const reloadAll = () => {
    runs.reload();
    statements.reload();
  };
  return (
    <>
      <PageHeader title="Reconciliation" />
      <p className="muted">
        Ledger integrity, wallets, house accounts and payment-provider movements are checked daily.
        A mismatch raises an alert and is audited.
      </p>
      {manage && <RunNow onDone={reloadAll} />}
      <Loading loading={runs.loading && runs.items.length === 0} error={runs.error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Run</th>
              <th>Kind</th>
              <th>Status</th>
              <th>Day</th>
              <th className="num">Mismatches</th>
              <th>Failed checks</th>
              <th>Started</th>
            </tr>
          </thead>
          <tbody>
            {runs.items.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link href={`/compliance/reconciliation/${r.id}`}>{r.id.slice(0, 8)}</Link>
                </td>
                <td>{r.kind.replace(/_/g, ' ')}</td>
                <td>
                  <Badge value={r.status} tone={statusTone(r.status)} />
                </td>
                <td>{r.businessDate ?? '–'}</td>
                <td className="num">{r.mismatchCount}</td>
                <td>{failedChecks(r).join(', ') || '–'}</td>
                <td>{formatDateTime(r.startedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <LoadMore hasMore={runs.hasMore} loading={runs.loading} onMore={runs.loadMore} />
      {manage && <StatementUpload onDone={reloadAll} />}
      <h2>PSP statements</h2>
      <Loading
        loading={statements.loading && statements.items.length === 0}
        error={statements.error}
      />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Uploaded</th>
              <th>File</th>
              <th>Providers</th>
              <th>Period</th>
              <th className="num">Lines</th>
              <th className="num">In</th>
              <th className="num">Out</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {statements.items.map((s) => (
              <tr key={s.id}>
                <td>{formatDateTime(s.uploadedAt)}</td>
                <td>{s.fileName ?? '–'}</td>
                <td>{s.providers.join(', ')}</td>
                <td>
                  {s.periodFrom} to {s.periodTo}
                </td>
                <td className="num">{s.lineCount}</td>
                <td className="num">{formatEtb(s.totalIn)}</td>
                <td className="num">{formatEtb(s.totalOut)}</td>
                <td>
                  {s.runId !== null && s.status !== null ? (
                    <Link href={`/compliance/reconciliation/${s.runId}`}>
                      <Badge value={s.status} tone={statusTone(s.status)} />
                      {s.mismatchCount ? ` ${s.mismatchCount}` : ''}
                    </Link>
                  ) : (
                    '–'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <LoadMore
        hasMore={statements.hasMore}
        loading={statements.loading}
        onMore={statements.loadMore}
      />
    </>
  );
}
