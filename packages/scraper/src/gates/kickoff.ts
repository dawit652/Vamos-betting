import { sha256Hex } from '../archive/file-archive';
import {
  KICKOFF_CONFIRM_LEAD_MS,
  KICKOFF_EVIDENCE_WINDOW_MS,
  KICKOFF_STABLE_MS,
  KICKOFF_TOLERANCE_MS,
  MIN_INDEPENDENT_SOURCES,
} from '../constants';
import type { ExistingEvent, FixtureObservation, ResultObservation } from '../types';
import { countIndependent } from './confirmation';
import { instant, isoOrNull, requireNow } from './internal';

/**
 * Kickoff safety, the pure part (rules K1 to K6, docs/scraper.md 6.1a;
 * docs/scraper-plan/kickoff-safety.md). Prematch betting on a scraped event
 * closes by itself at `start_time` and the event never goes live, so the only
 * exposure is "betting is open and the real kickoff is earlier than our start".
 *
 * Two pure questions are answered here, from the same evidence:
 * - `assessKickoff`: is the kickoff of an event CONFIRMED right now (C1 two
 *   independent upstreams, C2 close and stable on one fresh source, C3 a
 *   person looked), why not, which statements say it starts earlier, and the
 *   evidence key that names exactly what was assessed;
 * - `earlierKickoffAction`: may the scraper close betting (K1)?
 *
 * Fail closed by construction: the action type has no "open"; every doubt (an
 * invalid date, an unknown status, a source not known to be fresh) makes a
 * kickoff less confirmed and never more. Nothing here reads a clock, the
 * database or the network: `now`, the statements and the person's record are
 * inputs (freshness is decided by the caller and arrives as `sourceFresh`).
 */

/** What one source says about the match of an event (docs/scraper.md 6.1a, "statement"). */
export interface KickoffStatement {
  readonly sourceId: string;
  /** Who produces the source's data (independence, as everywhere: `scrape_sources.upstream`). */
  readonly upstream: string;
  readonly kind: 'fixture' | 'result';
  readonly status: FixtureObservation['status'] | ResultObservation['status'];
  /** The kickoff the source gives. May be in the past. */
  readonly kickoff: Date;
  /** When the observation last took its current value (moves on any payload change). */
  readonly changedAt: Date;
  /** The source is healthy, its freshness is known and it is not stale (computed by the loader). */
  readonly sourceFresh: boolean;
}

/** The latest person confirmation of an event (audit `scrape.fixture.kickoff_confirmed`). */
export interface KickoffPersonRecord {
  /** The start the person confirmed; any other start voids the record. */
  readonly startTime: Date;
  readonly confirmedAt: Date;
  readonly evidenceKey: string;
}

export type KickoffBasis = 'C1' | 'C2' | 'C3';

/** Why a kickoff is not confirmed (`kickoff_unconfirmed`, sorted, all that apply). */
export type KickoffReason =
  | 'earlier_kickoff_reported'
  | 'no_statement'
  | 'not_stable'
  | 'result_reported'
  | 'source_not_fresh'
  | 'sources_disagree'
  | 'too_early_for_single_source'
  | 'void_status_reported';

export interface KickoffAssessment {
  readonly confirmed: boolean;
  /** Which confirmation holds (the strongest first: C1, C2, C3), null when not confirmed. */
  readonly basis: KickoffBasis | null;
  /** Empty when confirmed. Acknowledged dissent (C3) is not listed. */
  readonly reasons: readonly KickoffReason[];
  /** The earlier-kickoff statements a person has not acknowledged (K1), in a fixed order. */
  readonly earlier: readonly KickoffStatement[];
  /** SHA-256 hex of what was assessed: the start and every statement. */
  readonly evidenceKey: string;
}

export interface KickoffAssessmentInput {
  readonly start: Date;
  readonly now: Date;
  /** Candidate statements; those whose kickoff is outside the evidence window are ignored. */
  readonly statements: readonly KickoffStatement[];
  /** The latest person confirmation of the event, or null. */
  readonly person: KickoffPersonRecord | null;
}

const VOID_STATUSES: ReadonlySet<string> = new Set(['postponed', 'cancelled', 'abandoned']);

type Class = 'agreeing' | 'earlier' | 'later' | 'other';

interface Classified {
  readonly statement: KickoffStatement;
  readonly cls: Class;
  /** A person confirmed this start at or after the statement took its value. */
  readonly acknowledged: boolean;
}

/** Total order on statements (every field), so results never depend on input order. */
function compareStatements(a: KickoffStatement, b: KickoffStatement): number {
  const keys = (s: KickoffStatement): string[] => [
    s.sourceId,
    s.kind,
    isoOrNull(s.kickoff) ?? '',
    s.status,
    isoOrNull(s.changedAt) ?? '',
    s.upstream,
    s.sourceFresh === true ? '1' : '0',
  ];
  const ka = keys(a);
  const kb = keys(b);
  for (let i = 0; i < ka.length; i++) {
    const x = ka[i]!;
    const y = kb[i]!;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * The evidence key: SHA-256 (hex) of the canonical JSON array
 * `[startISO, statements]`, the statements sorted by source id, kind and
 * kickoff, each `[sourceId, kind, status, kickoffISO, changedAtISO]`. It
 * identifies exactly what a person was shown: an input that is not a valid
 * date is written as null.
 */
export function kickoffEvidenceKey(start: Date, statements: readonly KickoffStatement[]): string {
  const rows = [...statements]
    .sort(compareStatements)
    .map((s) => [s.sourceId, s.kind, s.status, isoOrNull(s.kickoff), isoOrNull(s.changedAt)]);
  return sha256Hex(new TextEncoder().encode(JSON.stringify([isoOrNull(start), rows])));
}

/**
 * Decides whether the kickoff `start` of an event is confirmed at `now`
 * (rules K2 and K3, definitions in docs/scraper.md 6.1a):
 *
 * - statements are the given ones within `KICKOFF_EVIDENCE_WINDOW_MS` of the
 *   start (a statement with an invalid kickoff cannot be placed, so it counts
 *   as dissent);
 * - agreeing: a `scheduled` fixture within `KICKOFF_TOLERANCE_MS` of the start;
 *   every other statement dissents (a result before kickoff contradicts it);
 * - C1: no dissent, and fresh agreeing statements from at least
 *   `MIN_INDEPENDENT_SOURCES` independent upstreams;
 * - C2: no dissent, `now >= start - KICKOFF_CONFIRM_LEAD_MS`, and a fresh agreeing
 *   statement unchanged for `KICKOFF_STABLE_MS`;
 * - C3: the person's record names this exact start and acknowledges every
 *   dissenting statement (`changedAt <= confirmedAt`).
 *
 * Throws RangeError for an invalid `start` or `now` (programmer errors).
 */
export function assessKickoff(input: KickoffAssessmentInput): KickoffAssessment {
  const startMs = requireNow(input.start);
  const nowMs = requireNow(input.now);
  const person = input.person;
  const personStart = person === null ? null : instant(person.startTime);
  const personAt = person === null ? null : instant(person.confirmedAt);
  const personHolds = personStart === startMs && personAt !== null;

  const classified: Classified[] = [];
  for (const statement of input.statements) {
    const ms = instant(statement.kickoff);
    if (ms !== null && Math.abs(ms - startMs) > KICKOFF_EVIDENCE_WINDOW_MS) continue;
    const changedMs = instant(statement.changedAt);
    classified.push({
      statement,
      cls: ms === null ? 'other' : classOf(statement, ms - startMs),
      acknowledged: personHolds && changedMs !== null && changedMs <= personAt,
    });
  }
  classified.sort((a, b) => compareStatements(a.statement, b.statement));

  const statements = classified.map((c) => c.statement);
  const dissent = classified.filter((c) => c.cls !== 'agreeing');
  const unacknowledged = dissent.filter((c) => !c.acknowledged);
  const agreeing = classified.filter((c) => c.cls === 'agreeing');
  const freshAgreeing = agreeing.filter((c) => c.statement.sourceFresh === true);
  const earlier = classified.filter((c) => c.cls === 'earlier' && !c.acknowledged);

  // Independence over the fresh agreeing statements, and never more than over all agreeing ones: a
  // source cannot widen it through a stale row that names another upstream (fail closed).
  const voices = (list: readonly Classified[]) =>
    list.map((c) => ({ sourceId: c.statement.sourceId, upstream: c.statement.upstream }));
  const independent = Math.min(
    countIndependent(voices(freshAgreeing)),
    countIndependent(voices(agreeing)),
  );
  const noDissent = dissent.length === 0;
  const c1 = noDissent && independent >= MIN_INDEPENDENT_SOURCES;
  const close = nowMs >= startMs - KICKOFF_CONFIRM_LEAD_MS;
  const stable = freshAgreeing.filter((c) => {
    const changed = instant(c.statement.changedAt);
    return changed !== null && changed <= nowMs - KICKOFF_STABLE_MS;
  });
  const c2 = noDissent && close && stable.length > 0;
  const c3 = personHolds && unacknowledged.length === 0;
  const basis: KickoffBasis | null = c1 ? 'C1' : c2 ? 'C2' : c3 ? 'C3' : null;

  const reasons = new Set<KickoffReason>();
  if (basis === null) {
    if (statements.length === 0) reasons.add('no_statement');
    for (const { statement, cls } of unacknowledged) {
      for (const reason of dissentReasons(statement, cls)) reasons.add(reason);
    }
    if (agreeing.length > 0) {
      if (freshAgreeing.length === 0) reasons.add('source_not_fresh');
      else if (stable.length === 0) reasons.add('not_stable');
      if (independent < MIN_INDEPENDENT_SOURCES && !close) {
        reasons.add('too_early_for_single_source');
      }
    }
  }

  return {
    confirmed: basis !== null,
    basis,
    reasons: [...reasons].sort(),
    earlier: earlier.map((c) => c.statement),
    evidenceKey: kickoffEvidenceKey(input.start, statements),
  };
}

function classOf(statement: KickoffStatement, delta: number): Class {
  const scheduledFixture = statement.kind === 'fixture' && statement.status === 'scheduled';
  if (scheduledFixture && Math.abs(delta) <= KICKOFF_TOLERANCE_MS) return 'agreeing';
  // Earlier-kickoff statement: a scheduled fixture or a finished result before the start (K5: never a void status).
  const reportsMatch =
    scheduledFixture || (statement.kind === 'result' && statement.status === 'finished');
  if (reportsMatch && delta < -KICKOFF_TOLERANCE_MS) return 'earlier';
  if (scheduledFixture && delta > KICKOFF_TOLERANCE_MS) return 'later';
  return 'other';
}

/** The reason codes a dissenting statement gives (a result also reports a void status when it has one). */
function dissentReasons(statement: KickoffStatement, cls: Class): KickoffReason[] {
  const out: KickoffReason[] = [];
  if (statement.kind === 'result') out.push('result_reported');
  if (VOID_STATUSES.has(statement.status)) out.push('void_status_reported');
  if (cls === 'earlier' && statement.kind === 'fixture') out.push('earlier_kickoff_reported');
  else if (cls === 'later' || (cls === 'other' && out.length === 0)) out.push('sources_disagree');
  return out;
}

/** The only thing the scraper may do on its own about a kickoff: close betting (K1). There is no 'open'. */
export type EarlierKickoffAction = 'none' | 'close';

/**
 * Rule K1: close betting when an open, scheduled, unresulted event that has
 * not started has an earlier-kickoff statement nobody acknowledged. The
 * decision is `'close'` only for `bettingOpen === true`, so a second pass with
 * the same data changes nothing (K6). Confirmation does not matter (a C1 event
 * whose second source moves earlier is closed too).
 */
export function earlierKickoffAction(
  event: Pick<ExistingEvent, 'status' | 'bettingOpen' | 'startTime' | 'resultedAt' | 'score'>,
  assessment: Pick<KickoffAssessment, 'earlier'>,
  now: Date,
): EarlierKickoffAction {
  const nowMs = requireNow(now);
  const startMs = instant(event.startTime);
  if (
    event.bettingOpen === true &&
    event.status === 'scheduled' &&
    event.resultedAt === null &&
    event.score === null &&
    startMs !== null &&
    startMs > nowMs &&
    assessment.earlier.length > 0
  ) {
    return 'close';
  }
  return 'none';
}
