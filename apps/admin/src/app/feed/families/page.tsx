'use client';

import type {
  MarketFamilyRow,
  MarketFamilyStatesResponse,
  ResetMarketFamilyResponse,
} from '@vamos/contracts';
import Link from 'next/link';
import { useState } from 'react';
import { useFetch } from '@/components/hooks';
import { useSession } from '@/components/session';
import { ActionButton, Badge, Field, Loading, Notice, PageHeader } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

const pct = (bps: number): string => `${(bps / 100).toFixed(1)}%`;

/** True when the weekly job moved the family, so a person may reset it. */
const resettable = (f: MarketFamilyRow): boolean =>
  f.status !== 'active' || f.raisedMarginBps !== null;

function ResetForm({ row, onDone }: { row: MarketFamilyRow; onDone: () => void }) {
  const [reason, setReason] = useState('');
  return (
    <div className="card">
      <h3>Reset {row.family}</h3>
      <p className="muted small">
        It becomes active as if new from this week: no raised margin, priced at its settings margin,
        and the weekly job judges it again from next week. Open bets are not touched.
      </p>
      <Field label="Reason (kept in the audit log)">
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
      </Field>
      <ActionButton
        primary
        label="Reset the family"
        onAction={async () => {
          await api<ResetMarketFamilyResponse>(`/admin/feed/market-families/${row.family}/reset`, {
            method: 'POST',
            body: { reason },
          });
          onDone();
        }}
      />
    </div>
  );
}

export default function MarketFamiliesPage() {
  const { can } = useSession();
  const list = useFetch<MarketFamilyStatesResponse>('/admin/feed/market-families');
  const [resetting, setResetting] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const data = list.data;
  const canEdit = can('settings.edit');
  const row = data?.families.find((f) => f.family === resetting) ?? null;
  const moved = data?.families.filter(resettable) ?? [];

  return (
    <>
      <PageHeader title="Market families">
        <Link href="/feed">Back to feed</Link>
      </PageHeader>
      <p className="muted small">
        The market factory&apos;s families and what the weekly job did with them. Margins are set on
        the Settings page (&quot;Market families&quot;).
      </p>
      <Loading loading={list.loading && data === null} error={list.error} />
      {done !== null && <Notice kind="ok">{done} is active again.</Notice>}
      {data !== null && (
        <>
          <p className="small">
            First-half share:{' '}
            {data.firstHalfShare === null ? 'off (time-based)' : data.firstHalfShare.toFixed(3)}.
            Draw correction: {data.drawCorrection === null ? 'off' : data.drawCorrection.toFixed(3)}
            . History test:{' '}
            {data.historyTestedAt === null ? 'none stored' : formatDateTime(data.historyTestedAt)}.
            Moved by the job: {moved.length}.
          </p>
          {row !== null && canEdit && (
            <ResetForm
              key={row.family}
              row={row}
              onDone={() => {
                setDone(row.family);
                setResetting(null);
                list.reload();
              }}
            />
          )}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Family</th>
                  <th>Class</th>
                  <th>State</th>
                  <th>Since</th>
                  <th>Margin now</th>
                  <th>History test</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.families.map((f) => (
                  <tr key={f.family}>
                    <td>{f.family}</td>
                    <td>{f.marginClass}</td>
                    <td>
                      <Badge
                        value={f.status}
                        tone={f.status === 'active' ? 'good' : f.status === 'off' ? 'bad' : 'warn'}
                      />
                    </td>
                    <td>{f.sinceWeek ?? '–'}</td>
                    <td>
                      {pct(f.marginBps)}
                      {f.raisedMarginBps !== null ? ' (raised)' : ''}
                    </td>
                    <td>
                      {f.history === null
                        ? '–'
                        : `${f.history.passed ? 'passed' : 'failed'}, suggests ${pct(f.history.suggestedMarginBps)}`}
                    </td>
                    <td>
                      {canEdit && resettable(f) && (
                        <button
                          type="button"
                          onClick={() => {
                            setDone(null);
                            setResetting(f.family);
                          }}
                        >
                          Reset
                        </button>
                      )}
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
