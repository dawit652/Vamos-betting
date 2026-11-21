'use client';

import type {
  CompetitionPolicyView,
  CreditKeyView,
  FeedCompetitionsResponse,
  FeedHealthResponse,
  FeedReviewKind,
  HulusportPricingResponse,
  NarobetPricingResponse,
  SetSourceEnabledResponse,
  SourceHealthView,
  UpdateCompetitionPolicyResponse,
} from '@vamos/contracts';
import Link from 'next/link';
import { useState } from 'react';
import { useFetch } from '@/components/hooks';
import { useSession } from '@/components/session';
import { ActionButton, Badge, Loading, Notice, PageHeader } from '@/components/ui';
import { api } from '@/lib/api';
import { describeError } from '@/lib/errors';
import {
  ageText,
  CREDIT_MODE_LABELS,
  creditModeTone,
  creditsText,
  flagPermission,
  POLICY_FLAG_HINTS,
  POLICY_FLAGS,
  policyFlag,
  PRICING_SOURCES,
  pricingSourcePermission,
  runStatusTone,
  SOURCE_STATE_LABELS,
  sourceStateTone,
} from '@/lib/feed';
import { formatDateTime, humanize } from '@/lib/format';

function SourceRow({ source, onChanged }: { source: SourceHealthView; onChanged: () => void }) {
  const { can } = useSession();
  const toggle = async () => {
    await api<SetSourceEnabledResponse>(`/admin/feed/sources/${source.id}`, {
      method: 'PUT',
      body: { enabled: !source.enabled },
    });
    onChanged();
  };
  return (
    <tr>
      <td>
        {source.name}
        <div className="muted small">
          {source.adapter} · {source.upstream}
        </div>
      </td>
      <td>
        <Badge value={SOURCE_STATE_LABELS[source.state]} tone={sourceStateTone(source.state)} />
      </td>
      <td>
        {source.lastRun === null ? (
          <span className="muted">never</span>
        ) : (
          <>
            <Badge value={source.lastRun.status} tone={runStatusTone(source.lastRun.status)} />{' '}
            <span title={formatDateTime(source.lastRun.startedAt)}>
              {ageText(source.lastRun.startedAt)}
            </span>
          </>
        )}
      </td>
      <td>
        {source.lastRun === null
          ? '–'
          : `${source.lastRun.recordsAccepted} / ${source.lastRun.recordsSeen}`}
      </td>
      <td>{source.consecutiveFailures}</td>
      <td>
        <Link href={`/feed/review?status=open`}>{source.openReviewItems}</Link>
      </td>
      <td>
        {can('trading.status') ? (
          <ActionButton label={source.enabled ? 'Disable' : 'Enable'} onAction={toggle} />
        ) : (
          <span className="muted small">no access</span>
        )}
      </td>
    </tr>
  );
}

function FlagCell({
  policy,
  flag,
  onChanged,
}: {
  policy: CompetitionPolicyView;
  flag: (typeof POLICY_FLAGS)[number][0];
  onChanged: () => void;
}) {
  const { can } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const value = policyFlag(policy, flag);
  const allowed = can(flagPermission(flag, !value));
  const change = async () => {
    setBusy(true);
    setError(null);
    try {
      await api<UpdateCompetitionPolicyResponse>(
        `/admin/feed/competitions/${policy.competitionId}`,
        {
          method: 'PUT',
          body: { [flag]: !value },
        },
      );
      onChanged();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <td>
      <button
        type="button"
        aria-pressed={value}
        disabled={!allowed || busy}
        title={allowed ? undefined : 'Your role may not make this change'}
        onClick={() => void change()}
      >
        {value ? 'on' : 'off'}
      </button>
      {error !== null && <Notice>{error}</Notice>}
    </td>
  );
}

function PricingSourceCell({
  policy,
  onChanged,
}: {
  policy: CompetitionPolicyView;
  onChanged: () => void;
}) {
  const { can } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const change = async (next: 'model' | 'market') => {
    setBusy(true);
    setError(null);
    try {
      await api<UpdateCompetitionPolicyResponse>(
        `/admin/feed/competitions/${policy.competitionId}`,
        { method: 'PUT', body: { pricingSource: next } },
      );
      onChanged();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <td>
      <select
        aria-label={`Prices for ${policy.name} come from`}
        value={policy.pricingSource}
        disabled={busy || !(can('settings.edit') || can('trading.status'))}
        onChange={(event) => {
          const next = event.target.value === 'market' ? 'market' : 'model';
          if (next === policy.pricingSource) return;
          if (!can(pricingSourcePermission(next))) {
            setError('Your role may not make this change');
            return;
          }
          void change(next);
        }}
      >
        {PRICING_SOURCES.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      {error !== null && <Notice>{error}</Notice>}
    </td>
  );
}

/** One key of a metered odds feed: credits left, the guard's mode and each league's reads. */
function CreditPanel({ credit }: { credit: CreditKeyView }) {
  return (
    <section className="panel" aria-label={`Credits of ${credit.key}`} style={{ marginBottom: 12 }}>
      <p>
        <strong>{credit.key}</strong>{' '}
        <Badge
          value={CREDIT_MODE_LABELS[credit.mode] ?? humanize(credit.mode)}
          tone={creditModeTone(credit.mode)}
        />
        {credit.keyRefused && <Badge value="Key refused (HTTP 401)" tone="bad" />}
      </p>
      <p>
        Credits left this month: {creditsText(credit.remaining, credit.quota)}. Spent in the last 24
        h: {credit.spentLast24h.toLocaleString('en-US')}. Last reading: {ageText(credit.lastReadAt)}
        .
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>League source</th>
              <th>Enabled</th>
              <th>Last read</th>
              <th>Next kickoff</th>
            </tr>
          </thead>
          <tbody>
            {credit.sources.map((s) => (
              <tr key={s.id}>
                <td>{s.name}</td>
                <td>{s.enabled ? 'yes' : 'no'}</td>
                <td>{ageText(s.lastRunAt)}</td>
                <td>{s.nextKickoff === null ? '–' : formatDateTime(s.nextKickoff)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * Hulusport prices (docs/plans/hulusport-feed.md): the on/off switch and what the mr-x board
 * delivers. On, every match with fresh Hulusport prices takes them (with our margin) for the
 * markets it already has; off, or when the prices go stale, our own prices come back.
 */
function HulusportPanel() {
  const { can } = useSession();
  const view = useFetch<HulusportPricingResponse>('/admin/feed/hulusport');
  const data = view.data;
  const toggle = async () => {
    if (data === null) return;
    await api<HulusportPricingResponse>('/admin/feed/hulusport', {
      method: 'PUT',
      body: { enabled: !data.enabled },
    });
    view.reload();
  };
  // Turning on needs settings access; turning off (back to our prices) trading access is enough.
  const allowed = data !== null && (data.enabled ? can('trading.status') : can('settings.edit'));
  return (
    <>
      <h2>mr-x prices</h2>
      <Loading loading={view.loading && data === null} error={view.error} />
      {data !== null && (
        <section className="panel" aria-label="mr-x prices" style={{ marginBottom: 12 }}>
          <p>
            <Badge
              value={data.enabled ? 'On: mr-x prices' : 'Off: our own prices'}
              tone={data.enabled ? 'warn' : 'good'}
            />{' '}
            {allowed ? (
              <ActionButton
                label={data.enabled ? 'Switch to our prices' : 'Use mr-x prices'}
                onAction={toggle}
              />
            ) : (
              <span className="muted small">no access</span>
            )}
          </p>
          <p className="muted small">
            {data.updatedAt === null
              ? 'Never switched.'
              : `Last switched ${formatDateTime(data.updatedAt)} by ${data.updatedBy ?? ''}.`}{' '}
            mr-x prices older than {data.maxAgeMinutes} minutes are not used.
          </p>
          <p>
            Board last read: {ageText(data.board.lastReadAt)}. Newest mr-x price:{' '}
            {ageText(data.board.newestPricesAt)}. Upcoming matches: {data.board.upcoming}, linked to
            our matches: {data.board.linked}, with fresh prices: {data.board.fresh}.
          </p>
          <p>
            mr-x-only matches on the site: {data.events.upcoming} upcoming,{' '}
            {data.events.bettingOpen} open for betting. Their results are entered by hand.
          </p>
          {data.events.awaitingResultTotal > 0 && (
            <details open>
              <summary>
                <Badge
                  value={`${data.events.awaitingResultTotal} waiting for a result`}
                  tone="warn"
                />
              </summary>
              <p className="muted small">
                Open a match and enter its final score (and half-time score) to settle its bets.
              </p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Kickoff</th>
                      <th>Game</th>
                      <th>League</th>
                      <th>Match</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.events.awaitingResult.map((e) => (
                      <tr key={e.eventId}>
                        <td>{formatDateTime(e.kickoff)}</td>
                        <td>
                          <Link href={`/trading/${e.eventId}`}>{e.gameId}</Link>
                        </td>
                        <td>{e.competition}</td>
                        <td>
                          {e.home} v {e.away}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
          {data.board.unlinked.length > 0 && (
            <details>
              <summary>Not linked ({data.board.unlinked.length} shown)</summary>
              <p className="muted small">
                Add an alias under Aliases for a team name we do not know; a match whose names are
                known but that we do not list is simply not priced from mr-x.
              </p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Kickoff</th>
                      <th>mr-x league</th>
                      <th>Match</th>
                      <th>Names known</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.board.unlinked.map((m) => (
                      <tr key={`${m.kickoff}|${m.home}|${m.away}`}>
                        <td>{formatDateTime(m.kickoff)}</td>
                        <td>{m.competition}</td>
                        <td>
                          {m.home} v {m.away}
                        </td>
                        <td>{m.teamsResolved ? 'yes (we do not list it)' : 'no'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </section>
      )}
    </>
  );
}

/** "20 minutes" or "7 hours". */
const minutesText = (minutes: number) =>
  minutes % 60 === 0 && minutes >= 60 ? `${minutes / 60} hours` : `${minutes} minutes`;

/**
 * Narobet prices through mr-z (docs/plans/narobet-feed.md): the on/off switch and what mr-z's board
 * delivers. On, a match we already price takes Narobet's fresh prices (with our margin) for the
 * markets it already has, unless fresh mr-x prices come first; off, or when the prices go stale,
 * our own prices come back. Narobet-only matches (docs/plans/narobet-events.md) have a switch of
 * their own and a horizon in days.
 */
function NarobetPanel() {
  const { can } = useSession();
  const view = useFetch<NarobetPricingResponse>('/admin/feed/narobet');
  const data = view.data;
  const toggle = async () => {
    if (data === null) return;
    await api<NarobetPricingResponse>('/admin/feed/narobet', {
      method: 'PUT',
      body: { enabled: !data.enabled },
    });
    view.reload();
  };
  // Turning on needs settings access; turning off (back to our prices) trading access is enough.
  const allowed = data !== null && (data.enabled ? can('trading.status') : can('settings.edit'));
  const [horizon, setHorizon] = useState('');
  const setEvents = async (body: { enabled?: boolean; horizonDays?: number }) => {
    await api<NarobetPricingResponse>('/admin/feed/narobet/events', { method: 'PUT', body });
    setHorizon('');
    view.reload();
  };
  const eventsAllowed =
    data !== null && (data.events.enabled ? can('trading.status') : can('settings.edit'));
  const horizonDays = Number.parseInt(horizon, 10);
  const horizonValid = Number.isInteger(horizonDays) && horizonDays >= 1 && horizonDays <= 30;
  return (
    <>
      <h2>mr-z prices</h2>
      <Loading loading={view.loading && data === null} error={view.error} />
      {data !== null && (
        <section className="panel" aria-label="mr-z prices" style={{ marginBottom: 12 }}>
          <p>
            <Badge
              value={data.enabled ? 'On: mr-z prices' : 'Off: our own prices'}
              tone={data.enabled ? 'warn' : 'good'}
            />{' '}
            {allowed ? (
              <ActionButton
                label={data.enabled ? 'Switch to our prices' : 'Use mr-z prices'}
                onAction={toggle}
              />
            ) : (
              <span className="muted small">no access</span>
            )}
          </p>
          <p className="muted small">
            {data.updatedAt === null
              ? 'Never switched.'
              : `Last switched ${formatDateTime(data.updatedAt)} by ${data.updatedBy ?? ''}.`}{' '}
            Only matches we already list, and only the markets we price; fresh mr-x prices come
            first. mr-z prices are used up to{' '}
            {data.freshness
              .map((step) =>
                step.withinMinutes === null
                  ? `${minutesText(step.maxAgeMinutes)} old for later kickoffs`
                  : `${minutesText(step.maxAgeMinutes)} old for kickoffs within ${minutesText(step.withinMinutes)}`,
              )
              .join(', ')}
            .
          </p>
          <p>
            Board last read: {ageText(data.board.lastReadAt)}. Newest mr-z price:{' '}
            {ageText(data.board.newestPricesAt)}. Upcoming matches: {data.board.upcoming}, linked to
            our matches: {data.board.linked}, with fresh prices: {data.board.fresh}.
          </p>
          <h3>Narobet-only matches</h3>
          <p>
            <Badge
              value={
                data.events.enabled
                  ? `On: listed up to ${data.events.horizonDays} days ahead`
                  : 'Off: not listed'
              }
              tone={data.events.enabled ? 'warn' : 'good'}
            />{' '}
            {eventsAllowed ? (
              <ActionButton
                label={data.events.enabled ? 'Stop listing them' : 'List them'}
                onAction={() => setEvents({ enabled: !data.events.enabled })}
              />
            ) : (
              <span className="muted small">no access</span>
            )}
          </p>
          <p className="muted small">
            Narobet matches in leagues we do not list, priced from mr-z with our margin, never with
            our league or team and never club friendlies. Each pays out at most the cap under
            Settings, &ldquo;Caps for Hulusport-only and Narobet-only matches&rdquo;. Results come
            from API-Football.{' '}
            {data.events.updatedAt === null
              ? 'Never switched.'
              : `Last changed ${formatDateTime(data.events.updatedAt)} by ${data.events.updatedBy ?? ''}.`}
          </p>
          {can('settings.edit') && (
            <p>
              <label>
                Days ahead (1-30){' '}
                <input
                  type="number"
                  min={1}
                  max={30}
                  value={horizon}
                  placeholder={String(data.events.horizonDays)}
                  onChange={(e) => setHorizon(e.target.value)}
                  style={{ width: 70 }}
                />
              </label>{' '}
              {horizonValid && (
                <ActionButton label="Save" onAction={() => setEvents({ horizonDays })} />
              )}
            </p>
          )}
          <p>
            Upcoming Narobet-only matches: {data.events.upcoming}, with betting open:{' '}
            {data.events.bettingOpen}.
          </p>
          {data.events.awaitingResultTotal > 0 && (
            <details open>
              <summary>
                <Badge
                  value={`${data.events.awaitingResultTotal} waiting for a result`}
                  tone="warn"
                />
              </summary>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Kickoff</th>
                      <th>Game</th>
                      <th>League</th>
                      <th>Match</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.events.awaitingResult.map((e) => (
                      <tr key={e.eventId}>
                        <td>{formatDateTime(e.kickoff)}</td>
                        <td>
                          <Link href={`/trading/${e.eventId}`}>{e.gameId}</Link>
                        </td>
                        <td>{e.competition}</td>
                        <td>
                          {e.home} v {e.away}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
          {data.board.unlinked.length > 0 && (
            <details>
              <summary>Not linked ({data.board.unlinked.length} shown)</summary>
              <p className="muted small">
                Add an alias under Aliases for a team name we do not know. A match we do not list is
                priced from mr-z only as a Narobet-only match (above).
              </p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Kickoff</th>
                      <th>mr-z league</th>
                      <th>Match</th>
                      <th>Names known</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.board.unlinked.map((m) => (
                      <tr key={`${m.kickoff}|${m.home}|${m.away}`}>
                        <td>{formatDateTime(m.kickoff)}</td>
                        <td>{m.competition}</td>
                        <td>
                          {m.home} v {m.away}
                        </td>
                        <td>{m.teamsResolved ? 'yes (we do not list it)' : 'no'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </section>
      )}
    </>
  );
}

export default function FeedOverviewPage() {
  const health = useFetch<FeedHealthResponse>('/admin/feed/health');
  const competitions = useFetch<FeedCompetitionsResponse>('/admin/feed/competitions');
  const reloadAll = () => {
    health.reload();
    competitions.reload();
  };
  const data = health.data;

  return (
    <>
      <PageHeader title="Feed">
        <Link href="/feed/review">Review queue</Link>
        <Link href="/feed/review/unknown-names">Unknown names</Link>
        <Link href="/feed/ratings">Ratings</Link>
        <Link href="/feed/aliases">Aliases</Link>
        <Link href="/feed/families">Market families</Link>
      </PageHeader>
      <HulusportPanel />
      <NarobetPanel />
      <Loading loading={health.loading && data === null} error={health.error} />
      {data !== null && (
        <>
          <h2>Sources</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Source</th>
                  <th>State</th>
                  <th>Last run</th>
                  <th>Accepted / seen</th>
                  <th>Failures in a row</th>
                  <th>Open items</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.sources.map((s) => (
                  <SourceRow key={s.id} source={s} onChanged={reloadAll} />
                ))}
              </tbody>
            </table>
          </div>
          {data.sources.length === 0 && <p className="muted">No sources.</p>}

          {data.credits.length > 0 && (
            <>
              <h2>Bookmaker odds credits</h2>
              {data.credits.map((credit) => (
                <CreditPanel key={credit.key} credit={credit} />
              ))}
            </>
          )}

          <h2>Review queue ({data.queue.open} open)</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Open</th>
                </tr>
              </thead>
              <tbody>
                {(Object.entries(data.queue.byKind) as [FeedReviewKind, number][])
                  .filter(([, count]) => count > 0)
                  .map(([kind, count]) => (
                    <tr key={kind}>
                      <td>
                        <Link href={`/feed/review?status=open&kind=${kind}`}>{humanize(kind)}</Link>
                      </td>
                      <td>{count}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          {data.queue.open === 0 && <p className="muted">Nothing to review.</p>}
        </>
      )}

      <h2>Competitions</h2>
      <Loading
        loading={competitions.loading && competitions.data === null}
        error={competitions.error}
      />
      {competitions.data !== null && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Competition</th>
                {POLICY_FLAGS.map(([flag, label]) => (
                  <th key={flag}>
                    {label}
                    {POLICY_FLAG_HINTS[flag] !== undefined && (
                      <div className="muted small">{POLICY_FLAG_HINTS[flag]}</div>
                    )}
                  </th>
                ))}
                <th>Prices from</th>
                <th>Changed</th>
              </tr>
            </thead>
            <tbody>
              {competitions.data.items.map((c) => (
                <tr key={c.competitionId}>
                  <td>{c.name}</td>
                  {POLICY_FLAGS.map(([flag]) => (
                    <FlagCell key={flag} policy={c} flag={flag} onChanged={reloadAll} />
                  ))}
                  <PricingSourceCell policy={c} onChanged={reloadAll} />
                  <td className="muted small">
                    {c.updatedAt === null
                      ? 'never'
                      : `${formatDateTime(c.updatedAt)} by ${c.updatedBy ?? ''}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">
        Turning a flag off needs trading access; turning one on, or changing extra time, needs
        settings access. Prices come from the team-rating model unless a competition is set to take
        them from the licensed bookmaker feed first; setting it back to the model needs trading
        access.
      </p>
    </>
  );
}
