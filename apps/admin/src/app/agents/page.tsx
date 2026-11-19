'use client';

import type { AgentCommissionKind, AgentListResponse, AgentResponse } from '@vamos/contracts';
import { parsePercentBps } from '@vamos/core';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useFetch } from '@/components/hooks';
import { useSession } from '@/components/session';
import { Badge, Field, Loading, Notice, PageHeader } from '@/components/ui';
import { api } from '@/lib/api';
import {
  COMMISSION_KIND_LABELS,
  PERCENT_HINT,
  commissionText,
  isLowBalance,
  localPhone,
  sortAgents,
} from '@/lib/agents';
import { describeError } from '@/lib/errors';
import { formatDateTime, formatEtb } from '@/lib/format';

function AddAgent() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [ownerPhone, setOwnerPhone] = useState('');
  const [kind, setKind] = useState<AgentCommissionKind>('ggr');
  const [percent, setPercent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const commissionBps = parsePercentBps(percent);
    if (commissionBps === null) return setError(PERCENT_HINT);
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api<AgentResponse>('/admin/agents', {
        method: 'POST',
        body: {
          name: name.trim(),
          ownerName: ownerName.trim(),
          ownerPhone: ownerPhone.trim(),
          commissionKind: kind,
          commissionBps,
        },
      });
      router.push(`/agents/${agent.id}`);
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  };

  return (
    <form className="card" autoComplete="off" aria-label="Add an agent" onSubmit={submit}>
      <h2>Add an agent</h2>
      <div className="row">
        <Field label="Agent name">
          <input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Owner's full name">
          <input
            required
            maxLength={100}
            value={ownerName}
            onChange={(e) => setOwnerName(e.target.value)}
          />
        </Field>
        <Field label="Owner's phone">
          <input
            required
            type="tel"
            placeholder="09… or 07…"
            maxLength={32}
            value={ownerPhone}
            onChange={(e) => setOwnerPhone(e.target.value)}
          />
        </Field>
        <Field label="Commission based on">
          <select value={kind} onChange={(e) => setKind(e.target.value as AgentCommissionKind)}>
            <option value="ggr">{COMMISSION_KIND_LABELS.ggr}</option>
            <option value="stake">{COMMISSION_KIND_LABELS.stake}</option>
          </select>
        </Field>
        <Field label="Commission percent">
          <input
            required
            inputMode="decimal"
            placeholder="10"
            value={percent}
            onChange={(e) => setPercent(e.target.value)}
          />
        </Field>
      </div>
      {error !== null && <Notice>{error}</Notice>}
      <p>
        <button type="submit" className="primary" disabled={busy}>
          Add agent
        </button>
      </p>
    </form>
  );
}

export default function AgentsPage() {
  const { data, error, loading } = useFetch<AgentListResponse>('/admin/agents');
  const { can } = useSession();
  return (
    <>
      <PageHeader title="Agents" />
      {can('agents.manage') && <AddAgent />}
      <Loading loading={loading && data === null} error={error} />
      {data !== null && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Number</th>
                <th>Name</th>
                <th>Owner</th>
                <th>Status</th>
                <th>Shops</th>
                <th>Cashiers</th>
                <th>Balance</th>
                <th>Commission</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {sortAgents(data.items).map((a) => (
                <tr key={a.id}>
                  <td>
                    {a.number} {a.isHouse && <Badge value="HQ" />}
                  </td>
                  <td>
                    <Link href={`/agents/${a.id}`}>{a.name}</Link>
                  </td>
                  <td>
                    {a.isHouse ? (
                      '—'
                    ) : (
                      <>
                        {a.ownerName}
                        <br />
                        <span className="small muted">{localPhone(a.ownerPhone)}</span>
                      </>
                    )}
                  </td>
                  <td>
                    {a.status === 'active' ? (
                      <Badge value="Active" tone="good" />
                    ) : (
                      <Badge value="Blocked" tone="bad" />
                    )}
                  </td>
                  <td>{`${a.openShops}/${a.shops}`}</td>
                  <td>{a.cashiers}</td>
                  <td>
                    {a.balance === null ? (
                      '–'
                    ) : (
                      <>
                        {formatEtb(a.balance)}{' '}
                        {isLowBalance(a.balance) && <Badge value="low" tone="warn" />}
                      </>
                    )}
                  </td>
                  <td>{commissionText(a)}</td>
                  <td>{formatDateTime(a.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
