'use client';

import type { AmlFlagView } from '@vamos/contracts';
import Link from 'next/link';
import { useState } from 'react';
import { usePaged } from '@/components/hooks';
import { Badge, LoadMore, Loading, PageHeader } from '@/components/ui';
import { formatDateTime, humanize } from '@/lib/format';

const STATUSES = ['open,escalated', 'open', 'escalated', 'reviewed', 'dismissed'] as const;

const severityTone = (s: string) => (s === 'high' ? 'bad' : s === 'medium' ? 'warn' : 'muted');

export default function AmlFlagsPage() {
  const [status, setStatus] = useState<string>('open,escalated');
  const list = usePaged<AmlFlagView>('/admin/compliance/aml-flags', { status });
  return (
    <>
      <PageHeader title="AML flags" />
      <div className="tabs">
        {STATUSES.map((s) => (
          <button key={s} type="button" aria-pressed={status === s} onClick={() => setStatus(s)}>
            {s.replace(',', ' + ')}
          </button>
        ))}
      </div>
      <Loading loading={list.loading && list.items.length === 0} error={list.error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Raised</th>
              <th>Rule</th>
              <th>Severity</th>
              <th>Player</th>
              <th>Status</th>
              <th>Window</th>
            </tr>
          </thead>
          <tbody>
            {list.items.map((f) => (
              <tr key={f.id}>
                <td>
                  <Link href={`/compliance/aml/${f.id}`}>{formatDateTime(f.triggeredAt)}</Link>
                </td>
                <td>{humanize(f.rule)}</td>
                <td>
                  <Badge value={f.severity} tone={severityTone(f.severity)} />
                </td>
                <td>
                  <Link href={`/users/${f.userId}`}>{f.userId.slice(0, 8)}</Link>
                </td>
                <td>
                  <Badge
                    value={f.status}
                    tone={f.status === 'open' || f.status === 'escalated' ? 'warn' : 'muted'}
                  />
                </td>
                <td>{f.windowKey}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!list.loading && list.items.length === 0 && list.error === null && (
        <p className="muted">No flags.</p>
      )}
      <LoadMore hasMore={list.hasMore} loading={list.loading} onMore={list.loadMore} />
    </>
  );
}
