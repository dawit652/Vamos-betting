'use client';

import type { AuditLogEntryView } from '@vamos/contracts';
import { useState, type FormEvent } from 'react';
import { usePaged } from '@/components/hooks';
import { Field, LoadMore, Loading, PageHeader } from '@/components/ui';
import { dayToIso, formatDateTime } from '@/lib/format';

export default function AuditPage() {
  const [action, setAction] = useState('');
  const [actorType, setActorType] = useState('');
  const [targetId, setTargetId] = useState('');
  const [fromDay, setFromDay] = useState('');
  const [toDay, setToDay] = useState('');
  const [applied, setApplied] = useState({
    action: '',
    actorType: '',
    targetId: '',
    from: '',
    to: '',
  });
  const list = usePaged<AuditLogEntryView>('/admin/audit', applied);

  function search(event: FormEvent) {
    event.preventDefault();
    setApplied({
      action,
      actorType,
      targetId,
      from: fromDay === '' ? '' : (dayToIso(fromDay) ?? ''),
      to: toDay === '' ? '' : (dayToIso(toDay, true) ?? ''),
    });
  }

  return (
    <>
      <PageHeader title="Audit log" />
      <form className="row" onSubmit={search}>
        <Field label="Action (exact or prefix like admin.*)">
          <input value={action} onChange={(e) => setAction(e.target.value)} />
        </Field>
        <Field label="Actor type">
          <select value={actorType} onChange={(e) => setActorType(e.target.value)}>
            <option value="">Any</option>
            <option value="admin">Staff</option>
            <option value="user">Player</option>
            <option value="system">System</option>
          </select>
        </Field>
        <Field label="Target id">
          <input value={targetId} onChange={(e) => setTargetId(e.target.value)} />
        </Field>
        <Field label="From">
          <input type="date" value={fromDay} onChange={(e) => setFromDay(e.target.value)} />
        </Field>
        <Field label="To (inclusive)">
          <input type="date" value={toDay} onChange={(e) => setToDay(e.target.value)} />
        </Field>
        <button type="submit" className="primary">
          Filter
        </button>
      </form>
      <Loading loading={list.loading && list.items.length === 0} error={list.error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Target</th>
              <th>Details</th>
              <th>IP</th>
            </tr>
          </thead>
          <tbody>
            {list.items.map((a) => (
              <tr key={a.id}>
                <td>{formatDateTime(a.createdAt)}</td>
                <td>
                  {a.actorType}
                  {a.actorEmail !== null && <div className="muted small">{a.actorEmail}</div>}
                </td>
                <td>{a.action}</td>
                <td>
                  {a.targetType ?? ''} {a.targetId ?? ''}
                </td>
                <td className="small">
                  <code>
                    {a.metadata === null || a.metadata === undefined
                      ? ''
                      : JSON.stringify(a.metadata)}
                  </code>
                </td>
                <td>{a.ip ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <LoadMore hasMore={list.hasMore} loading={list.loading} onMore={list.loadMore} />
    </>
  );
}
