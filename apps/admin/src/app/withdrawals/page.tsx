'use client';

import type {
  SettlePayoutRequest,
  StaffDepositListResponse,
  StaffWithdrawalView,
} from '@vamos/contracts';
import { useState } from 'react';
import { useFetch, usePaged } from '@/components/hooks';
import { useSession } from '@/components/session';
import { ActionButton, Badge, LoadMore, Loading, PageHeader, ReasonAction } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDateTime, formatEtb, humanize } from '@/lib/format';

type Tab = 'review' | 'flagged' | 'all' | 'deposits';

function Row({ w, reload }: { w: StaffWithdrawalView; reload: () => void }) {
  const { can } = useSession();
  const act = async (path: string, body?: unknown) => {
    await api(`/admin/withdrawals/${w.id}/${path}`, { method: 'POST', body: body ?? {} });
    reload();
  };
  const manage = can('withdrawals.approve');
  const settle = async (body: SettlePayoutRequest) => act('settle', body);
  return (
    <tr data-testid={`withdrawal-${w.id}`}>
      <td>{w.player.phone}</td>
      <td className="num">{formatEtb(w.amount)}</td>
      <td>
        {w.provider}
        {w.destination !== null && (
          <div className="muted small">
            by hand to {w.destination.institutionName} · {w.destination.account}
          </div>
        )}
      </td>
      <td>
        <Badge value={w.status} />
        {w.flagReason !== null && (
          <Badge value={`flagged: ${humanize(w.flagReason)}`} tone="warn" />
        )}
        {w.reviewReason !== null && <div className="muted small">{w.reviewReason}</div>}
        {w.failureReason !== null && <div className="muted small">{w.failureReason}</div>}
      </td>
      <td>
        {w.player.kycStatus} · {w.recipientName}
      </td>
      <td>{formatDateTime(w.requestedAt)}</td>
      <td>
        {manage && (
          <div className="actions">
            {w.status === 'requested' && (
              <>
                <ActionButton label="Approve" primary onAction={() => act('approve')} />
                <ReasonAction
                  label="Reject"
                  danger
                  onSubmit={(reason) => act('reject', { reason })}
                />
              </>
            )}
            {!w.manual &&
              w.flagReason === null &&
              ['approved', 'processing'].includes(w.status) && (
                <ReasonAction
                  label="Flag"
                  prompt="Note"
                  onSubmit={(note) => act('flag', { note })}
                />
              )}
            {w.flagReason !== null && (
              <>
                <ReasonAction
                  label="Clear flag"
                  prompt="Note"
                  onSubmit={(note) => act('clear-flag', { note })}
                />
                <ActionButton label="Mark paid" onAction={() => settle({ outcome: 'paid' })} />
                <ReasonAction
                  label="Mark failed"
                  danger
                  onSubmit={(reason) => settle({ outcome: 'failed', reason })}
                />
              </>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

function WithdrawalList({ tab }: { tab: Exclude<Tab, 'deposits'> }) {
  const query =
    tab === 'review'
      ? { status: 'requested' }
      : tab === 'flagged'
        ? { flagged: 'true' }
        : { order: 'desc' };
  const list = usePaged<StaffWithdrawalView>('/admin/withdrawals', query);
  return (
    <>
      <Loading loading={list.loading && list.items.length === 0} error={list.error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Player</th>
              <th className="num">Amount</th>
              <th>Provider</th>
              <th>Status</th>
              <th>KYC · recipient</th>
              <th>Requested</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.items.map((w) => (
              <Row key={w.id} w={w} reload={list.reload} />
            ))}
          </tbody>
        </table>
      </div>
      {!list.loading && list.items.length === 0 && list.error === null && (
        <p className="muted">Nothing here.</p>
      )}
      <LoadMore hasMore={list.hasMore} loading={list.loading} onMore={list.loadMore} />
    </>
  );
}

function FlaggedDeposits() {
  const { can } = useSession();
  const { data, error, loading, reload } =
    useFetch<StaffDepositListResponse>('/admin/deposits/flagged');
  return (
    <>
      <Loading loading={loading && data === null} error={error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Player</th>
              <th className="num">Amount</th>
              <th>Provider</th>
              <th>Status</th>
              <th>Flag</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data?.items.map((d) => (
              <tr key={d.id}>
                <td>{d.player.phone}</td>
                <td className="num">{formatEtb(d.amount)}</td>
                <td>{d.provider}</td>
                <td>
                  <Badge value={d.status} />
                </td>
                <td>{d.flagReason ?? '–'}</td>
                <td>
                  {can('withdrawals.approve') && (
                    <div className="actions">
                      <ReasonAction
                        label="Credit"
                        prompt="Note"
                        onSubmit={async (note) => {
                          await api(`/admin/deposits/${d.id}/resolve`, {
                            method: 'POST',
                            body: { resolution: 'credit', note },
                          });
                          reload();
                        }}
                      />
                      <ReasonAction
                        label="Close"
                        danger
                        prompt="Note"
                        onSubmit={async (note) => {
                          await api(`/admin/deposits/${d.id}/resolve`, {
                            method: 'POST',
                            body: { resolution: 'close', note },
                          });
                          reload();
                        }}
                      />
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export default function WithdrawalsPage() {
  const [tab, setTab] = useState<Tab>('review');
  const labels: Record<Tab, string> = {
    review: 'Awaiting review',
    flagged: 'Flagged payouts',
    all: 'All withdrawals',
    deposits: 'Flagged deposits',
  };
  return (
    <>
      <PageHeader title="Withdrawals" />
      <div className="tabs">
        {(Object.keys(labels) as Tab[]).map((t) => (
          <button key={t} type="button" aria-pressed={tab === t} onClick={() => setTab(t)}>
            {labels[t]}
          </button>
        ))}
      </div>
      {tab === 'deposits' ? <FlaggedDeposits /> : <WithdrawalList key={tab} tab={tab} />}
    </>
  );
}
