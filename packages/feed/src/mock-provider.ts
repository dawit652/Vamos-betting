import type { SportCode } from '@vamos/core';
import { type MatchStrengths, matchStrengths, priceMatch } from './pricing';
import { createRng } from './random';
import type {
  FeedCompetition,
  FeedFixture,
  FeedMarket,
  FeedTeam,
  LiveScoreState,
  MockFeedConfig,
  OddsFeedProvider,
  TeamRatings,
} from './types';

/**
 * The demo-mode odds feed: simulated fixtures and prices, deterministic for a
 * given configuration and seed, with no I/O.
 *
 * Fixtures of one competition on one Addis Ababa calendar day come from a
 * generator seeded with (seed, competition, day), so every call (from any
 * process, for any window) returns the same fixtures with the same feedRef.
 */

export const MOCK_PROVIDER_NAME = 'mock';
/** Addis Ababa is UTC+3 all year (East Africa Time, no daylight saving). */
export const EAT_OFFSET_MINUTES = 180;
export const MAX_HORIZON_HOURS = 24 * 31;
const DEFAULT_SEED = 'vamos-mock-feed';
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const EAT_OFFSET_MS = EAT_OFFSET_MINUTES * MINUTE_MS;
const EVERY_DAY: readonly number[] = Object.freeze([1, 2, 3, 4, 5, 6, 7]);
const KICKOFF_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface MockFeedCompetition extends FeedCompetition {
  /** ISO weekdays with fixtures, Addis Ababa time (1 = Monday … 7 = Sunday). */
  matchdays?: readonly number[];
  /** Kick-off times, Addis Ababa local "HH:MM". */
  kickoffs?: readonly string[];
}

export interface MockFeedProviderConfig extends Omit<MockFeedConfig, 'competitions'> {
  competitions: readonly MockFeedCompetition[];
}

interface Schedule {
  matchdays: readonly number[];
  /** Minutes after local midnight. */
  kickoffs: readonly number[];
  fixtures: readonly [number, number];
}

interface ScheduleDefaults {
  matchdays: readonly number[];
  kickoffs: readonly string[];
  fixtures: readonly [number, number];
}

/** The stable feed reference of a mock fixture. */
export function mockFeedRef(
  competitionSlug: string,
  startTime: Date,
  homeShortName: string,
  awayShortName: string,
): string {
  const isoMinute = `${startTime.toISOString().slice(0, 16)}Z`;
  return `mock:${competitionSlug}:${isoMinute}:${homeShortName}-${awayShortName}`;
}

/**
 * Default schedule of a competition (when it has no matchdays / kickoffs):
 * - Ethiopian Premier League: Tue, Thu, Sat, Sun at 15:00 and 18:00 local
 * - CAF competitions: midweek (Tue, Wed) at 16:00, 19:00, 22:00
 * - UEFA club competitions: Tue–Thu at 19:45 and 22:00
 * - other (European) leagues: Fri–Mon at 16:00, 19:00, 22:00
 * - basketball, tennis, volleyball: a few fixtures every day
 * Featured football competitions get 4–8 fixtures per matchday, others 2–4.
 */
export function defaultSchedule(competition: FeedCompetition): ScheduleDefaults {
  const slug = competition.slug.toLowerCase();
  switch (competition.sport) {
    case 'football': {
      const fixtures: readonly [number, number] = competition.featured ? [4, 8] : [2, 4];
      if (slug.includes('ethiop')) {
        return { matchdays: [2, 4, 6, 7], kickoffs: ['15:00', '18:00'], fixtures };
      }
      if (/(^|-)caf(-|$)|afcon|africa/.test(slug)) {
        return { matchdays: [2, 3], kickoffs: ['16:00', '19:00', '22:00'], fixtures };
      }
      if (/uefa|champions-league|europa|conference/.test(slug)) {
        return { matchdays: [2, 3, 4], kickoffs: ['19:45', '22:00'], fixtures };
      }
      return { matchdays: [1, 5, 6, 7], kickoffs: ['16:00', '19:00', '22:00'], fixtures };
    }
    case 'basketball':
      return { matchdays: EVERY_DAY, kickoffs: ['03:00', '20:00', '21:45'], fixtures: [2, 4] };
    case 'tennis':
      return {
        matchdays: EVERY_DAY,
        kickoffs: ['11:00', '13:00', '14:30', '16:00', '18:00', '20:00'],
        fixtures: [2, 4],
      };
    case 'volleyball':
      return { matchdays: EVERY_DAY, kickoffs: ['15:00', '17:30', '20:00'], fixtures: [1, 3] };
    default: {
      const unknown: never = competition.sport;
      throw new RangeError(`unknown sport: "${String(unknown)}"`);
    }
  }
}

export class MockFeedProvider implements OddsFeedProvider {
  readonly name = MOCK_PROVIDER_NAME;

  private readonly seed: string;
  private readonly competitions: ReadonlyArray<{
    competition: MockFeedCompetition;
    schedule: Schedule;
  }>;
  private readonly sportOf = new Map<string, SportCode>();
  private readonly pools = new Map<string, readonly FeedTeam[]>();
  private readonly ratingsByCompetition = new Map<string, Map<string, TeamRatings>>();
  private readonly ratingsBySport = new Map<string, TeamRatings>();
  private readonly rolling: {
    everyMinutes: number;
    horizonMinutes: number;
    slugs: readonly string[];
  } | null;

  constructor(config: MockFeedProviderConfig) {
    this.seed = config.seed ?? DEFAULT_SEED;
    const competitions: Array<{ competition: MockFeedCompetition; schedule: Schedule }> = [];
    for (const competition of config.competitions) {
      if (this.sportOf.has(competition.slug)) {
        throw new RangeError(`duplicate competition slug "${competition.slug}"`);
      }
      this.sportOf.set(competition.slug, competition.sport);
      competitions.push({ competition, schedule: scheduleOf(competition) });
    }
    this.competitions = competitions;

    for (const [slug, teams] of Object.entries(config.teams)) {
      const pool = new Map<string, FeedTeam>();
      for (const team of teams) {
        if (team.shortName.length > 0 && !pool.has(team.shortName)) pool.set(team.shortName, team);
      }
      this.pools.set(slug, [...pool.values()]);
      this.ratingsByCompetition.set(
        slug,
        new Map([...pool.values()].map((team) => [team.shortName, team.ratings])),
      );
      const sport = this.sportOf.get(slug);
      if (sport === undefined) continue;
      for (const team of pool.values()) {
        const key = `${sport}|${team.shortName}`;
        if (!this.ratingsBySport.has(key)) this.ratingsBySport.set(key, team.ratings);
      }
    }

    this.rolling = config.rolling === undefined ? null : this.checkedRolling(config.rolling);
  }

  /**
   * Fixtures starting in [now, now + horizonHours], ordered by start time then
   * feedRef. Within a competition no team plays twice on one Addis Ababa day,
   * nor in two competitions of the same sport on that day. Rolling demo
   * fixtures (when configured) start every `everyMinutes` on a fixed grid
   * within the rolling horizon; they reuse the competitions' teams.
   */
  fixtures(now: Date, horizonHours: number): FeedFixture[] {
    const from = now instanceof Date ? now.getTime() : Number.NaN;
    if (!Number.isFinite(from)) throw new RangeError('now must be a valid Date');
    if (!Number.isFinite(horizonHours) || horizonHours < 0 || horizonHours > MAX_HORIZON_HOURS) {
      throw new RangeError(`horizonHours must be 0..${MAX_HORIZON_HOURS}, got ${horizonHours}`);
    }
    const to = from + horizonHours * HOUR_MS;
    const byRef = new Map<string, FeedFixture>();
    const keep = (fixture: FeedFixture): void => {
      const start = fixture.startTime.getTime();
      if (start >= from && start <= to) byRef.set(fixture.feedRef, fixture);
    };

    for (let day = localDayStart(from); day <= to; day += DAY_MS) {
      this.dayFixtures(day).forEach(keep);
    }
    if (this.rolling !== null) {
      const every = this.rolling.everyMinutes * MINUTE_MS;
      const end = Math.min(to, from + this.rolling.horizonMinutes * MINUTE_MS);
      for (let slot = Math.ceil(from / every); slot * every <= end; slot++) {
        const fixture = this.rollingFixture(slot);
        if (fixture !== null) keep(fixture);
      }
    }

    return [...byRef.values()].sort(
      (a, b) =>
        a.startTime.getTime() - b.startTime.getTime() ||
        (a.feedRef < b.feedRef ? -1 : a.feedRef > b.feedRef ? 1 : 0),
    );
  }

  /** Prematch (no state) or in-play prices of a fixture. */
  price(fixture: FeedFixture, state?: LiveScoreState): FeedMarket[] {
    return priceMatch(fixture.sport, this.strengths(fixture), state === undefined ? {} : { state });
  }

  /**
   * Model strengths of a fixture for pricing and the live simulator. Teams
   * are looked up in the fixture's competition, then in any competition of
   * the same sport; unknown teams get neutral ratings.
   */
  strengths(fixture: FeedFixture): MatchStrengths {
    return matchStrengths(
      fixture.sport,
      this.ratingsOf(fixture, fixture.homeShortName),
      this.ratingsOf(fixture, fixture.awayShortName),
    );
  }

  /** All regular (non-rolling) fixtures of one Addis Ababa day, in competition order. */
  private dayFixtures(dayStart: number): FeedFixture[] {
    const local = new Date(dayStart + EAT_OFFSET_MS);
    const dayKey = local.toISOString().slice(0, 10);
    const weekday = local.getUTCDay() === 0 ? 7 : local.getUTCDay();
    const busy = new Set<string>();
    const fixtures: FeedFixture[] = [];

    for (const { competition, schedule } of this.competitions) {
      if (!schedule.matchdays.includes(weekday)) continue;
      const { slug, sport } = competition;
      const pool = (this.pools.get(slug) ?? []).filter(
        (team) => !busy.has(`${sport}|${team.shortName}`),
      );
      const rng = createRng(`${this.seed}|${slug}|${dayKey}`);
      const wanted = rng.int(schedule.fixtures[0], schedule.fixtures[1]);
      const count = Math.min(wanted, Math.floor(pool.length / 2));
      const order = rng.shuffle(pool);
      for (let i = 0; i < count; i++) {
        const home = order[2 * i];
        const away = order[2 * i + 1];
        if (home === undefined || away === undefined) break;
        const startTime = new Date(dayStart + rng.pick(schedule.kickoffs) * MINUTE_MS);
        busy.add(`${sport}|${home.shortName}`);
        busy.add(`${sport}|${away.shortName}`);
        fixtures.push(fixture(slug, sport, startTime, home.shortName, away.shortName));
      }
    }
    return fixtures;
  }

  /**
   * The rolling fixture of grid slot `slot` (start = slot × everyMinutes).
   * Slots rotate through the rolling competitions. Each competition's slots
   * of a day pair its teams from a seeded shuffle, so a team only comes back
   * after every other team of the pool has played.
   */
  private rollingFixture(slot: number): FeedFixture | null {
    const rolling = this.rolling;
    if (rolling === null) return null;
    const count = rolling.slugs.length;
    const index = ((slot % count) + count) % count;
    const slug = rolling.slugs[index];
    const sport = slug === undefined ? undefined : this.sportOf.get(slug);
    const pool = slug === undefined ? undefined : this.pools.get(slug);
    if (slug === undefined || sport === undefined || pool === undefined || pool.length < 2) {
      return null;
    }

    const every = rolling.everyMinutes * MINUTE_MS;
    const start = slot * every;
    const dayStart = localDayStart(start);
    const dayKey = new Date(dayStart + EAT_OFFSET_MS).toISOString().slice(0, 10);
    // The n-th slot of this competition on this day.
    const firstOfDay = Math.ceil(dayStart / every);
    const firstForSlug = firstOfDay + ((((index - firstOfDay) % count) + count) % count);
    const nth = Math.round((slot - firstForSlug) / count);
    const pairs = Math.floor(pool.length / 2);
    const cycle = Math.floor(nth / pairs);
    const position = nth % pairs;
    const order = createRng(`${this.seed}|rolling|${slug}|${dayKey}|${cycle}`).shuffle(pool);
    const home = order[2 * position];
    const away = order[2 * position + 1];
    if (home === undefined || away === undefined) return null;
    return fixture(slug, sport, new Date(start), home.shortName, away.shortName);
  }

  private ratingsOf(fixture: FeedFixture, shortName: string): TeamRatings | undefined {
    return (
      this.ratingsByCompetition.get(fixture.competitionSlug)?.get(shortName) ??
      this.ratingsBySport.get(`${fixture.sport}|${shortName}`)
    );
  }

  private checkedRolling(rolling: NonNullable<MockFeedConfig['rolling']>): {
    everyMinutes: number;
    horizonMinutes: number;
    slugs: readonly string[];
  } | null {
    const { everyMinutes, horizonMinutes } = rolling;
    if (!Number.isSafeInteger(everyMinutes) || everyMinutes < 1) {
      throw new RangeError(`rolling.everyMinutes must be a positive integer, got ${everyMinutes}`);
    }
    if (!Number.isFinite(horizonMinutes) || horizonMinutes < 0) {
      throw new RangeError(`rolling.horizonMinutes must be >= 0, got ${horizonMinutes}`);
    }
    const slugs = [...new Set(rolling.competitionSlugs)];
    for (const slug of slugs) {
      if (!this.sportOf.has(slug)) {
        throw new RangeError(`rolling competition "${slug}" is not a configured competition`);
      }
    }
    return slugs.length === 0 ? null : { everyMinutes, horizonMinutes, slugs };
  }
}

function fixture(
  competitionSlug: string,
  sport: SportCode,
  startTime: Date,
  homeShortName: string,
  awayShortName: string,
): FeedFixture {
  return {
    feedRef: mockFeedRef(competitionSlug, startTime, homeShortName, awayShortName),
    sport,
    competitionSlug,
    homeShortName,
    awayShortName,
    startTime,
  };
}

function scheduleOf(competition: MockFeedCompetition): Schedule {
  const defaults = defaultSchedule(competition);
  const matchdays = competition.matchdays ?? defaults.matchdays;
  for (const day of matchdays) {
    if (!Number.isSafeInteger(day) || day < 1 || day > 7) {
      throw new RangeError(`invalid matchday ${day} for "${competition.slug}" (1 = Mon … 7 = Sun)`);
    }
  }
  const kickoffs = (competition.kickoffs ?? defaults.kickoffs).map((time) => {
    const match = KICKOFF_PATTERN.exec(time);
    if (match === null) {
      throw new RangeError(`invalid kick-off "${time}" for "${competition.slug}" (HH:MM)`);
    }
    return Number(match[1]) * 60 + Number(match[2]);
  });
  if (kickoffs.length === 0) throw new RangeError(`"${competition.slug}" has no kick-off times`);
  return { matchdays, kickoffs, fixtures: defaults.fixtures };
}

/** UTC epoch ms of the Addis Ababa midnight starting the local day that contains `epochMs`. */
function localDayStart(epochMs: number): number {
  return Math.floor((epochMs + EAT_OFFSET_MS) / DAY_MS) * DAY_MS - EAT_OFFSET_MS;
}
