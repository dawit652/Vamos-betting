'use client';

import type { AliasView, CreateAliasResponse, RemoveAliasResponse } from '@vamos/contracts';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { usePaged } from '@/components/hooks';
import { useSession } from '@/components/session';
import { Field, LoadMore, Loading, Notice, PageHeader } from '@/components/ui';
import { api } from '@/lib/api';
import { describeError } from '@/lib/errors';
import { validateAliasForm } from '@/lib/feed';
import { formatDateTime } from '@/lib/format';

export default function AliasesPage() {
  const { can } = useSession();
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const list = usePaged<AliasView>('/admin/feed/aliases', { kind, q: applied });

  const [newKind, setNewKind] = useState<'team' | 'competition'>('team');
  const [raw, setRaw] = useState('');
  const [targetId, setTargetId] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The alias waiting for a second click, and the one being removed.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  async function remove(alias: AliasView) {
    setMessage(null);
    setError(null);
    setRemoving(alias.id);
    try {
      await api<RemoveAliasResponse>(`/admin/feed/aliases/${encodeURIComponent(alias.id)}`, {
        method: 'DELETE',
      });
      setMessage(`Alias "${alias.normalized}" removed.`);
      list.reload();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setRemoving(null);
      setConfirming(null);
    }
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    const problem = validateAliasForm({ raw, targetId });
    if (problem !== null) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api<CreateAliasResponse>('/admin/feed/aliases', {
        method: 'POST',
        body: {
          kind: newKind,
          raw: raw.trim(),
          targetId: targetId.trim(),
          ...(sourceId.trim() === '' ? {} : { sourceId: sourceId.trim() }),
        },
      });
      setMessage(result.created ? 'Alias created.' : 'That alias already existed.');
      setRaw('');
      list.reload();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Aliases">
        <Link href="/feed">Back to feed</Link>
      </PageHeader>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(q.trim());
        }}
      >
        <Field label="Kind">
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">Any</option>
            <option value="team">Team</option>
            <option value="competition">Competition</option>
          </select>
        </Field>
        <Field label="Name contains">
          <input value={q} onChange={(e) => setQ(e.target.value)} />
        </Field>
        <button type="submit" className="primary">
          Filter
        </button>
      </form>
      {can('trading.status') && error !== null && <Notice>{error}</Notice>}
      {can('trading.status') && message !== null && <Notice kind="ok">{message}</Notice>}
      <Loading loading={list.loading && list.items.length === 0} error={list.error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Kind</th>
              <th>Maps to</th>
              <th>Source</th>
              <th>Created</th>
              {can('trading.status') && <th />}
            </tr>
          </thead>
          <tbody>
            {list.items.map((a) => (
              <tr key={a.id}>
                <td>{a.normalized}</td>
                <td>{a.kind}</td>
                <td>{a.targetName}</td>
                <td>{a.sourceId ?? 'all'}</td>
                <td>
                  {formatDateTime(a.createdAt)} by {a.createdBy}
                </td>
                {can('trading.status') && (
                  <td>
                    {confirming === a.id ? (
                      <span className="row">
                        <button
                          type="button"
                          className="danger"
                          disabled={removing !== null}
                          onClick={() => void remove(a)}
                        >
                          Confirm remove
                        </button>
                        <button
                          type="button"
                          disabled={removing !== null}
                          onClick={() => setConfirming(null)}
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={removing !== null}
                        onClick={() => setConfirming(a.id)}
                      >
                        Remove
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!list.loading && list.items.length === 0 && list.error === null && (
        <p className="muted">No aliases.</p>
      )}
      <LoadMore hasMore={list.hasMore} loading={list.loading} onMore={list.loadMore} />

      {can('trading.status') && (
        <section className="panel">
          <h2>Add an alias</h2>
          <form className="row" onSubmit={create}>
            <Field label="Kind">
              <select
                value={newKind}
                onChange={(e) => setNewKind(e.target.value as 'team' | 'competition')}
              >
                <option value="team">Team</option>
                <option value="competition">Competition</option>
              </select>
            </Field>
            <Field label="Raw name">
              <input value={raw} maxLength={120} onChange={(e) => setRaw(e.target.value)} />
            </Field>
            <Field label="Target id">
              <input value={targetId} onChange={(e) => setTargetId(e.target.value)} />
            </Field>
            <Field label="Source id (optional)">
              <input value={sourceId} onChange={(e) => setSourceId(e.target.value)} />
            </Field>
            <button type="submit" className="primary" disabled={busy}>
              Add
            </button>
          </form>
        </section>
      )}
    </>
  );
}
