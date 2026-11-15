import {
  listSources,
  listTruthCheckEvents,
  upsertSourceTrust,
  type Database,
  type TruthCheckEvent,
} from '@vamos/db';
import { trustLevel, upstreamKey, type TrustLevel } from '@vamos/scraper';
import { compareSource, isMismatch, latestPerSource, type AuditScore } from './result-audit';

/**
 * The truth-check (plan task 1.2, docs/scraper.md "Trust and the result ladder in shadow"): for
 * each upstream, how often its finished regular-time result observations match the result that was
 * applied. The numbers feed `scrape_source_trust`, which the result ladder reads (`trustLevel`).
 *
 * The check is partly circular: a result applied on this upstream's own vote agrees with it by
 * construction. `ownVote` counts those events (from the `scrape.result.applied` audit row) and
 * `independentCompared` / `independentAgreed` leave them out.
 */

/** Disagreements kept as examples per upstream. */
export const TRUTH_MAX_EXAMPLES = 20;

export interface TruthDisagreement {
  eventId: string;
  kickoff: string;
  sourceId: string;
  observed: AuditScore;
  applied: AuditScore;
}

export interface UpstreamTruth {
  /** As `upstreamKey` writes it. */
  upstream: string;
  compared: number;
  agreed: number;
  /** Kickoffs of the first and last compared match. */
  windowFrom: Date | null;
  windowTo: Date | null;
  /** The most recent disagreements, newest first (at most TRUTH_MAX_EXAMPLES). */
  disagreements: TruthDisagreement[];
  /** Compared events whose applied result recorded this upstream among the votes it was applied on. */
  ownVote: number;
  /** Compared events with no `scrape.result.applied` audit row (a result entered by hand, or older). */
  unrecorded: number;
  /** Compared and agreed leaving out the events applied on this upstream's own vote. */
  independentCompared: number;
  independentAgreed: number;
}

export interface UpstreamTruthRow extends UpstreamTruth {
  rate: number | null;
  independentRate: number | null;
  trust: TrustLevel;
}

const rateOf = (agreed: number, compared: number): number | null =>
  compared === 0 ? null : agreed / compared;

/**
 * The comparison itself (pure). One comparison per event and upstream, using each of the upstream's
 * sources' latest finished regular-time observation: a disagreement when any of its sources differs
 * in the full-time score, or in the half-time score when both sides have one.
 */
export function measureTruth(
  eventsList: readonly TruthCheckEvent[],
  upstreams: readonly string[],
): UpstreamTruth[] {
  const wanted = new Set(upstreams.map(upstreamKey));
  const stats = new Map<string, UpstreamTruth>(
    [...wanted].sort().map((upstream) => [
      upstream,
      {
        upstream,
        compared: 0,
        agreed: 0,
        windowFrom: null,
        windowTo: null,
        disagreements: [],
        ownVote: 0,
        unrecorded: 0,
        independentCompared: 0,
        independentAgreed: 0,
      },
    ]),
  );
  for (const event of eventsList) {
    const appliedOn = event.appliedOn === null ? null : new Set(event.appliedOn.map(upstreamKey));
    const byUpstream = new Map<string, TruthCheckEvent['observations']>();
    for (const o of event.observations) {
      const key = upstreamKey(o.upstream);
      if (wanted.has(key)) byUpstream.set(key, [...(byUpstream.get(key) ?? []), o]);
    }
    for (const [upstream, observations] of byUpstream) {
      const stat = stats.get(upstream) as UpstreamTruth;
      const comparisons = latestPerSource(
        observations.map((o) => ({
          sourceId: o.sourceId,
          upstream: o.upstream,
          status: 'finished',
          scoreBasis: 'regular_time',
          score: o.score,
          changedAt: o.changedAt,
        })),
      ).map((source) => compareSource(event.applied, source));
      const wrong = comparisons.find((c) => isMismatch(c.verdict));
      const own = appliedOn?.has(upstream) === true;
      stat.compared += 1;
      if (wrong === undefined) stat.agreed += 1;
      if (appliedOn === null) stat.unrecorded += 1;
      if (own) stat.ownVote += 1;
      else {
        stat.independentCompared += 1;
        if (wrong === undefined) stat.independentAgreed += 1;
      }
      stat.windowFrom ??= event.startTime;
      stat.windowTo = event.startTime;
      if (wrong !== undefined && wrong.score !== null) {
        stat.disagreements.push({
          eventId: event.eventId,
          kickoff: event.startTime.toISOString(),
          sourceId: wrong.sourceId,
          observed: wrong.score,
          applied: event.applied,
        });
      }
    }
  }
  return [...stats.values()].map((stat) => ({
    ...stat,
    // Events arrive oldest first: the examples are the newest ones.
    disagreements: stat.disagreements.slice(-TRUTH_MAX_EXAMPLES).reverse(),
  }));
}

/** The first of July of the current season: this year from July on, else last year. */
export function seasonStart(now: Date): Date {
  const year = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return new Date(Date.UTC(year, 6, 1));
}

/** The upstream is not the upstream of any source. */
export class UnknownUpstreamError extends Error {
  override readonly name = 'UnknownUpstreamError';
  constructor(
    readonly upstream: string,
    readonly known: readonly string[],
  ) {
    super(`no source has the upstream "${upstream}"`);
  }
}

export interface TruthCheckOptions {
  sport: 'football';
  since: Date;
  /** Only this upstream (any spelling `upstreamKey` maps to the stored one). */
  upstream?: string;
  now: Date;
  /** Store the rows in scrape_source_trust. */
  write: boolean;
}

/**
 * Measures every upstream (or one) and, with `write`, stores the rows. Sources that are switched
 * off count: the check is about what an upstream said, and a source disabled for being wrong must
 * keep that on its record. An upstream with nothing to compare is stored with 0 of 0.
 */
export async function runTruthCheck(
  db: Database,
  options: TruthCheckOptions,
): Promise<UpstreamTruthRow[]> {
  const known = [...new Set((await listSources(db)).map((s) => upstreamKey(s.upstream)))].sort();
  let upstreams = known;
  if (options.upstream !== undefined) {
    const wanted = upstreamKey(options.upstream);
    if (!known.includes(wanted)) throw new UnknownUpstreamError(wanted, known);
    upstreams = [wanted];
  }
  const measured = measureTruth(
    upstreams.length === 0
      ? []
      : await listTruthCheckEvents(db, { sport: options.sport, since: options.since }),
    upstreams,
  );
  if (options.write && measured.length > 0) {
    await db.transaction(async (tx) => {
      for (const row of measured) {
        await upsertSourceTrust(tx, {
          upstream: row.upstream,
          sport: options.sport,
          compared: row.compared,
          agreed: row.agreed,
          windowFrom: row.windowFrom,
          windowTo: row.windowTo,
          disagreements: row.disagreements,
          measuredAt: options.now,
        });
      }
    });
  }
  return measured.map((row) => ({
    ...row,
    rate: rateOf(row.agreed, row.compared),
    independentRate: rateOf(row.independentAgreed, row.independentCompared),
    trust: trustLevel({ compared: row.compared, agreed: row.agreed }),
  }));
}
