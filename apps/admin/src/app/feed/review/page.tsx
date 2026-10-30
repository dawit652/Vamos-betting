'use client';

import type { ReviewItemView } from '@vamos/contracts';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { usePaged } from '@/components/hooks';
import { Badge, Field, LoadMore, Loading, PageHeader } from '@/components/ui';
import {
  ageText,
  kindLabel,
  payloadSummary,
  reviewQuery,
  reviewStatusTone,
  severityTone,
} from '@/lib/feed';
import { formatDateTime } from '@/lib/format';

const STATUSES = ['open', 'resolved', 'dismissed', ''] as const;
const KINDS = [
  'unknown_team',
  'unknown_competition',
  'fixture_conflict',
  'kickoff_change',
  'fixture_missing',
  'cancellation_proposed',
  'ratings_uncalibrated',
  'odds_approval',
  'result_ready',
  'result_unverified',
  'result_conflict',
  'result_correction',
  'score_basis_unknown',
  'result_overdue',
  'source_broken',
  'source_stale',
] as const;

export default function ReviewQueuePage() {
  const [status, setStatus] = useState('open');
  const [kind, setKind] = useState('');
  // The overview links here with ?status=&kind=; read them once on the client.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setStatus(params.get('status') ?? 'open');
    setKind(params.get('kind') ?? '');
  }, []);
  const list = usePaged<ReviewItemView>('/admin/feed/review', reviewQuery(status, kind));
  return (
    <>
      <PageHeader title="Review queue">
        <Link href="/feed">Back to feed</Link>
      </PageHeader>
      <div className="row">
        <Field label="Status">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s === '' ? 'Any' : s}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Kind">
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">Any</option>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {kindLabel(k)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Loading loading={list.loading && list.items.length === 0} error={list.error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Severity</th>
              <th>Title</th>
              <th>Kind</th>
              <th>About</th>
              <th>Status</th>
              <th>Age</th>
            </tr>
          </thead>
          <tbody>
            {list.items.map((item) => (
              <tr key={item.id}>
                <td>
                  <Badge value={item.severity} tone={severityTone(item.severity)} />
                </td>
                <td>
                  <Link href={`/feed/review/${item.id}`}>{item.title}</Link>
                </td>
                <td>{kindLabel(item.kind)}</td>
                <td className="small">{payloadSummary(item.kind, item.payload)}</td>
                <td>
                  <Badge value={item.status} tone={reviewStatusTone(item.status)} />
                </td>
                <td title={formatDateTime(item.createdAt)}>{ageText(item.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!list.loading && list.items.length === 0 && list.error === null && (
        <p className="muted">No items.</p>
      )}
      <LoadMore hasMore={list.hasMore} loading={list.loading} onMore={list.loadMore} />
    </>
  );
}
