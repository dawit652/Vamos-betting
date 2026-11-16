'use client';

import type {
  ReceivedSmsStatus,
  SmsRailHealthResponse,
  StaffSmsListResponse,
  StaffSmsView,
} from '@vamos/contracts';
import { useState, type FormEvent } from 'react';
import { useFetch } from '@/components/hooks';
import { useSession } from '@/components/session';
import { Badge, DefList, Loading, Notice, PageHeader, ReasonAction, Stat } from '@/components/ui';
import { api } from '@/lib/api';
import { describeError } from '@/lib/errors';
import { formatDateTime, formatEtb, humanize } from '@/lib/format';

type Tab = 'review' | 'all';

/** Credit what arrived to a player (their id from the player search, or the matched one). */
function CreditForm({ sms, onDone }: { sms: StaffSmsView; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [userId, setUserId] = useState(sms.matchedUserId ?? '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open) {
    return (
      <button type="button" className="primary" onClick={() => setOpen(true)}>
        Credit to player
      </button>
    );
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/admin/sms/${sms.id}/credit`, {
        method: 'POST',
        body: { userId: userId.trim(), note: note.trim() },
      });
      setOpen(false);
      onDone();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="inline-form" onSubmit={(event) => void submit(event)}>
      <input
        aria-label="Player id"
        placeholder="Player id (from Players)"
        value={userId}
        onChange={(e) => setUserId(e.target.value)}
      />
      <input
        aria-label="Note"
        placeholder="Note: who paid, how you checked"
        value={note}
        maxLength={500}
        onChange={(e) => setNote(e.target.value)}
      />
      <button type="submit" className="primary" disabled={busy || note.trim() === ''}>
        Credit {sms.amount === null ? '' : formatEtb(sms.amount)}
      </button>
      <button type="button" onClick={() => setOpen(false)} disabled={busy}>
        Cancel
      </button>
      {error !== null && <Notice>{error}</Notice>}
    </form>
  );
}

const CREDITABLE: readonly ReceivedSmsStatus[] = ['unmatched', 'ambiguous', 'flagged'];
const CLOSABLE: readonly ReceivedSmsStatus[] = [
  'unparsed',
  'unmatched',
  'ambiguous',
  'flagged',
  'ignored_debit',
  'settlement_proposed',
];

function SmsRow({ sms, reload }: { sms: StaffSmsView; reload: () => void }) {
  const { can } = useSession();
  const manage = can('sms.review') && sms.resolvedAt === null;
  const alarm = sms.receiptStatus === 'rejected' && sms.resolvedAt === null;
  return (
    <tr data-testid={`sms-${sms.id}`}>
      <td>{formatDateTime(sms.receivedAt)}</td>
      <td>
        {sms.institution ?? sms.sender ?? '–'}
        <div className="muted small">{sms.source}</div>
        {sms.collectionAccount !== null && (
          <div className="muted small">to {sms.collectionAccount}</div>
        )}
      </td>
      <td>{sms.direction ?? '–'}</td>
      <td className="num">{sms.amount === null ? '–' : formatEtb(sms.amount)}</td>
      <td>
        {sms.reference ?? '–'}
        {sms.counterpartyPhone !== null && (
          <div className="muted small">{sms.counterpartyPhone}</div>
        )}
        {sms.counterpartyName !== null && <div className="muted small">{sms.counterpartyName}</div>}
      </td>
      <td>
        <Badge value={sms.status} />
        {alarm && <Badge value={`receipt: ${humanize(sms.receiptReason)}`} tone="warn" />}
        {sms.statusReason !== null && (
          <div className="muted small">{humanize(sms.statusReason)}</div>
        )}
        {sms.receiptStatus !== null && !alarm && (
          <div className="muted small">receipt {sms.receiptStatus}</div>
        )}
      </td>
      <td className="small" style={{ maxWidth: '24rem', whiteSpace: 'pre-wrap' }}>
        {sms.rawText}
      </td>
      <td>
        {manage && (
          <div className="actions">
            {CREDITABLE.includes(sms.status) && sms.direction === 'credit' && (
              <CreditForm sms={sms} onDone={reload} />
            )}
            {sms.status === 'unparsed' && (
              <button
                type="button"
                onClick={() => {
                  void api(`/admin/sms/${sms.id}/reparse`, { method: 'POST' }).then(reload, reload);
                }}
              >
                Read again
              </button>
            )}
            {CLOSABLE.includes(sms.status) && (
              <ReasonAction
                label="Close"
                danger
                prompt="Note"
                onSubmit={async (note) => {
                  await api(`/admin/sms/${sms.id}/close`, { method: 'POST', body: { note } });
                  reload();
                }}
              />
            )}
            {alarm && (
              <ReasonAction
                label="Acknowledge alarm"
                prompt="What you found"
                onSubmit={async (note) => {
                  await api(`/admin/sms/${sms.id}/acknowledge-receipt`, {
                    method: 'POST',
                    body: { note },
                  });
                  reload();
                }}
              />
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

function Health() {
  const { data } = useFetch<SmsRailHealthResponse>('/admin/sms/health');
  if (data === null) return null;
  return (
    <div className="stats">
      <Stat label="Rail" value={data.mode} hint={`receipt check: ${data.receiptVerify}`} />
      <Stat label="Last SMS from the handset" value={formatDateTime(data.lastGatewaySmsAt)} />
      <Stat
        label="Review queue"
        value={data.reviewQueue}
        {...(data.oldestReviewAt === null
          ? {}
          : { hint: `oldest ${formatDateTime(data.oldestReviewAt)}` })}
      />
      <Stat label="Receipt alarms" value={data.receiptAlarms} />
      <Stat
        label="Manual payouts open"
        value={data.manualPayoutsOpen}
        {...(data.oldestManualPayoutApprovedAt === null
          ? {}
          : { hint: `oldest ${formatDateTime(data.oldestManualPayoutApprovedAt)}` })}
      />
      {data.receiptBreaker !== null && <Stat label="Receipt page" value={data.receiptBreaker} />}
      {data.balance.map((b) => (
        <Stat
          key={b.institution}
          label={`Balance check · ${b.institution}`}
          value={b.status === 'drift' ? `drift ${formatEtb(b.drift)}` : humanize(b.status)}
          hint={`${b.observations} SMS · ${formatDateTime(b.checkedAt)}`}
        />
      ))}
      <Stat
        label={`Expected withdrawals · next ${data.payoutFloat.horizonHours} h`}
        value={formatEtb(data.payoutFloat.expectedWithdrawals)}
        hint={`${data.payoutFloat.withdrawnPercent}% of ${formatEtb(data.payoutFloat.possiblePayouts)} possible payouts of ${data.payoutFloat.betsCounted} open bets`}
      />
      {data.payoutFloat.balances.map((b) => (
        <Stat
          key={`float-${b.institution}`}
          label={`Last known balance · ${b.institution}`}
          value={formatEtb(b.balance)}
          hint={`${b.low ? 'BELOW the forecast, top up · ' : ''}as of ${formatDateTime(b.at)}`}
        />
      ))}
    </div>
  );
}

/**
 * The SMS rail (ported from Melabingo): every confirmation SMS the collection
 * handset forwarded, and the queue of the ones that need a person. Receipt
 * alarms (a credit the institution's receipt contradicts) come first.
 */
export default function SmsPage() {
  const [tab, setTab] = useState<Tab>('review');
  const { data, error, loading, reload } = useFetch<StaffSmsListResponse>('/admin/sms', {
    queue: tab,
  });
  return (
    <>
      <PageHeader title="SMS rail" />
      <Health />
      <DefList
        rows={[
          ['unparsed', 'No parser read it: add the message to the fixtures, then close it.'],
          ['unmatched', 'Money arrived for no open deposit: find who paid and credit them.'],
          ['flagged', 'It matched a deposit but another amount or someone else’s phone paid.'],
          ['receipt alarm', 'Credited, but the institution’s receipt contradicts it: investigate.'],
        ]}
      />
      <div className="tabs">
        {(['review', 'all'] as const).map((t) => (
          <button key={t} type="button" aria-pressed={tab === t} onClick={() => setTab(t)}>
            {t === 'review' ? 'Needs a person' : 'All messages'}
          </button>
        ))}
      </div>
      <Loading loading={loading && data === null} error={error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Received</th>
              <th>Institution</th>
              <th>Direction</th>
              <th className="num">Amount</th>
              <th>Reference · payer</th>
              <th>Status</th>
              <th>Message</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data?.items.map((sms) => (
              <SmsRow key={sms.id} sms={sms} reload={reload} />
            ))}
          </tbody>
        </table>
      </div>
      {data !== null && data.items.length === 0 && <p className="muted">Nothing here.</p>}
    </>
  );
}
