'use client';

import type { RetailMonitorResponse } from '@vamos/contracts';
import { useCallback, useEffect, useState } from 'react';
import { Badge, Field, Loading, PageHeader } from '@/components/ui';
import { api } from '@/lib/api';
import { describeError } from '@/lib/errors';
import { formatDateTime, formatEtb } from '@/lib/format';

const POLL_MS = 15_000;

export default function RetailMonitorPage() {
  const [agentId, setAgentId] = useState('');
  const [data, setData] = useState<RetailMonitorResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  // The agent list comes from the response, so it must survive a filtered reload.
  const [agentChoices, setAgentChoices] = useState<RetailMonitorResponse['agents']>([]);

  const load = useCallback(
    async (signal: AbortSignal) => {
      try {
        const result = await api<RetailMonitorResponse>('/admin/retail/monitor', {
          query: agentId === '' ? { limit: 50 } : { agentId, limit: 50 },
          signal,
        });
        setData(result);
        setError(null);
        setUpdatedAt(new Date());
        if (agentId === '') setAgentChoices(result.agents);
      } catch (e) {
        if (!signal.aborted) setError(describeError(e));
      }
    },
    [agentId],
  );

  useEffect(() => {
    let controller = new AbortController();
    const run = () => {
      controller.abort();
      controller = new AbortController();
      void load(controller.signal);
    };
    run();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') run();
    }, POLL_MS);
    // Catch up at once when the tab comes back.
    const onVisible = () => {
      if (document.visibilityState === 'visible') run();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      controller.abort();
    };
  }, [load]);

  const agents =
    data === null
      ? []
      : agentId === ''
        ? data.agents
        : data.agents.filter((a) => a.agentId === agentId);

  return (
    <div data-testid="monitor-page">
      <PageHeader title="Shop monitor">
        <Field label="Agent">
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">All agents</option>
            {agentChoices.map((a) => (
              <option key={a.agentId} value={a.agentId}>
                {a.agentNumber} · {a.agentName}
              </option>
            ))}
          </select>
        </Field>
        <span className="small muted" data-testid="monitor-updated">
          Last updated {updatedAt === null ? '–' : updatedAt.toLocaleTimeString()}
        </span>
      </PageHeader>
      <Loading loading={data === null && error === null} error={error} />
      {data !== null && (
        <>
          <h2>Today ({data.day})</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Status</th>
                  <th>Balance</th>
                  <th>Sold</th>
                  <th>Cancelled</th>
                  <th>Paid out</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((a) => (
                  <tr key={a.agentId} data-testid="monitor-agent-row">
                    <td>
                      {a.agentNumber} · {a.agentName}
                    </td>
                    <td>
                      <Badge
                        value={a.status === 'active' ? 'Active' : 'Blocked'}
                        tone={a.status === 'active' ? 'good' : 'bad'}
                      />
                    </td>
                    <td>{a.balance === null ? '—' : formatEtb(a.balance)}</td>
                    <td>
                      {a.ticketsSold} · {formatEtb(a.soldStakes)}
                    </td>
                    <td>
                      {a.ticketsCancelled} · {formatEtb(a.cancelledStakes)}
                    </td>
                    <td>
                      {a.ticketsPaid} · {formatEtb(a.paidAmount)}
                    </td>
                  </tr>
                ))}
                {agents.length === 0 && (
                  <tr>
                    <td colSpan={6} className="muted">
                      No agents.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <h2>Newest tickets</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Number</th>
                  <th>Shop</th>
                  <th>Cashier</th>
                  <th>Stake</th>
                  <th>Possible win</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.tickets.map((t) => (
                  <tr key={t.id} data-testid="monitor-ticket-row">
                    <td>{formatDateTime(t.soldAt)}</td>
                    <td>{t.number}</td>
                    <td>
                      {t.shopLabel} {t.shopName}
                    </td>
                    <td>{t.staffName}</td>
                    <td>{formatEtb(t.stake)}</td>
                    <td>{formatEtb(t.possibleWin)}</td>
                    <td>{t.status}</td>
                  </tr>
                ))}
                {data.tickets.length === 0 && (
                  <tr>
                    <td colSpan={7} className="muted">
                      No tickets yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
