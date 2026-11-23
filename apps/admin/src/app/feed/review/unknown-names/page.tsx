'use client';

import type { MapBatchResponse, MapBatchResult, ReviewItemView } from '@vamos/contracts';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { usePaged } from '@/components/hooks';
import { useSession } from '@/components/session';
import { ActionButton, Field, LoadMore, Loading, Notice, PageHeader } from '@/components/ui';
import { api } from '@/lib/api';
import {
  batchSummary,
  buildBatchItems,
  chunkBatch,
  filterGroups,
  groupUnknownNames,
  pickedTarget,
  strongSuggestion,
  type UnknownNameGroup,
} from '@/lib/feed-bulk';
import { scorePercent } from '@/lib/feed';

const QUERY = { status: 'open', kind: 'unknown_team', limit: '100' };

interface RowPick {
  picked: string;
  typed: string;
}

export default function UnknownNamesPage() {
  const { can } = useSession();
  const list = usePaged<ReviewItemView>('/admin/feed/review', QUERY);
  const groups = useMemo(() => groupUnknownNames(list.items), [list.items]);
  const [filter, setFilter] = useState('');
  const [scope, setScope] = useState<'source' | 'all'>('source');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [picks, setPicks] = useState<Record<string, RowPick>>({});
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const shown = filterGroups(groups, filter);
  const canMap = can('trading.status');

  const pickOf = (group: UnknownNameGroup): RowPick =>
    picks[group.key] ?? { picked: strongSuggestion(group)?.id ?? '', typed: '' };
  const targetOf = (group: UnknownNameGroup): string => {
    const p = pickOf(group);
    return pickedTarget(p.typed, p.picked);
  };
  const setPick = (group: UnknownNameGroup, change: Partial<RowPick>) =>
    setPicks((all) => ({ ...all, [group.key]: { ...pickOf(group), ...change } }));
  const toggle = (key: string) =>
    setSelected((all) => {
      const next = new Set(all);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const mapSelected = async () => {
    const targets = Object.fromEntries(groups.map((g) => [g.key, targetOf(g)]));
    const plan = buildBatchItems(groups, selected, targets, scope);
    if (plan.items.length === 0) {
      setMessage({
        kind: 'error',
        text:
          plan.skipped.length > 0
            ? `Choose a team for: ${plan.skipped.join(', ')}.`
            : 'Tick at least one name.',
      });
      return;
    }
    const results: MapBatchResult[] = [];
    for (const chunk of chunkBatch(plan.items)) {
      const response = await api<MapBatchResponse>('/admin/feed/review/map-batch', {
        method: 'POST',
        body: { items: chunk },
      });
      results.push(...response.results);
    }
    const skipped =
      plan.skipped.length > 0 ? ` Skipped (no team chosen): ${plan.skipped.join(', ')}.` : '';
    setMessage({
      kind: results.some((r) => !r.ok) ? 'error' : 'ok',
      text: batchSummary(results) + skipped,
    });
    setSelected(new Set());
    list.reload();
  };

  return (
    <>
      <PageHeader title="Unknown names">
        <Link href="/feed/review?status=open&kind=unknown_team">Review queue</Link>
        <Link href="/feed">Back to feed</Link>
      </PageHeader>
      <p className="muted small">
        Open unknown team names, one row per spelling. Pick the catalogue team, tick the rows and
        choose Map selected. Source-scoped (the safe default) maps the spelling for the source that
        sent it, and every other source then knows it too wherever the team already plays (its
        competition, or one of its country): you map a spelling once. All sources maps it everywhere
        without that check: keep it for names only one club uses. Suggestions are never applied
        without you.
      </p>
      <div className="row">
        <Field label="Filter">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="name, source or competition"
          />
        </Field>
        <Field label="Scope">
          <select value={scope} onChange={(e) => setScope(e.target.value as 'source' | 'all')}>
            <option value="source">Source-scoped (default)</option>
            <option value="all">All sources</option>
          </select>
        </Field>
      </div>
      {message !== null && <Notice kind={message.kind}>{message.text}</Notice>}
      <Loading loading={list.loading && list.items.length === 0} error={list.error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  aria-label="Select all shown"
                  checked={shown.length > 0 && shown.every((g) => selected.has(g.key))}
                  onChange={(e) =>
                    setSelected(e.target.checked ? new Set(shown.map((g) => g.key)) : new Set())
                  }
                />
              </th>
              <th>Spelling</th>
              <th>Sources and context</th>
              <th>Map to</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((group) => {
              const pick = pickOf(group);
              const strong = strongSuggestion(group);
              return (
                <tr key={group.key}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${group.raw}`}
                      checked={selected.has(group.key)}
                      onChange={() => toggle(group.key)}
                    />
                  </td>
                  <td>
                    <strong>{group.raw}</strong>
                    <div className="muted small">
                      {group.entries.length} item{group.entries.length === 1 ? '' : 's'}
                    </div>
                  </td>
                  <td className="small">
                    <ul>
                      {group.entries.map((entry) => (
                        <li key={entry.itemId}>
                          <Link href={`/feed/review/${entry.itemId}`}>{entry.sourceId}</Link>
                          {entry.competition !== '' && ` · ${entry.competition}`}
                          {entry.context !== null && ` · ${entry.context}`}
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td>
                    {group.suggestions.length > 0 && (
                      <select
                        aria-label={`Suggestions for ${group.raw}`}
                        value={pick.picked}
                        onChange={(e) => setPick(group, { picked: e.target.value, typed: '' })}
                      >
                        <option value="">Choose a suggestion</option>
                        {group.suggestions.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name} ({scorePercent(s.score)})
                            {strong?.id === s.id ? ' - strong' : ''}
                          </option>
                        ))}
                      </select>
                    )}
                    <input
                      aria-label={`Team id for ${group.raw}`}
                      value={pick.typed}
                      onChange={(e) => setPick(group, { typed: e.target.value })}
                      placeholder="or the id of another team"
                    />
                    {pick.typed.trim() !== '' && targetOf(group) === '' && (
                      <span className="muted small">Not a valid id.</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!list.loading && groups.length === 0 && list.error === null && (
        <p className="muted">No open unknown names.</p>
      )}
      <LoadMore hasMore={list.hasMore} loading={list.loading} onMore={list.loadMore} />
      {canMap ? (
        <ActionButton primary label={`Map selected (${selected.size})`} onAction={mapSelected} />
      ) : (
        <p className="muted small">Your role cannot map names.</p>
      )}
    </>
  );
}
