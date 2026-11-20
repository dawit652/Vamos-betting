'use client';

import type { RetailAlertListResponse, RetailAlertView } from '@vamos/contracts';
import { useState } from 'react';
import { useFetch } from '@/components/hooks';
import { ActionButton, Badge, Loading, PageHeader } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { alertDetailLines, alertKindLabel } from '@/lib/statements';

export default function RetailAlertsPage() {
  const [openOnly, setOpenOnly] = useState(true);
  const { data, error, loading, reload } = useFetch<RetailAlertListResponse>(
    '/admin/retail/alerts',
    { open: openOnly ? 'true' : 'false' },
  );
  const acknowledge = async (alert: RetailAlertView) => {
    await api(`/admin/retail/alerts/${alert.id}/acknowledge`, { method: 'POST' });
    reload();
  };
  return (
    <div data-testid="alerts-page">
      <PageHeader title="Shop alerts">
        <button
          type="button"
          data-testid="alerts-open-toggle"
          aria-pressed={!openOnly}
          onClick={() => setOpenOnly((v) => !v)}
        >
          {openOnly ? 'Showing open · show all' : 'Showing all · show open only'}
        </button>
      </PageHeader>
      <Loading loading={loading && data === null} error={error} />
      {data !== null && (
        <>
          <p className="muted small">
            {openOnly ? `${data.items.length} open` : `${data.items.length} alerts`}
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Raised</th>
                  <th>Alert</th>
                  <th>Details</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((a) => (
                  <tr key={a.id} data-testid="alert-row">
                    <td>{formatDateTime(a.createdAt)}</td>
                    <td>{alertKindLabel(a.kind)}</td>
                    <td>
                      {alertDetailLines(a.details).map((line) => (
                        <div key={line} className="small">
                          {line}
                        </div>
                      ))}
                    </td>
                    <td>
                      {a.acknowledgedAt === null ? (
                        <span data-testid="alert-ack">
                          <ActionButton label="Acknowledge" onAction={() => acknowledge(a)} />
                        </span>
                      ) : (
                        <>
                          <Badge value="Seen" tone="good" />
                          <br />
                          <span className="small muted">{formatDateTime(a.acknowledgedAt)}</span>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
                {data.items.length === 0 && (
                  <tr>
                    <td colSpan={4} className="muted">
                      {openOnly ? 'No open alerts.' : 'No alerts.'}
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
