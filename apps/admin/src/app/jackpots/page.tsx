'use client';

import type { StaffJackpotEntryView, StaffJackpotRoundView } from '@vamos/contracts';
import { useState } from 'react';
import { usePaged } from '@/components/hooks';
import { useSession } from '@/components/session';
import { Badge, LoadMore, Loading, PageHeader, ReasonAction } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDateTime, formatEtb } from '@/lib/format';

function Entries({ roundId }: { roundId: string }) {
  const list = usePaged<StaffJackpotEntryView>(`/admin/jackpots/rounds/${roundId}/entries`);
  return (
    <>
      <Loading loading={list.loading && list.items.length === 0} error={list.error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Player</th>
              <th>Status</th>
              <th className="num">Combinations</th>
              <th className="num">Cost</th>
              <th className="num">Correct</th>
              <th className="num">Prize (net)</th>
              <th>Placed</th>
            </tr>
          </thead>
          <tbody>
            {list.items.map((e) => (
              <tr key={e.id}>
                <td>{e.phone}</td>
                <td>
                  <Badge value={e.status} />
                </td>
                <td className="num">{e.combinations}</td>
                <td className="num">{formatEtb(e.cost)}</td>
                <td className="num">{e.bestCorrect ?? '–'}</td>
                <td className="num">{formatEtb(e.prizeNet)}</td>
                <td>{formatDateTime(e.placedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <LoadMore hasMore={list.hasMore} loading={list.loading} onMore={list.loadMore} />
    </>
  );
}

export default function JackpotsPage() {
  const { can } = useSession();
  const list = usePaged<StaffJackpotRoundView>('/admin/jackpots/rounds');
  const [open, setOpen] = useState<string | null>(null);

  return (
    <>
      <PageHeader title="Jackpots" />
      <Loading loading={list.loading && list.items.length === 0} error={list.error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Template</th>
              <th>Status</th>
              <th>Closes</th>
              <th className="num">Pool</th>
              <th className="num">Entries</th>
              <th className="num">Stakes</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.items.map((r) => (
              <tr key={r.id}>
                <td>{r.templateCode}</td>
                <td>
                  <Badge value={r.status} />
                </td>
                <td>{formatDateTime(r.closesAt)}</td>
                <td className="num">{formatEtb(r.pool)}</td>
                <td className="num">{r.entries}</td>
                <td className="num">{formatEtb(r.stakes)}</td>
                <td>
                  <div className="actions">
                    <button type="button" onClick={() => setOpen(open === r.id ? null : r.id)}>
                      {open === r.id ? 'Hide entries' : 'Entries'}
                    </button>
                    {can('jackpots.manage') &&
                      (r.status === 'open' || r.status === 'scheduled') && (
                        <ReasonAction
                          label="Cancel round"
                          danger
                          onSubmit={async (reason) => {
                            await api(`/admin/jackpots/rounds/${r.id}/cancel`, {
                              method: 'POST',
                              body: { reason },
                            });
                            list.reload();
                          }}
                        />
                      )}
                  </div>
                  {open === r.id && <Entries roundId={r.id} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <LoadMore hasMore={list.hasMore} loading={list.loading} onMore={list.loadMore} />
    </>
  );
}
