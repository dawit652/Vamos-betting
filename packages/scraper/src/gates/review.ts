import type { ScrapeReviewKind, ScrapeSeverity } from '@vamos/core';

/**
 * What a gate asks a person to look at (scrape_review_items). Every decision
 * that withholds a change carries one or more GateReview values, complete
 * enough for the runner to open the item without re-deriving anything: kind,
 * a stable subject key, severity, a title and a JSON payload (dates as ISO
 * text, money as decimal strings of santim).
 *
 * The database keeps at most one OPEN item per (kind, subjectKey), so a subject
 * key names the subject (a fixture, a source), never the proposal: the runner
 * refreshes the payload of an item that is already open.
 */

/** A JSON value: what a payload (jsonb) can hold. No bigint, no Date. */
export type GateJson =
  | string
  | number
  | boolean
  | null
  | readonly GateJson[]
  | { readonly [key: string]: GateJson };

export type GatePayload = { readonly [key: string]: GateJson };

export interface GateReview<K extends ScrapeReviewKind = ScrapeReviewKind> {
  readonly kind: K;
  readonly subjectKey: string;
  readonly severity: ScrapeSeverity;
  readonly title: string;
  /** Always has `rules` (rule ids) and `reasons` (machine-readable codes). */
  readonly payload: GatePayload;
}

/**
 * A decision that changes nothing and needs a person: `review` is the most
 * important item (GATE_REVIEW_PRIORITY), `also` the other items to open.
 */
export interface GateHold {
  readonly action: 'hold';
  readonly review: GateReview;
  readonly also: readonly GateReview[];
}

/** Which item leads a hold that raised several kinds, most important first. */
export const GATE_REVIEW_PRIORITY: readonly ScrapeReviewKind[] = Object.freeze([
  'result_correction',
  'result_conflict',
  'cancellation_proposed',
  'result_ready',
  'result_unverified',
  'score_basis_unknown',
  'fixture_conflict',
  'kickoff_change',
  'fixture_missing',
  'odds_approval',
  'ratings_uncalibrated',
  'source_broken',
  'unknown_competition',
  'unknown_team',
] as const);

/** Default severity per kind; a finding may raise it (never lower it). */
export const GATE_REVIEW_SEVERITY: Readonly<Record<ScrapeReviewKind, ScrapeSeverity>> =
  Object.freeze({
    result_correction: 'critical',
    result_conflict: 'critical',
    cancellation_proposed: 'critical',
    result_ready: 'warning',
    result_unverified: 'warning',
    score_basis_unknown: 'warning',
    fixture_conflict: 'warning',
    kickoff_change: 'warning',
    fixture_missing: 'warning',
    odds_approval: 'info',
    ratings_uncalibrated: 'info',
    source_broken: 'warning',
    unknown_competition: 'info',
    unknown_team: 'info',
  });

const TITLES: Readonly<Record<ScrapeReviewKind, string>> = Object.freeze({
  result_correction: 'A source now shows a different result than the one applied',
  result_conflict: 'Sources disagree about the result',
  cancellation_proposed: 'A source says the match is postponed, cancelled or abandoned',
  result_ready: 'Final score confirmed by independent sources: confirm to settle',
  result_unverified: 'Final score not confirmed by a second independent source',
  score_basis_unknown: 'A score is not known to be a regular-time score',
  fixture_conflict: 'Sources disagree about a fixture',
  kickoff_change: 'Kickoff change needs a person',
  fixture_missing: 'No source lists this fixture any more',
  odds_approval: 'Betting is closed until a trader approves the odds',
  ratings_uncalibrated: 'Team ratings are not calibrated: no odds offered',
  source_broken: 'Source pages stopped parsing as before',
  unknown_competition: 'Unknown competition name',
  unknown_team: 'Unknown team name',
});

const SEVERITY_RANK: Readonly<Record<ScrapeSeverity, number>> = { info: 0, warning: 1, critical: 2 };

/** One reason a gate raised (internal building block of GateReview). */
export interface GateFinding {
  kind: ScrapeReviewKind;
  /** Rule id, e.g. 'R3'. */
  rule: string;
  /** Machine-readable reason code, e.g. 'score_disagreement'. */
  reason: string;
  detail?: GateJson;
  /** Raises the kind's default severity. */
  severity?: ScrapeSeverity;
}

/**
 * The review items for a set of findings: one per kind (the database allows
 * one open item per kind and subject), in GATE_REVIEW_PRIORITY order. The
 * payload merges the findings' rules, reasons and details with `context(kind)`.
 */
export function buildReviews(
  subjectKey: string,
  findings: readonly GateFinding[],
  context: (kind: ScrapeReviewKind) => GatePayload,
): GateReview[] {
  const reviews: GateReview[] = [];
  for (const kind of GATE_REVIEW_PRIORITY) {
    const mine = findings.filter((f) => f.kind === kind);
    if (mine.length === 0) continue;
    let severity = GATE_REVIEW_SEVERITY[kind];
    const details: Record<string, GateJson> = {};
    for (const finding of mine) {
      if (finding.severity !== undefined && SEVERITY_RANK[finding.severity] > SEVERITY_RANK[severity]) {
        severity = finding.severity;
      }
      if (finding.detail !== undefined) details[finding.reason] = finding.detail;
    }
    reviews.push({
      kind,
      subjectKey,
      severity,
      title: TITLES[kind],
      payload: {
        ...context(kind),
        rules: [...new Set(mine.map((f) => f.rule))].sort(),
        reasons: [...new Set(mine.map((f) => f.reason))].sort(),
        details,
      },
    });
  }
  return reviews;
}

/** A hold from at least one finding. An empty list is a bug in a gate, not a data problem. */
export function holdFrom(
  subjectKey: string,
  findings: readonly GateFinding[],
  context: (kind: ScrapeReviewKind) => GatePayload,
): GateHold {
  const [review, ...also] = buildReviews(subjectKey, findings, context);
  if (review === undefined) throw new Error('internal: a hold needs at least one finding');
  return { action: 'hold', review, also };
}

/**
 * Every review item a decision asks the runner to open, main item first. Works
 * for every decision of the gates (holds, and a fixture creation that keeps
 * betting closed).
 */
export function reviewsOf(decision: {
  readonly action: string;
  readonly review?: GateReview | null;
  readonly also?: readonly GateReview[];
}): readonly GateReview[] {
  const out: GateReview[] = [];
  if (decision.review) out.push(decision.review);
  if (decision.also) out.push(...decision.also);
  return out;
}

/**
 * The stable key of a scraped fixture (events.feed_ref, docs/scraper.md 4):
 * `fx|competitionId|homeTeamId|awayTeamId|YYYY-MM-DD`, the date being the UTC
 * day of the kickoff the event is created with. It never changes afterwards,
 * so items about an existing event use the event's feedRef instead.
 */
export function fixtureFeedRef(
  pairing: { competitionId: string; homeTeamId: string; awayTeamId: string },
  kickoff: Date,
): string {
  const ms = kickoff instanceof Date ? kickoff.getTime() : Number.NaN;
  const day = Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : 'unknown';
  return `fx|${pairing.competitionId}|${pairing.homeTeamId}|${pairing.awayTeamId}|${day}`;
}
