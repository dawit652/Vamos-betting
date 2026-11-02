import type {
  CompetitionPolicyView,
  FeedScoreView,
  FeedSourceState,
  ReviewItemView,
} from '@vamos/contracts';
import { formatDateTime, formatOdds, humanize } from './format';

/** Pure helpers for the feed pages. Money stays a decimal string of santim. */

type Tone = 'good' | 'warn' | 'bad' | 'muted';

export const SOURCE_STATE_LABELS: Record<FeedSourceState, string> = {
  ok: 'ok',
  stale: 'stale',
  broken: 'broken',
  blocked: 'blocked',
  learning: 'learning',
  disabled: 'disabled',
};

export function sourceStateTone(state: FeedSourceState): Tone {
  switch (state) {
    case 'ok':
      return 'good';
    case 'learning':
    case 'stale':
      return 'warn';
    case 'broken':
    case 'blocked':
      return 'bad';
    case 'disabled':
      return 'muted';
  }
}

export function severityTone(severity: string): Tone {
  return severity === 'critical' ? 'bad' : severity === 'warning' ? 'warn' : 'muted';
}

export function reviewStatusTone(status: string): Tone {
  return status === 'open' ? 'warn' : 'muted';
}

export function runStatusTone(status: string): Tone {
  if (status === 'ok') return 'good';
  if (status === 'running' || status === 'skipped') return 'muted';
  return 'bad';
}

/** "2-1", or "2-1 (HT 1-0)" when the half-time score is known. */
export function scoreText(score: FeedScoreView | null | undefined): string {
  if (score === null || score === undefined) return '–';
  const full = `${score.home}-${score.away}`;
  return score.htHome !== null && score.htAway !== null
    ? `${full} (HT ${score.htHome}-${score.htAway})`
    : full;
}

/** "5 min ago", "3 h ago", "2 d ago"; "just now" under a minute; "–" for a bad date. */
export function ageText(iso: string | null | undefined, now: Date = new Date()): string {
  if (iso === null || iso === undefined) return '–';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '–';
  const minutes = Math.floor((now.getTime() - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** "62%" for a suggestion score between 0 and 1. */
export function scorePercent(score: number): string {
  return `${Math.round(Math.min(1, Math.max(0, score)) * 100)}%`;
}

/** Whether "Apply this result" is offered: only an open result_ready or result_unverified item. */
export function canApplyResult(item: Pick<ReviewItemView, 'kind' | 'status'>): boolean {
  return (
    item.status === 'open' && (item.kind === 'result_ready' || item.kind === 'result_unverified')
  );
}

/** The kinds that end with a button of their own; every other open kind can only be dismissed. */
export function isOpen(item: Pick<ReviewItemView, 'status'>): boolean {
  return item.status === 'open';
}

/** The permission a decision needs (as the API checks it). */
export function decisionPermission(
  decision: string,
): 'trading.result' | 'trading.odds' | 'trading.status' {
  if (decision === 'apply_result') return 'trading.result';
  return decision === 'apply_reprice' ? 'trading.odds' : 'trading.status';
}

/**
 * The permission a competition flag change needs: turning `enabled`, `autoOpen` or
 * `autoResults` off needs `trading.status`; anything else needs `settings.edit`.
 */
export function flagPermission(
  flag: 'enabled' | 'autoOpen' | 'autoResults' | 'extraTime',
  next: boolean,
): 'trading.status' | 'settings.edit' {
  return flag !== 'extraTime' && !next ? 'trading.status' : 'settings.edit';
}

/**
 * The permission a change of where a competition's prices come from needs: back to the model is
 * a safety action (`trading.status`); switching to the market feed needs `settings.edit`.
 */
export function pricingSourcePermission(
  next: 'model' | 'market',
): 'trading.status' | 'settings.edit' {
  return next === 'model' ? 'trading.status' : 'settings.edit';
}

export const PRICING_SOURCES = [
  ['model', 'Team ratings (model)'],
  ['market', 'Bookmaker feed first'],
] as const;

export const POLICY_FLAGS = [
  ['enabled', 'Enabled'],
  ['autoOpen', 'Auto open'],
  ['autoResults', 'Auto results'],
  ['extraTime', 'Extra time'],
] as const;

export function policyFlag(
  policy: CompetitionPolicyView,
  flag: (typeof POLICY_FLAGS)[number][0],
): boolean {
  return policy[flag];
}

/** "3 open bets, stake 1,200.00" – the stake is formatted by the caller. */
export function exposureText(openBets: number, formattedStake: string): string {
  if (openBets === 0) return 'No open bets';
  return `${openBets} open ${openBets === 1 ? 'bet' : 'bets'}, stake ${formattedStake}`;
}

/** The repeated-score sentence of the confirm step. */
export function confirmApplyText(payload: {
  home: string;
  away: string;
  score: FeedScoreView;
}): string {
  return `Apply ${payload.home} ${payload.score.home}-${payload.score.away} ${payload.away}?`;
}

/** A line per kind for the list; falls back to the humanized kind. */
export function kindLabel(kind: string): string {
  return humanize(kind);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** A one-line summary of a review payload for the list, read defensively (never throws). */
export function payloadSummary(kind: string, payload: Record<string, unknown>): string {
  const match =
    str(payload.home) !== null && str(payload.away) !== null
      ? `${String(payload.home)} v ${String(payload.away)}`
      : null;
  switch (kind) {
    case 'unknown_team':
    case 'unknown_competition':
      return str(payload.raw) ?? '–';
    case 'result_ready':
    case 'result_unverified': {
      const score = payload.score as FeedScoreView | undefined;
      return `${match ?? '–'}: ${scoreText(score)}`;
    }
    case 'result_conflict':
    case 'result_correction':
    case 'odds_approval':
    case 'ratings_uncalibrated':
      return match ?? '–';
    case 'result_overdue': {
      const hours = payload.hoursSinceKickoff;
      return `${match ?? '–'}: ${typeof hours === 'number' ? `${hours} h after kickoff` : 'no result'}`;
    }
    case 'source_stale': {
      const hours = payload.hoursUnchanged;
      const due = payload.dueMatches;
      return `${str(payload.sourceName) ?? str(payload.sourceId) ?? '–'}: ${
        typeof hours === 'number' ? `${hours} h unchanged` : 'unchanged'
      }${typeof due === 'number' ? `, ${due} ${due === 1 ? 'match' : 'matches'} waiting` : ''}`;
    }
    case 'source_broken':
      return str(payload.reason) ?? str(payload.sourceId) ?? '–';
    case 'kickoff_change':
      return `${formatDateTime(str(payload.currentKickoff))} to ${formatDateTime(str(payload.proposedKickoff))}`;
    default:
      return str(payload.detail) ?? '–';
  }
}

/** "Over 2.5: 1.85, Under 2.5: 1.95" style text for a proposed price. */
export function priceText(name: string, oddsMilli: number, previousOddsMilli?: number): string {
  const now = formatOdds(oddsMilli);
  return previousOddsMilli === undefined
    ? `${name} ${now}`
    : `${name} ${formatOdds(previousOddsMilli)} to ${now}`;
}

/** The query of the review list: empty filters are left out. */
export function reviewQuery(status: string, kind: string): Record<string, string> {
  const query: Record<string, string> = {};
  if (status !== '') query.status = status;
  if (kind !== '') query.kind = kind;
  return query;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether text is a target id the API accepts (a UUID). */
export function isTargetId(text: string): boolean {
  return UUID.test(text.trim());
}

/** The alias form's problem, or null when it can be sent. */
export function validateAliasForm(input: { raw: string; targetId: string }): string | null {
  const raw = input.raw.trim();
  if (raw === '') return 'Enter the raw name.';
  if (raw.length > 120) return 'The name is at most 120 characters.';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return 'Control characters are not allowed.';
  if (!isTargetId(input.targetId)) return 'Choose a target (its id is a UUID).';
  return null;
}

/** A closed item's resolution as a sentence: "dismiss: the note", "map alias", "apply result". */
export function resolutionText(resolution: Record<string, unknown> | null | undefined): string {
  if (resolution === null || resolution === undefined) return '–';
  const decision = str(resolution.decision);
  const note = str(resolution.note);
  const head = decision === null ? 'closed' : humanize(decision).toLowerCase();
  const base = note === null ? head : `${head}: ${note}`;
  return base;
}

/** Who closed an item: "system:scraper" as is, a staff id shortened to its first eight characters. */
export function closedByText(resolvedBy: string | null | undefined): string {
  if (resolvedBy === null || resolvedBy === undefined || resolvedBy === '') return '–';
  return UUID.test(resolvedBy) ? `staff ${resolvedBy.slice(0, 8)}` : resolvedBy;
}

/** The credit guard's mode as staff read it (docs/theoddsapi-plan/README.md 4.7). */
export const CREDIT_MODE_LABELS: Readonly<Record<string, string>> = {
  normal: 'Normal',
  economy: 'Economy (reading less often)',
  minimal: 'Minimal (only matches within 3 h)',
  stop: 'Stopped',
};

export function creditModeTone(mode: string): Tone {
  if (mode === 'normal') return 'good';
  if (mode === 'economy' || mode === 'minimal') return 'warn';
  return 'bad';
}

/** "1,234 of 20,000 (6%)", or "–" before any reading. */
export function creditsText(remaining: number | null, quota: number | null): string {
  if (remaining === null) return '–';
  if (quota === null || quota <= 0) return remaining.toLocaleString('en-US');
  const percent = Math.floor((remaining * 100) / quota);
  return `${remaining.toLocaleString('en-US')} of ${quota.toLocaleString('en-US')} (${percent}%)`;
}
