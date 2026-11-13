import { MIN_INDEPENDENT_SOURCES } from '../constants';
import { upstreamKey } from '../gates/confirmation';
import { ApiFootballConfigSchema } from './apifootball';
import { GenericHtmlConfigSchema } from './generic-html';
import { GenericJsonConfigSchema } from './generic-json';
import { OpenFootballConfigSchema } from './openfootball';
import type { SourceRow } from './registry';
import { TheOddsApiConfigSchema } from './theoddsapi';
import { TheRundownConfigSchema } from './therundown';

/**
 * What a configured source can give, derived from its adapter and config (the coverage matrix,
 * docs/feed-quality-plan.md S-1). Pure: no I/O. Each rule below mirrors what the adapter's parse
 * does, so a change to an adapter that changes what it yields must change this too.
 *
 * - fixtures: scheduled matches (kickoffs);
 * - fullTime: a final score at the end of the match;
 * - halfTime: a half-time score next to it (needed by half-time markets);
 * - basis: how the final score says what it covers (regular time, or including extra time):
 *   `per-record` the data states it for each match (openfootball ft / et / p, football-data.org
 *   `score.duration`), `declared` the operator states one basis for the whole source, `none`
 *   the basis is `unknown` (a person decides) or there is no score;
 * - prices: bookmaker prices (market_odds), which no result rule counts.
 */
export type BasisKind = 'per-record' | 'declared' | 'none';

export interface SourceCapabilities {
  /** The competition labels the source is configured for (resolved through aliases later). */
  competitions: string[];
  /** The competition comes from each record, so no label is known from the config. */
  competitionPerRecord: boolean;
  fixtures: boolean;
  fullTime: boolean;
  halfTime: boolean;
  basis: BasisKind;
  prices: boolean;
}

export type SourceCapabilitiesResult =
  { ok: true; capabilities: SourceCapabilities } | { ok: false; errors: string[] };

const NONE = {
  competitions: [] as string[],
  competitionPerRecord: false,
  fixtures: false,
  fullTime: false,
  halfTime: false,
  basis: 'none' as BasisKind,
  prices: false,
};

const unique = (labels: readonly string[]): string[] => [...new Set(labels)];

const declaredBasis = (basis: string | undefined): BasisKind =>
  basis === 'regular_time' || basis === 'includes_extra_time' ? 'declared' : 'none';

const issues = (error: { issues: readonly { path: PropertyKey[]; message: string }[] }): string[] =>
  error.issues.map((i) => `${i.path.map(String).join('.') || 'config'}: ${i.message}`);

/** The capabilities of one source row; a config the adapter would refuse comes back as errors. */
export function sourceCapabilities(
  row: Pick<SourceRow, 'adapter' | 'config'>,
): SourceCapabilitiesResult {
  switch (row.adapter) {
    case 'openfootball': {
      const parsed = OpenFootballConfigSchema.safeParse(row.config);
      if (!parsed.success) return { ok: false, errors: issues(parsed.error) };
      // The dataset gives a score object { ft, ht, et, p }: ft is regular time, et / p are
      // longer play (basis unknown), and ht is read when present.
      return {
        ok: true,
        capabilities: {
          ...NONE,
          competitions: unique(parsed.data.requests.map((r) => r.competition)),
          fixtures: true,
          fullTime: true,
          halfTime: true,
          basis: 'per-record',
        },
      };
    }
    case 'generic-json': {
      const parsed = GenericJsonConfigSchema.safeParse(row.config);
      if (!parsed.success) return { ok: false, errors: issues(parsed.error) };
      const c = parsed.data;
      const purposes = c.requests.map((r) => r.purpose);
      const scored = c.fields.score !== undefined && purposes.some((p) => p !== 'fixtures');
      const fixed = 'fixed' in c.fields.competition;
      return {
        ok: true,
        capabilities: {
          ...NONE,
          competitions: 'fixed' in c.fields.competition ? [c.fields.competition.fixed] : [],
          competitionPerRecord: !fixed,
          fixtures: purposes.some((p) => p !== 'results'),
          fullTime: scored,
          halfTime: scored && c.fields.score?.htHomePath !== undefined,
          basis: !scored
            ? 'none'
            : c.fields.scoreBasis !== undefined
              ? 'per-record'
              : declaredBasis(c.scoreBasis),
        },
      };
    }
    case 'generic-html': {
      const parsed = GenericHtmlConfigSchema.safeParse(row.config);
      if (!parsed.success) return { ok: false, errors: issues(parsed.error) };
      const c = parsed.data;
      const purposes = c.requests.map((r) => r.purpose);
      const scored = c.fields.score !== undefined && purposes.some((p) => p !== 'fixtures');
      const fixed = 'fixed' in c.fields.competition;
      return {
        ok: true,
        capabilities: {
          ...NONE,
          competitions: 'fixed' in c.fields.competition ? [c.fields.competition.fixed] : [],
          competitionPerRecord: !fixed,
          fixtures: purposes.some((p) => p !== 'results'),
          fullTime: scored,
          halfTime: scored && c.fields.halfTime !== undefined,
          basis: scored ? declaredBasis(c.scoreBasis) : 'none',
        },
      };
    }
    case 'theoddsapi': {
      const parsed = TheOddsApiConfigSchema.safeParse(row.config);
      if (!parsed.success) return { ok: false, errors: issues(parsed.error) };
      const c = parsed.data;
      const scores = c.mode === 'scores';
      const events = c.mode === 'events';
      return {
        ok: true,
        capabilities: {
          ...NONE,
          competitions: [c.competition],
          // Odds mode: prices, plus each upcoming match as a fixture when `fixtures` is on.
          // Events mode (free list): fixtures only.
          // Scores mode: final scores only (never a half time: htHome / htAway are null).
          fixtures: events || (!scores && c.fixtures),
          fullTime: scores,
          halfTime: false,
          basis: scores ? declaredBasis(c.scoreBasis) : 'none',
          prices: !scores && !events,
        },
      };
    }
    case 'therundown': {
      const parsed = TheRundownConfigSchema.safeParse(row.config);
      if (!parsed.success) return { ok: false, errors: issues(parsed.error) };
      const c = parsed.data;
      return {
        ok: true,
        capabilities: {
          ...NONE,
          competitions: unique(c.sports.map((s) => s.competition)),
          fixtures: true,
          // Final scores, never a half time ("the provider has no half-time score").
          fullTime: true,
          halfTime: false,
          basis: c.finalIsRegularTime ? 'declared' : 'none',
          prices: true,
        },
      };
    }
    case 'apifootball': {
      const parsed = ApiFootballConfigSchema.safeParse(row.config);
      if (!parsed.success) return { ok: false, errors: issues(parsed.error) };
      // Every league of the day (competition per record); fixtures, full time and half time. The
      // basis is stated per match: regular_time only when fulltime equals goals, else unknown.
      return {
        ok: true,
        capabilities: {
          ...NONE,
          competitionPerRecord: true,
          fixtures: true,
          fullTime: true,
          halfTime: true,
          basis: 'per-record',
        },
      };
    }
    default:
      return { ok: false, errors: [`adapter: unknown adapter "${String(row.adapter)}"`] };
  }
}

/** One source in one competition, with what it gives. */
export interface CoverageEntry {
  /** The competition this row is about (a slug, or a label that did not resolve). */
  competition: string;
  sourceId: string;
  upstream: string;
  capabilities: Pick<SourceCapabilities, 'fixtures' | 'fullTime' | 'halfTime' | 'basis'>;
}

export interface CoverageRow {
  competition: string;
  sources: number;
  /** Distinct upstreams of all the sources (prices-only ones included). */
  upstreams: number;
  /** Distinct upstreams that give fixtures / full-time scores / half-time scores. */
  fixtureUpstreams: number;
  fullTimeUpstreams: number;
  halfTimeUpstreams: number;
  /** Distinct upstreams whose full-time score states its basis (per record or declared). */
  basisUpstreams: number;
  /** At least one full-time upstream states the basis. */
  basisKnown: boolean;
  /** Fewer than MIN_INDEPENDENT_SOURCES upstreams give a full-time score: rule R2 cannot be met. */
  singleResultUpstream: boolean;
}

/** The matrix: one row per competition, sorted by competition. Upstreams compare as rule R2 does. */
export function coverageMatrix(entries: readonly CoverageEntry[]): CoverageRow[] {
  const byCompetition = new Map<string, CoverageEntry[]>();
  for (const entry of entries) {
    byCompetition.set(entry.competition, [...(byCompetition.get(entry.competition) ?? []), entry]);
  }
  const distinct = (list: readonly CoverageEntry[]): number =>
    new Set(list.map((e) => upstreamKey(e.upstream))).size;
  return [...byCompetition.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([competition, list]) => {
      const fullTime = list.filter((e) => e.capabilities.fullTime);
      const basis = fullTime.filter((e) => e.capabilities.basis !== 'none');
      const fullTimeUpstreams = distinct(fullTime);
      return {
        competition,
        sources: new Set(list.map((e) => e.sourceId)).size,
        upstreams: distinct(list),
        fixtureUpstreams: distinct(list.filter((e) => e.capabilities.fixtures)),
        fullTimeUpstreams,
        halfTimeUpstreams: distinct(
          list.filter((e) => e.capabilities.fullTime && e.capabilities.halfTime),
        ),
        basisUpstreams: distinct(basis),
        basisKnown: basis.length > 0,
        singleResultUpstream: fullTimeUpstreams < MIN_INDEPENDENT_SOURCES,
      };
    });
}
