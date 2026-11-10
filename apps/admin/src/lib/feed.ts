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

export interface DismissalsView {
  count: number;
  lastNote: string | null;
  lastAt: string | null;
}

/** Q-3: what earlier dismissals of a re-raised item said; null when none or the payload is odd. */
export function readDismissals(payload: unknown): DismissalsView | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const d = (payload as Record<string, unknown>).dismissals;
  if (typeof d !== 'object' || d === null) return null;
  const { count, lastNote, lastAt } = d as Record<string, unknown>;
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 1) return null;
  return { count, lastNote: str(lastNote), lastAt: str(lastAt) };
}

/** "dismissed 2 times, last: the note" for a list row or detail; null when never dismissed. */
export function dismissalsText(payload: unknown): string | null {
  const d = readDismissals(payload);
  if (d === null) return null;
  const head = `dismissed ${d.count} ${d.count === 1 ? 'time' : 'times'}`;
  const when = d.lastAt === null ? '' : ` (last ${formatDateTime(d.lastAt)})`;
  return d.lastNote === null ? `${head}${when}` : `${head}${when}, last note: ${d.lastNote}`;
}

/** A one-line summary of a review payload for the list, read defensively (never throws). */
export function payloadSummary(kind: string, payload: Record<string, unknown>): string {
  const base = payloadBaseSummary(kind, payload);
  const dismissed = dismissalsText(payload);
  return dismissed === null ? base : `${base} [${dismissed}]`;
}

function payloadBaseSummary(kind: string, payload: Record<string, unknown>): string {
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
      return match ?? '–';
    case 'ratings_uncalibrated': {
      // R-2: the teams O1 waits for and their rated matches (items raised before R-2 have none).
      const teams = Array.isArray(payload.uncalibratedTeams) ? payload.uncalibratedTeams : [];
      const named = teams
        .map((t: unknown) => {
          if (typeof t !== 'object' || t === null) return null;
          const team = t as Record<string, unknown>;
          const name = str(team.name);
          if (name === null) return null;
          return typeof team.matches === 'number' && typeof team.needed === 'number'
            ? `${name} ${team.matches}/${team.needed}`
            : name;
        })
        .filter((t): t is string => t !== null);
      return named.length > 0 ? `${match ?? '–'}: unrated ${named.join(', ')}` : (match ?? '–');
    }
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

// ---------------------------------------------------------------------------
// Review page: fixture disagreements (F-1) and pricing facts (A-3). Payloads are read as
// plain unknown values, never through a schema that could reject or strip them: older items
// lack the newer fields, and none of these helpers throws.

function rec(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export interface DisagreementReason {
  code: string;
  /** The gate rule that raised it (F1 ... F6), when the payload names one. */
  rule: string | null;
  label: string;
  /** What the gate recorded for this reason, as a sentence; null when it recorded nothing. */
  text: string | null;
}

export interface DisagreementObservation {
  source: string;
  status: string;
  kickoff: string;
  since: string;
}

export interface DisagreementCluster {
  sources: string;
  kickoffs: string;
  statuses: string;
}

export interface FixtureDisagreement {
  reasons: DisagreementReason[];
  /** Label and value pairs: the event's own kickoff and status, the kickoff the sources show, the sources. */
  facts: [string, string][];
  /** One row per source observation in the cluster (when the gate stored them). */
  observations: DisagreementObservation[];
  /** One row per cluster of sources that disagree with each other (rule F1). */
  clusters: DisagreementCluster[];
}

const REASON_LABELS: Readonly<Record<string, string>> = {
  mixed_cluster: 'Sources name different pairings',
  invalid_observation: 'A source row is not usable',
  candidate_mismatch: 'A matching event does not fit',
  ambiguous_match: 'More than one event matches',
  status_disagreement: 'Sources disagree on the status',
  kickoff_disagreement: 'Sources disagree on the kickoff',
  sources_disagree: 'Sources disagree on the kickoff',
  feed_ref_exists: 'The fixture already exists as an event',
};

function reasonText(code: string, detail: unknown): string | null {
  if (detail === undefined || detail === null) return null;
  switch (code) {
    case 'status_disagreement': {
      const parts = strings(detail).map((entry) => {
        const at = entry.lastIndexOf(':');
        return at <= 0
          ? entry
          : `${entry.slice(0, at)}: ${humanize(entry.slice(at + 1)).toLowerCase()}`;
      });
      return parts.length > 0 ? parts.join('; ') : null;
    }
    case 'kickoff_disagreement': {
      const d = rec(detail);
      const earliest = str(d?.earliest);
      const latest = str(d?.latest);
      return earliest === null || latest === null
        ? null
        : `earliest ${formatDateTime(earliest)}, latest ${formatDateTime(latest)}`;
    }
    case 'mixed_cluster': {
      const names = strings(detail);
      return names.length > 0 ? names.join('; ') : null;
    }
    case 'candidate_mismatch':
    case 'ambiguous_match': {
      const ids = strings(detail);
      return ids.length > 0 ? `events ${ids.join(', ')}` : null;
    }
    case 'invalid_observation': {
      if (!Array.isArray(detail)) return null;
      const parts = detail
        .map((e: unknown) => {
          const entry = rec(e);
          const problem = str(entry?.problem);
          const source = str(rec(entry?.observation)?.sourceId);
          return problem === null ? null : source === null ? problem : `${source}: ${problem}`;
        })
        .filter((t): t is string => t !== null);
      return parts.length > 0 ? parts.join('; ') : null;
    }
    default:
      return null;
  }
}

/** The disagreement a fixture_conflict item records, ready to show. Never throws. */
export function fixtureDisagreement(payload: unknown): FixtureDisagreement {
  const p = rec(payload) ?? {};
  const details = rec(p.details) ?? {};
  const rules = strings(p.rules);
  const codes = strings(p.reasons);
  const reasons = codes.map((code, i): DisagreementReason => ({
    code,
    // Rules and reasons are separate sorted lists: pair them only when that is unambiguous.
    rule:
      rules.length === codes.length ? (rules[i] ?? null) : rules.length === 1 ? rules[0]! : null,
    label: REASON_LABELS[code] ?? humanize(code),
    text: reasonText(code, details[code]),
  }));

  const facts: [string, string][] = [];
  const eventStatus = str(p.eventStatus);
  if (eventStatus !== null) facts.push(['Event status', humanize(eventStatus)]);
  const eventStart = str(p.eventStart);
  if (eventStart !== null) facts.push(['Event kickoff', formatDateTime(eventStart)]);
  const observed = str(p.observedKickoff);
  if (observed !== null) facts.push(['Kickoff the sources show', formatDateTime(observed)]);
  const sources = strings(p.sources);
  if (sources.length > 0) facts.push(['Sources', sources.join(', ')]);
  const eventId = str(p.eventId);
  if (eventId !== null) facts.push(['Event id', eventId]);

  const observations = (Array.isArray(p.observations) ? p.observations : []).flatMap(
    (o: unknown): DisagreementObservation[] => {
      const obs = rec(o);
      const source = str(obs?.sourceId);
      if (obs === null || source === null) return [];
      const upstream = str(obs.upstream);
      const status = str(obs.status);
      return [
        {
          source: upstream === null ? source : `${source} (upstream ${upstream})`,
          status: status === null ? '–' : humanize(status),
          kickoff: formatDateTime(str(obs.kickoff)),
          since: formatDateTime(str(obs.changedAt)),
        },
      ];
    },
  );

  const clusters = (Array.isArray(p.clusters) ? p.clusters : []).flatMap(
    (c: unknown): DisagreementCluster[] => {
      const cluster = rec(c);
      if (cluster === null) return [];
      const earliest = str(cluster.earliest);
      const latest = str(cluster.latest);
      const kickoffs =
        earliest === null
          ? '–'
          : latest === null || latest === earliest
            ? formatDateTime(earliest)
            : `${formatDateTime(earliest)} to ${formatDateTime(latest)}`;
      return [
        {
          sources: strings(cluster.sources).join(', ') || '–',
          kickoffs,
          statuses: strings(cluster.statuses).map(humanize).join(', ') || '–',
        },
      ];
    },
  );
  return { reasons, facts, observations, clusters };
}

export interface UncalibratedTeamRow {
  name: string;
  matches: number | null;
  needed: number | null;
}

/** The teams a ratings_uncalibrated item waits for (items raised before R-2 have none). */
export function uncalibratedTeamRows(payload: unknown): UncalibratedTeamRow[] {
  const teams = rec(payload)?.uncalibratedTeams;
  if (!Array.isArray(teams)) return [];
  return teams.flatMap((t: unknown): UncalibratedTeamRow[] => {
    const team = rec(t);
    const name = str(team?.name);
    if (team === null || name === null) return [];
    return [
      {
        name,
        matches: typeof team.matches === 'number' ? team.matches : null,
        needed: typeof team.needed === 'number' ? team.needed : null,
      },
    ];
  });
}

const MARKET_KEY_PREFIX = 'mkt1';

const FALLBACK_TEXT: Readonly<Record<string, string>> = {
  no_consensus: 'no bookmaker consensus',
  no_totals: 'no over/under line to fit the goals to',
  poor_fit: 'the goals model fits the market poorly',
};

/**
 * The pricing and kickoff facts of an odds_approval or ratings_uncalibrated payload as label and
 * value pairs: how the prices were made (source, books, fit residual, why the market was not
 * used) and the checks the gate recorded. Only what the payload holds is listed.
 */
export function pricingFacts(payload: unknown): [string, string][] {
  const p = rec(payload) ?? {};
  const facts: [string, string][] = [];
  const pricing = rec(p.pricing);
  const source = str(pricing?.source);
  const ratingsKey = str(p.ratingsKey);
  if (source !== null) {
    facts.push(['Pricing source', source === 'market' ? 'Bookmaker market' : 'Team-rating model']);
  } else if (ratingsKey !== null) {
    facts.push([
      'Pricing source',
      ratingsKey.startsWith(`${MARKET_KEY_PREFIX}|`) ? 'Bookmaker market' : 'Team-rating model',
    ]);
  }
  if (typeof pricing?.books === 'number') facts.push(['Books used', String(pricing.books)]);
  if (typeof pricing?.residual === 'number') {
    facts.push(['Fit residual', pricing.residual.toFixed(3)]);
  }
  const fallback = str(pricing?.fallback);
  if (fallback !== null) {
    facts.push(['Market not used', FALLBACK_TEXT[fallback] ?? humanize(fallback)]);
  }
  const yesNo = (v: unknown): string | null => (typeof v === 'boolean' ? (v ? 'yes' : 'no') : null);
  const checks: [string, unknown][] = [
    ['Ratings calibrated', p.calibrated],
    ['Prices pass the sanity checks', p.pricesSane],
    ['Kickoff confirmed by sources', p.kickoffConfirmed],
    ['Competition opens automatically', p.autoOpen],
  ];
  for (const [label, value] of checks) {
    const text = yesNo(value);
    if (text !== null) facts.push([label, text]);
  }
  return facts;
}

export interface PriceCompareRow {
  market: string;
  selection: string;
  /** Our proposed price, as text ("2.10"). */
  ours: string;
  /** The price stored today, when a re-price is proposed; "–" otherwise. */
  previous: string;
  /** The no-margin bookmaker consensus price; "–" without one. */
  consensus: string;
  /** Pinnacle's own price (it includes its margin); "–" when it does not list it. */
  pinnacle: string;
  /** Ours against the consensus, e.g. "+3.2%"; "–" without a consensus. */
  versus: string;
}

interface CompareInput {
  prices: readonly {
    market: string;
    selection: string;
    consensusOddsMilli: number;
    pinnacleOddsMilli: number | null;
  }[];
}

/** "+3.2%" / "-1.0%": how far a price is from a reference. Display only. */
export function percentVersus(oddsMilli: number, referenceMilli: number): string {
  if (!(referenceMilli > 0)) return '–';
  const tenths = Math.round(((oddsMilli - referenceMilli) * 1000) / referenceMilli);
  return `${tenths > 0 ? '+' : tenths < 0 ? '-' : ''}${(Math.abs(tenths) / 10).toFixed(1)}%`;
}

/**
 * One row per proposed selection with the consensus and Pinnacle beside it, read from the
 * payload's `markets` and the API's comparison. Rows without a consensus still show our price.
 */
export function priceCompareRows(
  markets: unknown,
  comparison: CompareInput | null | undefined,
): PriceCompareRow[] {
  if (!Array.isArray(markets)) return [];
  const index = new Map<string, CompareInput['prices'][number]>();
  for (const price of comparison?.prices ?? []) {
    index.set(`${price.market}|${price.selection.toLowerCase()}`, price);
  }
  return markets.flatMap((m: unknown): PriceCompareRow[] => {
    const market = rec(m);
    const key = str(market?.market);
    if (market === null || key === null || !Array.isArray(market.selections)) return [];
    return market.selections.flatMap((s: unknown): PriceCompareRow[] => {
      const sel = rec(s);
      const name = str(sel?.name);
      if (sel === null || name === null || typeof sel.oddsMilli !== 'number') return [];
      const found = index.get(`${key}|${name.toLowerCase()}`);
      return [
        {
          market: humanize(key),
          selection: name,
          ours: formatOdds(sel.oddsMilli),
          previous:
            typeof sel.previousOddsMilli === 'number' ? formatOdds(sel.previousOddsMilli) : '–',
          consensus: found === undefined ? '–' : formatOdds(found.consensusOddsMilli),
          pinnacle:
            found?.pinnacleOddsMilli === null || found?.pinnacleOddsMilli === undefined
              ? '–'
              : formatOdds(found.pinnacleOddsMilli),
          versus:
            found === undefined ? '–' : percentVersus(sel.oddsMilli, found.consensusOddsMilli),
        },
      ];
    });
  });
}
