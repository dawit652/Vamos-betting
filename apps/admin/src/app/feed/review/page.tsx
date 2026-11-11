'use client';

import type {
  OpenBatchResponse,
  OpenBatchResult,
  OpenCheckResponse,
  OpenCheckResult,
  ReviewItemView,
} from '@vamos/contracts';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { usePaged } from '@/components/hooks';
import { useSession } from '@/components/session';
import { ActionButton, Badge, Field, LoadMore, Loading, Notice, PageHeader } from '@/components/ui';
import { api } from '@/lib/api';
import {
  ageText,
  kindLabel,
  payloadSummary,
  reviewQuery,
  reviewStatusTone,
  severityTone,
} from '@/lib/feed';
import { chunkBatch } from '@/lib/feed-bulk';
import {
  checkChunks,
  isOpenCandidate,
  openSummary,
  pruneSelection,
  selectableIds,
  toleranceText,
  worstDeviation,
} from '@/lib/feed-open';
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
  const { can } = useSession();
  // Bulk open (plan A-4): only on open odds_approval items, for staff who may open betting.
  const bulk = kind === 'odds_approval' && status === 'open' && can('trading.status');
  const [checks, setChecks] = useState<Map<string, OpenCheckResult>>(new Map());
  const [toleranceBps, setToleranceBps] = useState(300);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (!bulk) return;
    const unchecked = list.items.filter((i) => isOpenCandidate(i) && !checks.has(i.id));
    if (unchecked.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const ids of checkChunks(unchecked)) {
        const response = await api<OpenCheckResponse>('/admin/feed/review/open-check', {
          method: 'POST',
          body: { itemIds: ids },
        });
        if (cancelled) return;
        setToleranceBps(response.toleranceBps);
        setChecks((prev) => {
          const next = new Map(prev);
          for (const r of response.results) next.set(r.itemId, r);
          return next;
        });
      }
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [bulk, list.items, checks]);

  const selectable = useMemo(() => selectableIds(list.items, checks), [list.items, checks]);
  useEffect(() => {
    setSelected((prev) => pruneSelection(prev, selectable));
  }, [selectable]);
  const chosen = list.items.filter((i) => selected.has(i.id));

  const toggle = (id: string) => {
    setConfirming(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    setConfirming(false);
    setSelected(selected.size === selectable.length ? new Set() : new Set(selectable));
  };

  const openSelected = async () => {
    const results: OpenBatchResult[] = [];
    for (const ids of chunkBatch(chosen.map((i) => i.id))) {
      const response = await api<OpenBatchResponse>('/admin/feed/review/open-batch', {
        method: 'POST',
        body: { itemIds: ids },
      });
      results.push(...response.results);
    }
    setMessage({ kind: results.some((r) => !r.ok) ? 'error' : 'ok', text: openSummary(results) });
    setSelected(new Set());
    setConfirming(false);
    setChecks(new Map());
    list.reload();
  };
  return (
    <>
      <PageHeader title="Review queue">
        <Link href="/feed/review/unknown-names">Unknown names</Link>
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
      {bulk && (
        <p className="muted small">
          Tick the matches whose 1X2 prices are within {toleranceBps / 100}% of the bookmaker
          consensus after our margin, then choose Open selected. The server checks the ratings,
          prices, kickoff and consensus again for each match; anything that fails stays in the
          queue.
        </p>
      )}
      {message !== null && <Notice kind={message.kind}>{message.text}</Notice>}
      {bulk && selected.size > 0 && !confirming && (
        <div className="row">
          <button type="button" className="primary" onClick={() => setConfirming(true)}>
            Open selected ({selected.size})
          </button>
        </div>
      )}
      {bulk && confirming && (
        <div className="card">
          <p>
            Open betting on {chosen.length} {chosen.length === 1 ? 'match' : 'matches'}?
          </p>
          <ul className="small">
            {chosen.map((i) => (
              <li key={i.id}>{payloadSummary(i.kind, i.payload)}</li>
            ))}
          </ul>
          <div className="row">
            <ActionButton label="Confirm and open" primary onAction={openSelected} />
            <button type="button" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <Loading loading={list.loading && list.items.length === 0} error={list.error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {bulk && (
                <th>
                  <input
                    type="checkbox"
                    aria-label="Select all within tolerance"
                    checked={selectable.length > 0 && selected.size === selectable.length}
                    disabled={selectable.length === 0}
                    onChange={toggleAll}
                  />
                </th>
              )}
              <th>Severity</th>
              <th>Title</th>
              <th>Kind</th>
              <th>About</th>
              <th>Status</th>
              <th>Age</th>
              {bulk && <th>Tolerance</th>}
            </tr>
          </thead>
          <tbody>
            {list.items.map((item) => (
              <tr key={item.id}>
                {bulk && (
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${item.title}`}
                      checked={selected.has(item.id)}
                      disabled={!selectable.includes(item.id)}
                      onChange={() => toggle(item.id)}
                    />
                  </td>
                )}
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
                {bulk && (
                  <td className="small">
                    {toleranceText(checks.get(item.id), toleranceBps)}
                    {worstDeviation(checks.get(item.id)) !== null &&
                      ` (${worstDeviation(checks.get(item.id))})`}
                  </td>
                )}
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
