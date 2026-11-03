'use client';

import type {
  FeedLeagueView,
  FeedReviewItemView,
  FeedReviewListResponse,
  FeedStatusResponse,
} from '@vamos/contracts';
import Link from 'next/link';
import { useState } from 'react';
import { useFetch } from '@/components/hooks';
import { useSession } from '@/components/session';
import { Badge, Loading, Notice, PageHeader, ReasonAction, Stat } from '@/components/ui';
import { api } from '@/lib/api';
import { describeError } from '@/lib/errors';
import { groupBySport, marginToInput, parseMarginInput } from '@/lib/feed';
import { formatDateTime, humanize, nameOf } from '@/lib/format';

function LeagueRow({
  league,
  canManage,
  onChanged,
}: {
  league: FeedLeagueView;
  canManage: boolean;
  onChanged: () => void;
}) {
  const [margin, setMargin] = useState(marginToInput(league.marginBps));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const saved = marginToInput(league.marginBps);

  async function patch(body: { enabled?: boolean; marginBps?: number | null }) {
    setBusy(true);
    setError(null);
    try {
      await api(`/admin/feed/leagues/${encodeURIComponent(league.sportKey)}`, {
        method: 'PATCH',
        body,
      });
      onChanged();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  function saveMargin() {
    const parsed = parseMarginInput(margin);
    if (parsed === undefined) {
      setError(
        'Margin is a percent from 0 to 30 with up to two decimals, or blank for the default.',
      );
      return;
    }
    void patch({ marginBps: parsed });
  }

  return (
    <tr>
      <td>{league.title}</td>
      <td>
        <code>{league.sportKey}</code>
      </td>
      <td>
        <Badge
          value={league.active ? 'active' : 'inactive'}
          tone={league.active ? 'good' : 'muted'}
        />
      </td>
      <td className="num">{league.eventCount}</td>
      <td className="num">{league.liveCount}</td>
      <td>{formatDateTime(league.nextStartAt)}</td>
      <td>{formatDateTime(league.lastOddsAt)}</td>
      <td>
        {league.lastError === null ? (
          '–'
        ) : (
          <span title={league.lastError}>
            {league.lastError.slice(0, 60)} ({formatDateTime(league.lastErrorAt)})
          </span>
        )}
      </td>
      <td>
        <input
          type="checkbox"
          aria-label={`Enable ${league.title}`}
          checked={league.enabled}
          disabled={!canManage || busy}
          onChange={(e) => void patch({ enabled: e.target.checked })}
        />
      </td>
      <td>
        <div className="actions">
          <input
            aria-label={`Margin of ${league.title} in percent`}
            placeholder="default"
            size={7}
            value={margin}
            disabled={!canManage || busy}
            onChange={(e) => setMargin(e.target.value)}
          />
          {canManage && margin !== saved && (
            <button type="button" className="primary" disabled={busy} onClick={saveMargin}>
              Save
            </button>
          )}
        </div>
        {error !== null && <Notice>{error}</Notice>}
      </td>
    </tr>
  );
}

function Leagues({
  leagues,
  canManage,
  onChanged,
}: {
  leagues: FeedLeagueView[];
  canManage: boolean;
  onChanged: () => void;
}) {
  return (
    <>
      {groupBySport(leagues).map(([sport, list]) => (
        <section key={sport}>
          <h3>{humanize(sport)}</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>League</th>
                  <th>Key</th>
                  <th>Feed</th>
                  <th className="num">Events</th>
                  <th className="num">Live</th>
                  <th>Next start</th>
                  <th>Last odds poll</th>
                  <th>Last error</th>
                  <th>Enabled</th>
                  <th>Margin %</th>
                </tr>
              </thead>
              <tbody>
                {list.map((league) => (
                  <LeagueRow
                    key={league.sportKey}
                    league={league}
                    canManage={canManage}
                    onChanged={onChanged}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </>
  );
}

function ReviewQueue({ canResult }: { canResult: boolean }) {
  const queue = useFetch<FeedReviewListResponse>('/admin/feed/results');
  const items: FeedReviewItemView[] = queue.data?.items ?? [];

  async function decide(eventId: string, action: 'accept' | 'void', reason: string) {
    await api(`/admin/feed/results/${eventId}/${action}`, {
      method: 'POST',
      body: reason === '' ? {} : { reason },
    });
    queue.reload();
  }

  return (
    <>
      <h2>Results to review</h2>
      <Loading loading={queue.loading && queue.data === null} error={queue.error} />
      {queue.data !== null && items.length === 0 && <p className="muted">Nothing waiting.</p>}
      {items.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Game</th>
                <th>Match</th>
                <th>Competition</th>
                <th>Start</th>
                <th>Why</th>
                <th>Feed score</th>
                <th>First seen</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const hasScore = item.scoreHome !== null && item.scoreAway !== null;
                return (
                  <tr key={item.eventId}>
                    <td>{item.gameId}</td>
                    <td>
                      {nameOf(item.homeTeam)} v {nameOf(item.awayTeam)}
                    </td>
                    <td>{nameOf(item.competition)}</td>
                    <td>{formatDateTime(item.startTime)}</td>
                    <td>
                      <Badge value={item.reviewReason} tone="warn" />
                    </td>
                    <td>{hasScore ? `${item.scoreHome} – ${item.scoreAway}` : 'none'}</td>
                    <td>{formatDateTime(item.firstSeenAt)}</td>
                    <td>
                      {canResult && (
                        <div className="actions">
                          {hasScore ? (
                            <ReasonAction
                              label={`Accept ${item.scoreHome}–${item.scoreAway}`}
                              submitLabel="Accept"
                              optional
                              prompt="Reason (optional)"
                              onSubmit={(reason) => decide(item.eventId, 'accept', reason)}
                            />
                          ) : (
                            <Link href={`/trading/${item.eventId}`}>Result on trading screen</Link>
                          )}
                          <ReasonAction
                            label="Void"
                            submitLabel="Void event"
                            danger
                            optional
                            prompt="Reason (optional)"
                            onSubmit={(reason) => decide(item.eventId, 'void', reason)}
                          />
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export default function FeedPage() {
  const { can } = useSession();
  const status = useFetch<FeedStatusResponse>('/admin/feed');
  const data = status.data;

  return (
    <>
      <PageHeader title="Feed">
        <button type="button" onClick={status.reload}>
          Refresh
        </button>
      </PageHeader>
      <Loading loading={status.loading && data === null} error={status.error} />
      {data !== null && (
        <>
          <div className="stats">
            <Stat
              label="Credits remaining"
              value={data.quota === null ? '–' : data.quota.remaining.toLocaleString('en')}
              hint={
                data.quota === null
                  ? 'No call has reported a quota yet'
                  : `as of ${formatDateTime(data.quota.at)}`
              }
            />
            <Stat label="Spent, last 24 hours" value={data.creditsLast24h.toLocaleString('en')} />
            <Stat label="Spent, last 30 days" value={data.creditsLast30d.toLocaleString('en')} />
          </div>
          <h2>Leagues</h2>
          {data.leagues.length === 0 && <p className="muted">No leagues yet.</p>}
          <Leagues
            leagues={data.leagues}
            canManage={can('feed.manage')}
            onChanged={status.reload}
          />
        </>
      )}
      <ReviewQueue canResult={can('trading.result')} />
    </>
  );
}
