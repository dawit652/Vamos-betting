'use client';

import type { KycQueueItemView, KycReviewRequest, KycReviewResponse } from '@vamos/contracts';
import Link from 'next/link';
import { useState } from 'react';
import { usePaged } from '@/components/hooks';
import { ActionButton, Badge, LoadMore, Loading, PageHeader, ReasonAction } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

export default function KycPage() {
  const [status, setStatus] = useState<'pending' | 'verified' | 'rejected'>('pending');
  const list = usePaged<KycQueueItemView>('/admin/kyc', { status });

  async function review(userId: string, body: KycReviewRequest) {
    await api<KycReviewResponse>(`/admin/kyc/${userId}/review`, { method: 'POST', body });
    list.reload();
  }

  return (
    <>
      <PageHeader title="KYC queue" />
      <div className="tabs">
        {(['pending', 'verified', 'rejected'] as const).map((s) => (
          <button key={s} type="button" aria-pressed={status === s} onClick={() => setStatus(s)}>
            {s}
          </button>
        ))}
      </div>
      <Loading loading={list.loading && list.items.length === 0} error={list.error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Player</th>
              <th>Name on profile</th>
              <th>Date of birth</th>
              <th>ID</th>
              <th>Status</th>
              <th>Submitted</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.items.map((k) => (
              <tr key={k.userId}>
                <td>
                  <Link href={`/users/${k.userId}`}>{k.phone}</Link>
                </td>
                <td>{k.verifiedName ?? k.fullName ?? '–'}</td>
                <td>{k.dateOfBirth ?? '–'}</td>
                <td>{k.idNumberLast4 === null ? '–' : `…${k.idNumberLast4}`}</td>
                <td>
                  <Badge value={k.status} />
                  {k.rejectionReason !== null && (
                    <div className="muted small">{k.rejectionReason}</div>
                  )}
                </td>
                <td>{formatDateTime(k.submittedAt)}</td>
                <td>
                  {k.status === 'pending' && (
                    <div className="actions">
                      <ActionButton
                        label="Approve"
                        primary
                        onAction={() => review(k.userId, { decision: 'approve' })}
                      />
                      <ReasonAction
                        label="Reject"
                        danger
                        onSubmit={(reason) => review(k.userId, { decision: 'reject', reason })}
                      />
                    </div>
                  )}
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
