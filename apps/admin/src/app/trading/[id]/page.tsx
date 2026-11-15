'use client';

import type {
  ResultEventRequest,
  SetOddsRequest,
  TradingEventView,
  TradingMarketView,
  TradingSelectionView,
} from '@vamos/contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useFetch } from '@/components/hooks';
import { useSession } from '@/components/session';
import { ActionButton, Badge, Loading, Notice, PageHeader, ReasonAction } from '@/components/ui';
import { api } from '@/lib/api';
import { describeError } from '@/lib/errors';
import { formatDateTime, formatEtb, formatOdds, nameOf, parseOddsToMilli } from '@/lib/format';

function OddsEditor({
  selection,
  onDone,
}: {
  selection: TradingSelectionView;
  onDone: () => void;
}) {
  const [text, setText] = useState(formatOdds(selection.oddsMilli));
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    const milli = parseOddsToMilli(text);
    if (milli === null) {
      setError('Enter odds between 1.001 and 1000.');
      return;
    }
    setError(null);
    try {
      const body: SetOddsRequest = { oddsMilli: milli };
      await api(`/admin/trading/selections/${selection.id}/odds`, { method: 'POST', body });
      onDone();
    } catch (e) {
      setError(describeError(e));
    }
  }

  return (
    <form className="inline-form" onSubmit={save}>
      <input
        aria-label={`Odds for ${selection.code}`}
        value={text}
        size={7}
        onChange={(e) => setText(e.target.value)}
      />
      <button type="submit">Set</button>
      {error !== null && <Notice>{error}</Notice>}
    </form>
  );
}

function ResultForm({ eventId, onDone }: { eventId: string; onDone: () => void }) {
  const [kind, setKind] = useState<'finished' | 'cancelled' | 'abandoned' | 'postponed'>(
    'finished',
  );
  const [home, setHome] = useState('0');
  const [away, setAway] = useState('0');
  const [htHome, setHtHome] = useState('');
  const [htAway, setHtAway] = useState('');
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const goals = (s: string) => (/^\d{1,3}$/.test(s) ? Number(s) : null);
    let body: ResultEventRequest;
    const note = reason.trim() === '' ? undefined : reason.trim();
    if (kind === 'finished') {
      const h = goals(home);
      const a = goals(away);
      const hh = htHome === '' ? undefined : goals(htHome);
      const ha = htAway === '' ? undefined : goals(htAway);
      if (h === null || a === null || hh === null || ha === null) {
        setMessage({ kind: 'error', text: 'Scores are whole numbers from 0 to 999.' });
        return;
      }
      body = {
        status: 'finished',
        score: {
          home: h,
          away: a,
          ...(hh !== undefined && ha !== undefined ? { htHome: hh, htAway: ha } : {}),
        },
        ...(note === undefined ? {} : { reason: note }),
      };
    } else {
      body = { status: kind, ...(note === undefined ? {} : { reason: note }) };
    }
    try {
      const res = await api<{ outcome: string; marketsSettled: number; marketsVoided: number }>(
        `/admin/trading/events/${eventId}/result`,
        { method: 'POST', body },
      );
      setMessage({
        kind: 'ok',
        text: `Result ${res.outcome}: ${res.marketsSettled} markets settled, ${res.marketsVoided} voided.`,
      });
      onDone();
    } catch (e) {
      setMessage({ kind: 'error', text: describeError(e) });
    }
  }

  return (
    <form className="panel row" onSubmit={submit} aria-label="Enter result">
      <label className="field">
        <span>Outcome</span>
        <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="finished">Finished</option>
          <option value="cancelled">Cancelled (void)</option>
          <option value="abandoned">Abandoned</option>
          <option value="postponed">Postponed</option>
        </select>
      </label>
      {kind === 'finished' && (
        <>
          <label className="field">
            <span>Home goals</span>
            <input value={home} size={4} onChange={(e) => setHome(e.target.value)} />
          </label>
          <label className="field">
            <span>Away goals</span>
            <input value={away} size={4} onChange={(e) => setAway(e.target.value)} />
          </label>
          <label className="field">
            <span>HT home</span>
            <input value={htHome} size={4} onChange={(e) => setHtHome(e.target.value)} />
          </label>
          <label className="field">
            <span>HT away</span>
            <input value={htAway} size={4} onChange={(e) => setHtAway(e.target.value)} />
          </label>
        </>
      )}
      <label className="field">
        <span>Reason (needed for a correction)</span>
        <input value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <button type="submit" className="primary">
        Submit result
      </button>
      {message !== null && <Notice kind={message.kind}>{message.text}</Notice>}
    </form>
  );
}

function MarketCard({ market, reload }: { market: TradingMarketView; reload: () => void }) {
  const { can } = useSession();
  const post = async (path: string, body: unknown) => {
    await api(path, { method: 'POST', body });
    reload();
  };
  const final = market.status === 'settled' || market.status === 'void';
  return (
    <section className="panel" style={{ marginBottom: 12 }} data-testid={`market-${market.key}`}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>
          {market.key} {market.line !== null && `(${market.line})`}
        </strong>
        <span>
          <Badge value={market.status} />
          {market.suspendedBy !== null && (
            <span className="muted small"> by {market.suspendedBy}</span>
          )}
        </span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Selection</th>
              <th className="num">Odds</th>
              <th>State</th>
              <th className="num">Open bets</th>
              <th className="num">Stake</th>
              <th className="num">Liability</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {market.selections.map((s) => (
              <tr key={s.id}>
                <td>{s.code}</td>
                <td className="num">{formatOdds(s.oddsMilli)}</td>
                <td>
                  <Badge value={s.voidedAt !== null ? 'void' : (s.result ?? s.status)} />
                </td>
                <td className="num">{s.openBets}</td>
                <td className="num">{formatEtb(s.openStake)}</td>
                <td className="num">{formatEtb(s.liability)}</td>
                <td>
                  <div className="actions">
                    {can('trading.odds') && s.status !== 'settled' && !final && (
                      <OddsEditor selection={s} onDone={reload} />
                    )}
                    {can('trading.void') && s.voidedAt === null && !final && (
                      <ReasonAction
                        label="Void selection"
                        danger
                        onSubmit={(reason) =>
                          post(`/admin/trading/selections/${s.id}/void`, { reason })
                        }
                      />
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="actions" style={{ marginTop: 8 }}>
        {can('trading.status') && !final && (
          <>
            {market.status === 'open' ? (
              <ActionButton
                label="Suspend market"
                onAction={() =>
                  post(`/admin/trading/markets/${market.id}/status`, { status: 'suspended' })
                }
              />
            ) : (
              <ActionButton
                label="Open market"
                onAction={() =>
                  post(`/admin/trading/markets/${market.id}/status`, { status: 'open' })
                }
              />
            )}
            {market.status !== 'closed' && (
              <ActionButton
                label="Close market"
                onAction={() =>
                  post(`/admin/trading/markets/${market.id}/status`, { status: 'closed' })
                }
              />
            )}
          </>
        )}
        {can('trading.void') && market.status !== 'void' && market.voidedAt === null && (
          <ReasonAction
            label="Void market"
            danger
            onSubmit={(reason) => post(`/admin/trading/markets/${market.id}/void`, { reason })}
          />
        )}
      </div>
    </section>
  );
}

export default function TradingEventPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const {
    data: ev,
    error,
    loading,
    reload,
  } = useFetch<TradingEventView>(`/admin/trading/events/${id}`);

  const post = async (path: string, body: unknown) => {
    await api(path, { method: 'POST', body });
    reload();
  };

  return (
    <>
      <PageHeader title={ev === null ? 'Event' : `${nameOf(ev.homeTeam)} v ${nameOf(ev.awayTeam)}`}>
        <Link href="/trading">Back to events</Link>
      </PageHeader>
      <Loading loading={loading && ev === null} error={error} />
      {ev !== null && (
        <>
          <p>
            Game {ev.gameId} · {nameOf(ev.competition)} · {formatDateTime(ev.startTime)} ·{' '}
            <Badge value={ev.status} />{' '}
            {!ev.bettingOpen && <Badge value="betting off" tone="warn" />}
            {ev.scoreHome !== null && (
              <strong data-testid="score">
                {' '}
                {ev.scoreHome}-{ev.scoreAway}
              </strong>
            )}
          </p>
          <p className="muted">
            {ev.openBets} open bets, {formatEtb(ev.openStake)} staked
          </p>
          {can('trading.status') && (
            <div className="actions" style={{ marginBottom: 12 }}>
              <ReasonAction
                label="Suspend event"
                optional
                onSubmit={(reason) => post(`/admin/trading/events/${id}/suspend`, { reason })}
              />
              <ReasonAction
                label="Resume event"
                optional
                onSubmit={(reason) => post(`/admin/trading/events/${id}/resume`, { reason })}
              />
              <ReasonAction
                label={ev.bettingOpen ? 'Stop betting' : 'Allow betting'}
                optional
                onSubmit={(reason) =>
                  post(`/admin/trading/events/${id}/betting`, { open: !ev.bettingOpen, reason })
                }
              />
            </div>
          )}
          {can('trading.result') && (
            <>
              <h2>Result</h2>
              <ResultForm eventId={id} onDone={reload} />
            </>
          )}
          <h2>Markets</h2>
          {ev.markets.map((m) => (
            <MarketCard key={m.id} market={m} reload={reload} />
          ))}
        </>
      )}
    </>
  );
}
