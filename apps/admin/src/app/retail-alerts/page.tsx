'use client';

import type {
  RetailAlertListResponse,
  RetailAlertThresholds,
  RetailAlertView,
} from '@vamos/contracts';
import { type FormEvent, useState } from 'react';
import { useFetch } from '@/components/hooks';
import { useSession } from '@/components/session';
import { ActionButton, Badge, Field, Loading, Notice, PageHeader } from '@/components/ui';
import { api } from '@/lib/api';
import { describeError } from '@/lib/errors';
import { formatDateTime, formatEtb, formatSantim, parseEtbToSantim } from '@/lib/format';
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
      <Thresholds />
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

/** The big-win and low-balance thresholds the worker's scan uses (agents.manage changes them). */
function Thresholds() {
  const { can } = useSession();
  const current = useFetch<RetailAlertThresholds>('/admin/retail/alert-thresholds');
  if (current.data === null) {
    return <Loading loading={current.loading} error={current.error} />;
  }
  return (
    <ThresholdsForm
      key={`${current.data.bigWin}-${current.data.lowBalance}`}
      data={current.data}
      manage={can('agents.manage')}
      onSaved={current.reload}
    />
  );
}

function ThresholdsForm({
  data,
  manage,
  onSaved,
}: {
  data: RetailAlertThresholds;
  manage: boolean;
  onSaved: () => void;
}) {
  const [bigWin, setBigWin] = useState(() => formatSantim(data.bigWin).replace(/,/g, ''));
  const [lowBalance, setLowBalance] = useState(() =>
    formatSantim(data.lowBalance).replace(/,/g, ''),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const body = { bigWin: parseEtbToSantim(bigWin), lowBalance: parseEtbToSantim(lowBalance) };
    if ([body.bigWin, body.lowBalance].some((v) => v === null || v === '0')) {
      return setError('Enter both amounts in ETB, above zero.');
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api('/admin/retail/alert-thresholds', { method: 'PUT', body });
      setSaved(true);
      onSaved();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="card"
      autoComplete="off"
      aria-label="Alert thresholds"
      data-testid="alert-thresholds"
      onSubmit={submit}
    >
      <h2>Alert thresholds</h2>
      <p className="muted small">
        A ticket that wins more than the big-win amount, and an agent whose balance falls below the
        low-balance amount, raise an alert. Now: big win {formatEtb(data.bigWin)}, low balance{' '}
        {formatEtb(data.lowBalance)}.
      </p>
      <div className="row">
        <Field label="Big win (ETB)">
          <input
            inputMode="decimal"
            disabled={!manage}
            data-testid="threshold-big-win"
            value={bigWin}
            onChange={(e) => setBigWin(e.target.value)}
          />
        </Field>
        <Field label="Low balance (ETB)">
          <input
            inputMode="decimal"
            disabled={!manage}
            data-testid="threshold-low-balance"
            value={lowBalance}
            onChange={(e) => setLowBalance(e.target.value)}
          />
        </Field>
      </div>
      {error !== null && <Notice>{error}</Notice>}
      {saved && <Notice kind="ok">Saved.</Notice>}
      {manage && (
        <p>
          <button type="submit" className="primary" disabled={busy} data-testid="thresholds-save">
            Save thresholds
          </button>
        </p>
      )}
    </form>
  );
}
