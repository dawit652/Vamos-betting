'use client';

import type {
  CompetitionPolicyView,
  CreditKeyView,
  FeedCompetitionsResponse,
  FeedHealthResponse,
  FeedReviewKind,
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
        <Link href="/feed/aliases">Aliases</Link>
      </PageHeader>
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
                  <th key={flag}>{label}</th>
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
