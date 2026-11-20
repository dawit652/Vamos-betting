'use client';

import type { AgentStatementListResponse, AgentStatementView } from '@vamos/contracts';
import { useState } from 'react';
import { useFetch } from '@/components/hooks';
import { useSession } from '@/components/session';
import { Badge, Field, Loading, Notice, PageHeader } from '@/components/ui';
import { api } from '@/lib/api';
import { describeError } from '@/lib/errors';
import { formatDateTime, formatEtb } from '@/lib/format';
import { bpsToPercentText, statementsCsv, weekOptions } from '@/lib/statements';

function MarkPaid({ statement, onDone }: { statement: AgentStatementView; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mark = async () => {
    const reference = window.prompt(
      `Payment reference for agent ${statement.agentNumber} (3 to 100 characters)`,
    );
    if (reference === null) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/admin/agent-statements/${statement.id}/paid`, {
        method: 'POST',
        body: { reference: reference.trim() },
      });
      onDone();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span>
      <button type="button" data-testid="statement-mark-paid" disabled={busy} onClick={mark}>
        Mark paid
      </button>
      {error !== null && <Notice>{error}</Notice>}
    </span>
  );
}

function downloadCsv(week: string, rows: readonly AgentStatementView[]) {
  const blob = new Blob([statementsCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `statements-${week}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export default function StatementsPage() {
  const [week, setWeek] = useState<string | null>(null);
  const { data, error, loading, reload } = useFetch<AgentStatementListResponse>(
    '/admin/agent-statements',
    week === null ? undefined : { week },
  );
  const { can } = useSession();
  const manage = can('agents.manage');
  const shown = data?.weekStart ?? week;
  const options = shown === null ? [] : weekOptions(shown);
  if (week !== null && !options.includes(week)) options.unshift(week);

  return (
    <div data-testid="statements-page">
      <PageHeader title="Weekly statements">
        {shown !== null && (
          <>
            <Field label="Week starting (Monday)">
              <select
                data-testid="statements-week"
                value={week ?? shown}
                onChange={(e) => setWeek(e.target.value)}
              >
                {options.map((w) => (
                  <option key={w} value={w}>
                    {w}
                  </option>
                ))}
              </select>
            </Field>
            <button
              type="button"
              data-testid="statements-csv"
              disabled={data === null || data.items.length === 0}
              onClick={() => data !== null && downloadCsv(shown, data.items)}
            >
              Export CSV
            </button>
          </>
        )}
      </PageHeader>
      <p className="muted small">
        Weeks run Monday to Monday, Addis Ababa time. Commission is paid outside the system; mark it
        paid with the payment reference.
      </p>
      <Loading loading={loading && data === null} error={error} />
      {data !== null && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Name</th>
                <th>Sold</th>
                <th>Cancelled</th>
                <th>GGR</th>
                <th>Paid out</th>
                <th>Player cash in</th>
                <th>Player cash out</th>
                <th>Balance start</th>
                <th>Balance end</th>
                <th>Commission</th>
                <th>Amount</th>
                <th>Paid</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((s) => (
                <tr key={s.id} data-testid="statement-row">
                  <td>{s.agentNumber}</td>
                  <td>{s.agentName}</td>
                  <td>{formatEtb(s.soldStakes)}</td>
                  <td>{formatEtb(s.cancelledStakes)}</td>
                  <td>{formatEtb(s.ggr)}</td>
                  <td>{formatEtb(s.paidAmount)}</td>
                  <td>{formatEtb(s.playerCashIn)}</td>
                  <td>{formatEtb(s.playerCashOut)}</td>
                  <td>{formatEtb(s.balanceStart)}</td>
                  <td>{formatEtb(s.balanceEnd)}</td>
                  <td>
                    {bpsToPercentText(s.commissionBps)}% of{' '}
                    {s.commissionKind === 'ggr' ? 'GGR' : 'stake'}
                  </td>
                  <td>{formatEtb(s.commission)}</td>
                  <td>
                    {s.paidAt !== null ? (
                      <>
                        <Badge value="Paid" tone="good" />
                        <br />
                        <span className="small muted">
                          {formatDateTime(s.paidAt)} · {s.paidReference}
                        </span>
                      </>
                    ) : (
                      <>
                        <Badge value="Unpaid" />{' '}
                        {manage && <MarkPaid statement={s} onDone={reload} />}
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {data.items.length === 0 && (
                <tr>
                  <td colSpan={13} className="muted">
                    No statements for this week yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
