'use client';

import {
  isRepriceItem,
  parseReviewPayload,
  type ResolveReviewResponse,
  type ReviewDetailResponse,
  type ReviewItemView,
} from '@vamos/contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { useFetch } from '@/components/hooks';
import { useSession } from '@/components/session';
import {
  ActionButton,
  Badge,
  DefList,
  Field,
  Loading,
  Notice,
  PageHeader,
  ReasonAction,
} from '@/components/ui';
import { api } from '@/lib/api';
import {
  ageText,
  canApplyResult,
  confirmApplyText,
  decisionPermission,
  exposureText,
  isOpen,
  isTargetId,
  kindLabel,
  priceText,
  reviewStatusTone,
  scorePercent,
  scoreText,
  severityTone,
} from '@/lib/feed';
import { formatDateTime, formatEtb, humanize } from '@/lib/format';

type Resolve = (body: Record<string, unknown>) => Promise<void>;

function Votes({ votes }: { votes: { sourceId: string; upstream: string; changedAt: string }[] }) {
  if (votes.length === 0) return <span className="muted">none</span>;
  return (
    <ul>
      {votes.map((v) => (
        <li key={`${v.sourceId}`}>
          {v.sourceId} (upstream {v.upstream}), since {formatDateTime(v.changedAt)}
        </li>
      ))}
    </ul>
  );
}

function Match({ p }: { p: { gameId: string; home: string; away: string; kickoff: string } }) {
  return (
    <>
      {p.home} v {p.away} (game {p.gameId}), kickoff {formatDateTime(p.kickoff)}
    </>
  );
}

/** "Apply this result" with a confirm step that repeats the score. No score input exists. */
function ApplyResult({
  home,
  away,
  score,
  resolve,
}: {
  home: string;
  away: string;
  score: Parameters<typeof confirmApplyText>[0]['score'];
  resolve: Resolve;
}) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button type="button" className="primary" onClick={() => setConfirming(true)}>
        Apply this result
      </button>
    );
  }
  return (
    <div className="inline-form">
      <strong>{confirmApplyText({ home, away, score })}</strong>
      <ActionButton
        primary
        label={`Confirm ${scoreText(score)}`}
        onAction={() => resolve({ decision: 'apply_result' })}
      />
      <button type="button" onClick={() => setConfirming(false)}>
        Cancel
      </button>
    </div>
  );
}

function MapAlias({
  suggestions,
  resolve,
}: {
  suggestions: { id: string; name: string; score: number }[];
  resolve: Resolve;
}) {
  const [picked, setPicked] = useState(suggestions[0]?.id ?? '');
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const targetId = typed.trim() !== '' ? typed.trim() : picked;
  return (
    <div>
      {suggestions.length > 0 && (
        <Field label="Suggestions">
          <select value={picked} onChange={(e) => setPicked(e.target.value)}>
            {suggestions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({scorePercent(s.score)})
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Or the id of another one">
        <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="uuid" />
      </Field>
      <ActionButton
        primary
        label="Map to this team"
        onAction={async () => {
          if (!isTargetId(targetId)) {
            setError('Choose a suggestion or enter a valid id.');
            return;
          }
          setError(null);
          await resolve({ decision: 'map_alias', targetId });
        }}
      />
      {error !== null && <Notice>{error}</Notice>}
    </div>
  );
}

function Observations({
  observations,
}: {
  observations: {
    sourceId: string;
    upstream: string;
    status: string;
    score: Parameters<typeof scoreText>[0];
    scoreBasis: string;
    changedAt: string;
  }[];
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Source</th>
            <th>Upstream</th>
            <th>Status</th>
            <th>Score</th>
            <th>Basis</th>
            <th>Since</th>
          </tr>
        </thead>
        <tbody>
          {observations.map((o) => (
            <tr key={o.sourceId}>
              <td>{o.sourceId}</td>
              <td>{o.upstream}</td>
              <td>{humanize(o.status)}</td>
              <td>{scoreText(o.score)}</td>
              <td>{humanize(o.scoreBasis)}</td>
              <td>{formatDateTime(o.changedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Body({
  item,
  resolve,
  can,
}: {
  item: ReviewItemView;
  resolve: Resolve;
  can: (permission: string) => boolean;
}) {
  const kind = item.kind;
  const open = isOpen(item);
  const allow = (decision: string) => open && can(decisionPermission(decision));
  const raw = (): ReactNode => (
    <>
      <p className="muted">The detail of this item could not be read.</p>
      <pre className="small">{JSON.stringify(item.payload, null, 2)}</pre>
    </>
  );

  switch (kind) {
    case 'result_ready':
    case 'result_unverified': {
      const p = parseReviewPayload(kind, item.payload);
      if (p === null) return raw();
      return (
        <>
          <DefList
            rows={[
              ['Match', <Match key="m" p={p} />],
              ['Proposed score', <strong key="s">{scoreText(p.score)}</strong>],
              ['Agreeing sources', <Votes key="v" votes={p.sources} />],
              ['Exposure', exposureText(p.exposure.openBets, formatEtb(p.exposure.totalStake))],
            ]}
          />
          {canApplyResult(item) && allow('apply_result') && (
            <ApplyResult home={p.home} away={p.away} score={p.score} resolve={resolve} />
          )}
          {canApplyResult(item) && !allow('apply_result') && (
            <p className="muted small">Your role may not apply results.</p>
          )}
        </>
      );
    }
    case 'result_conflict':
    case 'result_correction': {
      const p = parseReviewPayload(kind, item.payload);
      if (p === null) return raw();
      return (
        <>
          <DefList
            rows={[
              ['Match', <Match key="m" p={p} />],
              ['Applied score', scoreText(p.appliedScore)],
              [
                'Exposure',
                p.exposure === undefined
                  ? '–'
                  : exposureText(p.exposure.openBets, formatEtb(p.exposure.totalStake)),
              ],
            ]}
          />
          <h3>Observations</h3>
          <Observations observations={p.observations} />
          <p className="muted small">A person decides this in the trading screens.</p>
        </>
      );
    }
    case 'odds_approval':
    case 'ratings_uncalibrated': {
      const p = parseReviewPayload(kind, item.payload);
      if (p === null) return raw();
      return (
        <>
          <DefList
            rows={[
              ['Match', <Match key="m" p={p} />],
              ['Why', p.reason ?? '–'],
              [
                'Prices',
                p.markets.length === 0 ? (
                  '–'
                ) : (
                  <ul key="p">
                    {p.markets.map((m) => (
                      <li key={m.market}>
                        {humanize(m.market)}:{' '}
                        {m.selections
                          .map((s) => priceText(s.name, s.oddsMilli, s.previousOddsMilli))
                          .join(', ')}
                      </li>
                    ))}
                  </ul>
                ),
              ],
            ]}
          />
          {kind === 'odds_approval' && !isRepriceItem(item) && allow('open_betting') && (
            <ActionButton
              primary
              label="Open betting"
              onAction={() => resolve({ decision: 'open_betting' })}
            />
          )}
          {isRepriceItem(item) && p.proposal !== undefined && allow('apply_reprice') && (
            <ActionButton
              primary
              label="Apply the proposed prices"
              onAction={() => resolve({ decision: 'apply_reprice' })}
            />
          )}
        </>
      );
    }
    case 'unknown_team':
    case 'unknown_competition': {
      const p = parseReviewPayload(kind, item.payload);
      if (p === null) return raw();
      return (
        <>
          <DefList
            rows={[
              ['Raw name', <strong key="r">{p.raw}</strong>],
              ['Source', p.sourceId],
              ['Competition label', 'competition' in p ? p.competition : '–'],
              [
                'Suggestions',
                p.suggestions.length === 0 ? (
                  'none'
                ) : (
                  <ul key="s">
                    {p.suggestions.map((s) => (
                      <li key={s.id}>
                        {s.name} ({scorePercent(s.score)})
                      </li>
                    ))}
                  </ul>
                ),
              ],
            ]}
          />
          {allow('map_alias') && <MapAlias suggestions={p.suggestions} resolve={resolve} />}
        </>
      );
    }
    case 'kickoff_change': {
      const p = parseReviewPayload(kind, item.payload);
      if (p === null) return raw();
      return (
        <>
          <DefList
            rows={[
              ['Current kickoff', formatDateTime(p.currentKickoff)],
              ['Proposed kickoff', <strong key="k">{formatDateTime(p.proposedKickoff)}</strong>],
              ['Sources', <Votes key="v" votes={p.sources} />],
              ['Bets', p.hasBets ? 'Bets exist on this event' : 'No bets yet'],
            ]}
          />
          {allow('apply_kickoff') && (
            <ActionButton
              primary
              label="Apply new kickoff"
              onAction={() => resolve({ decision: 'apply_kickoff' })}
            />
          )}
        </>
      );
    }
    case 'source_broken': {
      const p = parseReviewPayload(kind, item.payload);
      if (p === null) return raw();
      return (
        <DefList
          rows={[
            ['Source', p.sourceId],
            ['Run', p.runId],
            ['Reason', p.reason],
            ['Records accepted', String(p.recordsAccepted)],
            ['Usual yield', p.baseline === null ? '–' : String(p.baseline)],
          ]}
        />
      );
    }
    default: {
      const p = parseReviewPayload(kind, item.payload) as { detail?: string } | null;
      if (p === null) return raw();
      return <p>{p.detail ?? '–'}</p>;
    }
  }
}

export default function ReviewItemPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const { data, error, loading, reload } = useFetch<ReviewDetailResponse>(
    `/admin/feed/review/${id}`,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const item = data?.item ?? null;

  const resolve: Resolve = async (body) => {
    setNotice(null);
    await api<ResolveReviewResponse>(`/admin/feed/review/${id}/resolve`, { method: 'POST', body });
    setNotice('Saved.');
    reload();
  };
  const dismiss = (note: string) => resolve({ decision: 'dismiss', note });

  return (
    <>
      <PageHeader title="Review item">
        <Link href="/feed/review">Back to queue</Link>
      </PageHeader>
      <Loading loading={loading && data === null} error={error} />
      {notice !== null && <Notice kind="ok">{notice}</Notice>}
      {item !== null && (
        <section className="panel">
          <h2>{item.title}</h2>
          <DefList
            rows={[
              ['Kind', kindLabel(item.kind)],
              [
                'Severity',
                <Badge key="v" value={item.severity} tone={severityTone(item.severity)} />,
              ],
              [
                'Status',
                <Badge key="s" value={item.status} tone={reviewStatusTone(item.status)} />,
              ],
              ['Raised', `${formatDateTime(item.createdAt)} (${ageText(item.createdAt)})`],
              ...(item.status === 'open'
                ? []
                : ([
                    ['Closed', `${formatDateTime(item.resolvedAt)} by ${item.resolvedBy ?? ''}`],
                    ['Resolution', JSON.stringify(item.resolution)],
                  ] as [string, ReactNode][])),
            ]}
          />
          <Body item={item} resolve={resolve} can={can} />
          {isOpen(item) && can('trading.status') && (
            <div className="actions">
              <ReasonAction label="Dismiss" prompt="Note (required)" onSubmit={dismiss} />
            </div>
          )}
        </section>
      )}
    </>
  );
}
