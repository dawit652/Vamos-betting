import type { ScrapeScoreBasis } from '@vamos/core';
import { z } from 'zod';
import type {
  FetchPlanItem,
  ParseOutcome,
  RawDocument,
  Score,
  SourceAdapter,
  SourceDescriptor,
} from '../types';
import {
  allowedHostsSchema,
  cleanName,
  cleanText,
  draftsFor,
  parseEpoch,
  parseIsoInstant,
  parseScoreInt,
  requestAuthSchema,
  sportSchema,
  startParse,
  urlProblem,
  type ObservationDraft,
  type SourceStatus,
} from './common';

/**
 * Adapter for API-Football v3 (https://www.api-football.com, served by api-sports.io): the results
 * "spine" of docs/plans/hulusport-parity-plan.md (4.2, 4.4, task 1.1). One request is one day:
 * `GET /fixtures?date=YYYY-MM-DD&timezone=UTC` returns every fixture of that day worldwide, so one
 * source covers every league (a `leagueIds` list narrows it).
 *
 * The documentation of the response is NOT yet verified on real data (plan check 0.4), so every
 * choice below leans to "cannot settle":
 *
 * - Envelope (S1). A non-empty `errors` (object or array) is a FATAL parse failure: on a bad or
 *   missing key the API answers HTTP 200 with `errors: { token: ... }` and an empty `response`,
 *   which must trip the breaker and never read as "zero fixtures". A `paging.total` above 1 is
 *   also fatal: this adapter does not follow pages (a by-date request is documented as one page),
 *   so silently reading page 1 of several would lose fixtures. A document whose `get` or
 *   `parameters.date` is not the request's is fatal too.
 * - Competition label: `"<country> - <league name> [<league id>]"`. The league id makes the label
 *   unique (many countries have a "Premier League" or "Serie A") and stable when a league is
 *   renamed; competition aliases map each label to the catalogue (an unmapped one only opens
 *   `unknown_competition`). Names are cut so the label always fits the 120 characters of a name.
 * - Match identity: `externalRef` is `String(fixture.id)`; the kickoff is `fixture.timestamp` (UTC
 *   seconds) and must agree with `fixture.date` (ISO with offset) or the record is dropped.
 * - Status mapping (short code to observation):
 *     TBD, NS                                  fixture `scheduled`
 *     1H HT 2H ET BT P LIVE SUSP INT           fixture `scheduled` (in play or interrupted: the
 *                                              observation vocabulary has no live status)
 *     FT                                       result `finished`; `regular_time` ONLY when
 *                                              `score.fulltime` equals `goals`, else `unknown`
 *     AET, PEN                                 result `finished`, score = `goals`, basis `unknown`
 *     PST, CANC                                fixture + result `postponed` / `cancelled` (no score)
 *     ABD                                      result `abandoned` (no score)
 *     AWD, WO                                  NOTHING (a warning): not a played score, and
 *                                              `abandoned` / `cancelled` would void bets
 *     anything else                            dropped with `unknown_status`
 *   A finished match yields a result only (not also a fixture), like every other adapter: the
 *   result carries the kickoff.
 * - AET and PEN never get `regular_time`. The basis is `unknown`, the most conservative existing
 *   one (R10 treats `unknown` and `includes_extra_time` alike: never settles, opens
 *   `score_basis_unknown`), because which number is the 90-minute score of such a match is exactly
 *   what check 0.4 has to measure. The score is `goals` (the total the API documents as excluding
 *   the shootout), the one number that is known not to be 90-minute only. A later rule that wants
 *   a 90-minute score from this source uses the events (`goalsAddUp`), not this adapter.
 * - FT with `fulltime` null: no result (warning). Half time is read from `score.halftime` only
 *   when both sides are whole numbers and not above the full-time score, else it is left out.
 *
 * Scraped data never cancels or voids anything by itself (the gates decide); this adapter only
 * reports what the provider said.
 */

export const APIFOOTBALL_HOST = 'v3.football.api-sports.io';
export const APIFOOTBALL_AUTH_HEADER = 'x-apisports-key';
/** Longest label a competition name may have (types.ts nameSchema). */
const MAX_NAME = 120;

export const ApiFootballConfigSchema = z
  .strictObject({
    /** Must cover v3.football.api-sports.io (rule S3). */
    allowedHosts: allowedHostsSchema,
    /** The NAME of the environment variable that holds the key (SCRAPER_SECRET_*), never the key. */
    secret: requestAuthSchema.shape.secret,
    sport: sportSchema,
    /** Days before today (UTC) read each run: late results and corrections. */
    daysBack: z.number().int().min(0).max(3).default(1),
    /** Days after today (UTC) read each run: upcoming fixtures. */
    daysAhead: z.number().int().min(0).max(28).default(2),
    /** Only these league ids are read; omitted, every league of the day. */
    leagueIds: z.array(z.number().int().min(1).max(10_000_000)).min(1).max(2000).optional(),
  })
  .superRefine((c, ctx) => {
    if (urlProblem(`https://${APIFOOTBALL_HOST}/`, c.allowedHosts)) {
      ctx.addIssue({
        code: 'custom',
        message: `allowedHosts must cover ${APIFOOTBALL_HOST}`,
        path: ['allowedHosts'],
      });
    }
  });
export type ApiFootballConfig = z.infer<typeof ApiFootballConfigSchema>;

const DAY_MS = 86_400_000;
const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The request URL of one day (the key is added by the fetcher, in a header). */
export function apiFootballUrl(day: string): string {
  return `https://${APIFOOTBALL_HOST}/fixtures?date=${day}&timezone=UTC`;
}

/** The day (YYYY-MM-DD) of a by-date fixtures request URL, or null. */
function dayOfUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.pathname !== '/fixtures') return null;
    const date = u.searchParams.get('date');
    return date !== null && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
  } catch {
    return null;
  }
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A positive whole number, or null. */
const idOf = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null;

/** Short status codes by what they mean for the observations. */
const SCHEDULED_CODES = new Set(['TBD', 'NS']);
const LIVE_CODES = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'LIVE', 'SUSP', 'INT']);

/**
 * `errors` of an envelope as text when it is not empty (an object with entries or a non-empty
 * array), else null. Only the field names are returned, never the messages: a message can echo
 * request details.
 */
function envelopeErrors(errors: unknown): string | null {
  if (Array.isArray(errors)) return errors.length > 0 ? `${errors.length} error(s)` : null;
  if (isObject(errors)) {
    const keys = Object.keys(errors);
    return keys.length > 0 ? keys.slice(0, 5).join(',') : null;
  }
  return errors === undefined || errors === null ? null : 'errors is not an object or array';
}

/** The whole-number score pair of `{ home, away }`, or null when either side is not one. */
function pairOf(value: unknown): { home: number; away: number } | null {
  if (!isObject(value)) return null;
  const home = parseScoreInt(value.home);
  const away = parseScoreInt(value.away);
  return home === null || away === null ? null : { home, away };
}

export function createApiFootballAdapter(
  descriptor: SourceDescriptor,
  config: ApiFootballConfig,
): SourceAdapter {
  const wanted = config.leagueIds === undefined ? null : new Set(config.leagueIds);

  return {
    descriptor,
    allowedHosts: config.allowedHosts,
    plan(now: Date): FetchPlanItem[] {
      const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
      const items: FetchPlanItem[] = [];
      for (let offset = -config.daysBack; offset <= config.daysAhead; offset += 1) {
        items.push({
          url: apiFootballUrl(isoDay(today + offset * DAY_MS)),
          purpose: 'both',
          // A reference only: the fetcher reads the value when it fetches.
          auth: { header: APIFOOTBALL_AUTH_HEADER, secret: config.secret },
        });
      }
      return items;
    },
    parse(doc: RawDocument): ParseOutcome {
      const { collector, usable } = startParse(descriptor.id, doc);
      if (!usable) return collector.outcome();
      const day = dayOfUrl(doc.url);
      if (day === null) {
        collector.fatal('unknown_request', 'the document URL is not a by-date fixtures request', {
          url: doc.url.split('?')[0],
        });
        return collector.outcome();
      }
      let json: unknown;
      try {
        json = JSON.parse(doc.body);
      } catch {
        collector.fatal('bad_json', 'the document is not JSON');
        return collector.outcome();
      }
      if (!isObject(json) || !Array.isArray(json.response)) {
        collector.fatal('bad_shape', 'expected an object with a response list');
        return collector.outcome();
      }
      // HTTP 200 with errors (a bad or missing key, a plan limit, a rate limit): never "no fixtures".
      const problem = envelopeErrors(json.errors);
      if (problem !== null) {
        collector.fatal('api_error', 'the API answered with errors', { errors: problem });
        return collector.outcome();
      }
      if (json.get !== 'fixtures') {
        collector.fatal('bad_shape', 'the answer is not a fixtures answer', { get: json.get });
        return collector.outcome();
      }
      if (isObject(json.parameters) && json.parameters.date !== day) {
        collector.fatal('bad_shape', 'the answer is for another date than the request', {
          date: json.parameters.date,
          requested: day,
        });
        return collector.outcome();
      }
      // Paging is not followed: more than one page would silently lose fixtures.
      const paging = isObject(json.paging) ? json.paging : null;
      const pages = paging === null ? 1 : paging.total;
      if (typeof pages !== 'number' || !Number.isInteger(pages) || pages < 1 || pages > 1) {
        collector.fatal('paging', 'the answer has more than one page (or an unreadable paging)', {
          total: paging?.total,
        });
        return collector.outcome();
      }

      json.response.forEach((raw: unknown, index) => {
        if (!isObject(raw)) {
          if (!collector.beginRecord()) return;
          collector.issue('error', 'bad_record', 'an item must be an object', { index });
          return;
        }
        const league = isObject(raw.league) ? raw.league : null;
        const leagueId = idOf(league?.id);
        if (wanted !== null && leagueId !== null && !wanted.has(leagueId)) return;
        if (!collector.beginRecord()) return;
        const ctx: Record<string, unknown> = { index };
        const fixture = isObject(raw.fixture) ? raw.fixture : null;
        const fixtureId = idOf(fixture?.id);
        if (fixture === null || fixtureId === null) {
          collector.issue('error', 'bad_record', 'an item needs a fixture id', ctx);
          return;
        }
        ctx.fixtureId = fixtureId;
        const teams = isObject(raw.teams) ? raw.teams : null;
        const homeTeam = isObject(teams?.home) ? teams.home : null;
        const awayTeam = isObject(teams?.away) ? teams.away : null;
        const homeId = idOf(homeTeam?.id);
        const awayId = idOf(awayTeam?.id);
        if (homeId === null || awayId === null) {
          collector.issue('error', 'bad_record', 'both teams need an id', ctx);
          return;
        }
        if (homeId === awayId) {
          collector.issue('error', 'bad_name', 'home and away are the same team', ctx);
          return;
        }
        const home = cleanName(homeTeam?.name);
        const away = cleanName(awayTeam?.name);
        if (home === null || away === null) {
          collector.issue('error', 'bad_name', 'both teams need a name', ctx);
          return;
        }
        if (leagueId === null || league === null) {
          collector.issue('error', 'bad_record', 'an item needs a league id', ctx);
          return;
        }
        const leagueName = cleanName(league.name);
        if (leagueName === null) {
          collector.issue('error', 'bad_name', 'a league needs a name', ctx);
          return;
        }
        const country = cleanName(league.country);
        const suffix = ` [${leagueId}]`;
        const prefix = country === null ? '' : `${country} - `;
        const competition =
          `${prefix}${leagueName.slice(0, Math.max(1, MAX_NAME - prefix.length - suffix.length))}${suffix}`.slice(
            0,
            MAX_NAME,
          );
        const named = { ...ctx, home, away };
        const kickoff = parseEpoch(fixture.timestamp, 's');
        const dated = typeof fixture.date === 'string' ? parseIsoInstant(fixture.date) : null;
        if (kickoff === null || dated === null || dated.getTime() !== kickoff.getTime()) {
          collector.issue('error', 'bad_time', 'timestamp and date must agree and be valid', {
            ...named,
            timestamp: fixture.timestamp,
            date: fixture.date,
          });
          return;
        }
        const status = isObject(fixture.status) ? fixture.status.short : undefined;
        const code = typeof status === 'string' ? status.trim().toUpperCase() : '';
        const round =
          typeof league.round === 'string' && league.round.trim() !== ''
            ? cleanText(league.round, 80).trim()
            : null;
        const base = {
          home,
          away,
          competition,
          kickoff,
          externalRef: String(fixtureId),
          round,
        };
        const finish = (
          source: SourceStatus,
          score: Score | null,
          scoreBasis: ScrapeScoreBasis | null,
        ) => {
          const drafts: ObservationDraft[] | { code: string; message: string } = draftsFor({
            ...base,
            status: source,
            score,
            scoreBasis,
          });
          if (Array.isArray(drafts)) collector.accept(drafts, named);
          else collector.issue('error', drafts.code, drafts.message, named);
        };

        if (SCHEDULED_CODES.has(code) || LIVE_CODES.has(code)) {
          finish('scheduled', null, null);
          return;
        }
        switch (code) {
          case 'PST':
            finish('postponed', null, null);
            return;
          case 'CANC':
            finish('cancelled', null, null);
            return;
          case 'ABD':
            finish('abandoned', null, null);
            return;
          case 'AWD':
          case 'WO':
            collector.issue(
              'warning',
              'not_a_played_score',
              `status ${code} is an awarded result, not a played score: nothing is reported`,
              named,
            );
            return;
          case 'FT':
          case 'AET':
          case 'PEN':
            break;
          default:
            collector.issue('error', 'unknown_status', 'an unknown fixture status', {
              ...named,
              status: typeof status === 'string' ? status.slice(0, 20) : null,
            });
            return;
        }

        const scores = isObject(raw.score) ? raw.score : {};
        const goals = pairOf(raw.goals);
        const fulltime = pairOf(scores.fulltime);
        const halftime = pairOf(scores.halftime);
        let total: { home: number; away: number } | null;
        let basis: ScrapeScoreBasis;
        if (code === 'FT') {
          total = fulltime;
          if (total === null) {
            collector.issue('warning', 'bad_score', 'a finished match needs score.fulltime', named);
            return;
          }
          const agrees = goals !== null && goals.home === total.home && goals.away === total.away;
          basis = agrees ? 'regular_time' : 'unknown';
          if (!agrees) {
            collector.issue(
              'warning',
              'score_disagrees',
              'score.fulltime and goals differ for a regular-time match: reported with an unknown basis',
              named,
            );
          }
        } else {
          // AET / PEN: the shootout is never part of it, and the 90-minute score is unverified.
          total = goals;
          basis = 'unknown';
          if (total === null) {
            collector.issue('warning', 'bad_score', `a ${code} match needs goals`, named);
            return;
          }
        }
        const halfOk =
          halftime !== null && halftime.home <= total.home && halftime.away <= total.away;
        if (halftime !== null && !halfOk) {
          collector.issue('warning', 'bad_half_time', 'half-time score above the final', named);
        }
        finish(
          'finished',
          {
            home: total.home,
            away: total.away,
            htHome: halfOk ? halftime.home : null,
            htAway: halfOk ? halftime.away : null,
          },
          basis,
        );
      });
      return collector.outcome();
    },
  };
}

// ---------------------------------------------------------------------------
// Goal events (`GET /fixtures/events?fixture=<id>`): the later result ladder's evidence.
// Pure helpers, not wired into the pipeline.

export type GoalKind = 'goal' | 'own_goal' | 'penalty';

export interface GoalEvent {
  elapsed: number;
  /** Added time ("90+3" is elapsed 90, extra 3), or null. */
  extra: number | null;
  /** The `team.id` of the event, as the API sent it (see OwnGoalRule for own goals). */
  teamId: number;
  kind: GoalKind;
}

export type ParsedEvents =
  | {
      ok: true;
      timeline: GoalEvent[];
      /** Var events that mention cancelling or disallowing a goal: a person should look. */
      varGoalChecks: number;
    }
  | { ok: false; reason: string };

/** Detail strings of a "Goal" event that count; "Missed Penalty" never does. */
const GOAL_DETAILS: Readonly<Record<string, GoalKind | null>> = {
  'normal goal': 'goal',
  'own goal': 'own_goal',
  penalty: 'penalty',
  'missed penalty': null,
};

/**
 * Reads an events answer (a JSON string or the parsed object) into the goal timeline, in the
 * order the API gave. Fails closed: errors in the envelope, a goal without a minute or team, or
 * a "Goal" detail we do not know all give `ok: false`, never a shorter timeline. Cards,
 * substitutions and the like are ignored. Shootout kicks sit at elapsed above 90 and are left to
 * `goalsAddUp`'s minute limit.
 */
export function parseApiFootballEvents(body: unknown): ParsedEvents {
  let json: unknown = body;
  if (typeof body === 'string') {
    try {
      json = JSON.parse(body);
    } catch {
      return { ok: false, reason: 'not JSON' };
    }
  }
  if (!isObject(json) || !Array.isArray(json.response)) {
    return { ok: false, reason: 'expected an object with a response list' };
  }
  if (envelopeErrors(json.errors) !== null)
    return { ok: false, reason: 'the API answered with errors' };
  if (json.get !== 'fixtures/events') return { ok: false, reason: 'not an events answer' };
  const total = isObject(json.paging) ? json.paging.total : 1;
  if (total !== 1) return { ok: false, reason: 'more than one page' };
  const timeline: GoalEvent[] = [];
  let varGoalChecks = 0;
  for (const item of json.response) {
    if (!isObject(item)) return { ok: false, reason: 'an event is not an object' };
    const detail = typeof item.detail === 'string' ? item.detail.trim().toLowerCase() : '';
    if (item.type === 'Var') {
      if (/cancel|disallow/.test(detail)) varGoalChecks += 1;
      continue;
    }
    if (item.type !== 'Goal') continue;
    if (!(detail in GOAL_DETAILS))
      return { ok: false, reason: `unknown goal detail "${detail.slice(0, 40)}"` };
    const kind = GOAL_DETAILS[detail];
    if (kind === null || kind === undefined) continue;
    const time = isObject(item.time) ? item.time : null;
    const elapsed = time?.elapsed;
    const extra = time?.extra ?? null;
    const team = isObject(item.team) ? idOf(item.team.id) : null;
    if (
      typeof elapsed !== 'number' ||
      !Number.isInteger(elapsed) ||
      elapsed < 0 ||
      elapsed > 200 ||
      (extra !== null && (typeof extra !== 'number' || !Number.isInteger(extra) || extra < 0)) ||
      team === null
    ) {
      return { ok: false, reason: 'a goal needs a minute and a team id' };
    }
    timeline.push({ elapsed, extra, teamId: team, kind });
  }
  return { ok: true, timeline, varGoalChecks };
}

/**
 * What an own goal's `team` means. Unverified on real data, so `goalsAddUp` has no default:
 * - `credited_team`: `team` is the team the goal counts for (the opponent of the player);
 * - `scorer_team`: `team` is the player's own team, so the goal counts for the other side.
 */
export type OwnGoalRule = 'credited_team' | 'scorer_team';

export interface GoalsCheck {
  /** Goals up to `upToMinute` equal the score, and (when it is given) so do first-half goals. */
  matches: boolean;
  fullTimeMatches: boolean;
  /** Null when the score has no half-time part. */
  halfTimeMatches: boolean | null;
  counted: { home: number; away: number };
  countedFirstHalf: { home: number; away: number };
  /** Set when the check could not be made (a goal of a team that is neither side). */
  reason?: string;
}

/**
 * Whether a goal timeline adds up to a score: goals with `elapsed <= upToMinute` (90 by default:
 * regular time including its added time, so 90+4 counts, an extra-time goal at 91 does not)
 * against `score.home/away`, and goals with `elapsed <= 45` (first half including added time)
 * against `score.htHome/htAway` when given. Missed penalties are not in the timeline. A goal of a
 * team that is neither `homeTeamId` nor `awayTeamId` makes it fail (`reason`). Pure.
 */
export function goalsAddUp(
  timeline: readonly GoalEvent[],
  homeTeamId: number,
  awayTeamId: number,
  score: { home: number; away: number; htHome?: number | null; htAway?: number | null },
  ownGoalRule: OwnGoalRule,
  upToMinute = 90,
): GoalsCheck {
  const counted = { home: 0, away: 0 };
  const countedFirstHalf = { home: 0, away: 0 };
  let reason: string | undefined;
  for (const goal of timeline) {
    if (goal.teamId !== homeTeamId && goal.teamId !== awayTeamId) {
      reason = 'a goal belongs to a team that is neither side';
      continue;
    }
    const eventIsHome = goal.teamId === homeTeamId;
    const forHome =
      goal.kind === 'own_goal' && ownGoalRule === 'scorer_team' ? !eventIsHome : eventIsHome;
    if (goal.elapsed <= upToMinute) {
      if (forHome) counted.home += 1;
      else counted.away += 1;
    }
    if (goal.elapsed <= 45) {
      if (forHome) countedFirstHalf.home += 1;
      else countedFirstHalf.away += 1;
    }
  }
  const fullTimeMatches =
    reason === undefined && counted.home === score.home && counted.away === score.away;
  const hasHalf =
    score.htHome !== undefined &&
    score.htHome !== null &&
    score.htAway !== undefined &&
    score.htAway !== null;
  const halfTimeMatches = hasHalf
    ? reason === undefined &&
      countedFirstHalf.home === score.htHome &&
      countedFirstHalf.away === score.htAway
    : null;
  return {
    matches: fullTimeMatches && halfTimeMatches !== false,
    fullTimeMatches,
    halfTimeMatches,
    counted,
    countedFirstHalf,
    ...(reason === undefined ? {} : { reason }),
  };
}
