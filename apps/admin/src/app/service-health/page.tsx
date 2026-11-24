'use client';

import type { ServiceHealthResponse } from '@vamos/contracts';
import { useEffect } from 'react';
import { useFetch } from '@/components/hooks';
import { Badge, Loading, PageHeader } from '@/components/ui';
import { formatDateTime } from '@/lib/format';

/**
 * Service health (docs/plans/counter-codes-and-deposit-recovery.md, G7): green, red and since when,
 * per service, judged like the worker's watch that sends the owner's Telegram "down" alerts.
 * Refreshes every minute.
 */

const TONE = { up: 'good', down: 'bad', unknown: 'muted', off: 'muted' } as const;
const WORD = {
  up: 'Up',
  down: 'Down',
  unknown: 'Not reported yet',
  off: 'Switched off (no alerts)',
} as const;

export default function ServiceHealthPage() {
  const view = useFetch<ServiceHealthResponse>('/admin/service-health');
  const { reload } = view;
  useEffect(() => {
    const timer = setInterval(reload, 60_000);
    return () => clearInterval(timer);
  }, [reload]);
  const data = view.data;
  return (
    <>
      <PageHeader title="Service health" />
      <Loading loading={view.loading && data === null} error={view.error} />
      {data === null ? null : (
        <div className="table-wrap" data-testid="service-health">
          <p className="muted small">
            Checked {formatDateTime(data.checkedAt)}. A service failing for 3 minutes is down; the
            owner then gets a Telegram alert every 15 minutes until it works again.
          </p>
          <table>
            <thead>
              <tr>
                <th>Service</th>
                <th>State</th>
                <th>Last worked</th>
                <th>Last error</th>
              </tr>
            </thead>
            <tbody>
              {data.services.length === 0 ? (
                <tr>
                  <td colSpan={4} className="muted">
                    No service has reported yet.
                  </td>
                </tr>
              ) : null}
              {data.services.map((s) => (
                <tr key={s.service} data-testid="service-row">
                  <td>{s.name}</td>
                  <td>
                    <Badge value={WORD[s.status]} tone={TONE[s.status]} />
                    {s.since === null ? null : (
                      <span className="muted small"> since {formatDateTime(s.since)}</span>
                    )}
                  </td>
                  <td>{s.lastOkAt === null ? '–' : formatDateTime(s.lastOkAt)}</td>
                  <td className="small">
                    {s.lastError === null
                      ? '–'
                      : `${s.lastError}${s.lastFailureAt === null ? '' : ` (${formatDateTime(s.lastFailureAt)})`}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
