import { createHash, randomUUID } from 'node:crypto';
import type { Database } from '../src/client';
import {
  finishRun,
  startRun,
  upsertFixture,
  upsertSource,
  type CatalogIds,
  type FixtureMarketInput,
  type UpsertObservationInput,
} from '../src/index';
import { createBettingDatabase, type TestDb } from './betting-fixtures';

export const SYSTEM = { system: 'system:test' } as const;
export const STAFF = { adminId: '6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d', ip: '10.0.0.1' } as const;
export const T0 = new Date('2026-11-01T12:00:00Z');
export const KICKOFF = new Date('2026-11-08T15:00:00Z');

export const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

export interface ScrapeTestContext {
  handle: TestDb;
  ids: CatalogIds;
  team: (name: string) => string;
  competitionId: string;
}

/** A migrated, seeded database plus helpers to find seeded catalogue rows. */
export async function createScrapeDatabase(): Promise<ScrapeTestContext> {
  const { handle, ids } = await createBettingDatabase();
  const team = (name: string): string => {
    const id = ids.teams.get(`football/${name}`);
    if (id === undefined) throw new Error(`no seeded team ${name}`);
    return id;
  };
  const competitionId = ids.competitions.get('football/premier-league');
  if (competitionId === undefined) throw new Error('no seeded premier-league');
  return { handle, ids, team, competitionId };
}

export async function addSource(
  db: Database,
  id: string,
  options: { upstream?: string; enabled?: boolean } = {},
): Promise<void> {
  await db.transaction(async (tx) => {
    await upsertSource(
      tx,
      {
        id,
        name: `Source ${id}`,
        adapter: 'generic-json',
        upstream: options.upstream ?? id,
        config: { allowedHosts: ['example.test'] },
      },
      SYSTEM,
    );
    if (options.enabled ?? true) {
      const { setSourceEnabled } = await import('../src/index');
      await setSourceEnabled(tx, id, true, SYSTEM);
    }
  });
}

/** A finished run of a source (default ok) started at `startedAt`. */
export async function addRun(
  db: Database,
  sourceId: string,
  status: 'ok' | 'failed' | 'broken' | 'blocked' | 'skipped',
  startedAt: Date,
  recordsAccepted = 0,
) {
  const run = await startRun(db, { sourceId, startedAt });
  return finishRun(db, run.id, {
    status,
    recordsAccepted,
    finishedAt: new Date(startedAt.getTime() + 1000),
  });
}

export function fixtureObs(
  overrides: Partial<UpsertObservationInput> & { sourceId: string; runId: string },
): UpsertObservationInput {
  return {
    kind: 'fixture',
    sourceKey: 'm1',
    sport: 'football',
    competitionRaw: 'Premier League',
    homeRaw: 'Arsenal',
    awayRaw: 'Chelsea',
    kickoff: KICKOFF,
    status: 'scheduled',
    observedAt: T0,
    ...overrides,
  };
}

export function resultObs(
  overrides: Partial<UpsertObservationInput> & { sourceId: string; runId: string },
): UpsertObservationInput {
  return {
    kind: 'result',
    sourceKey: 'm1',
    sport: 'football',
    competitionRaw: 'Premier League',
    homeRaw: 'Arsenal',
    awayRaw: 'Chelsea',
    kickoff: KICKOFF,
    status: 'finished',
    score: { home: 2, away: 1, htHome: 1, htAway: 0 },
    scoreBasis: 'regular_time',
    observedAt: T0,
    ...overrides,
  };
}

const ONE_X_TWO: FixtureMarketInput = {
  type: '1x2',
  line: null,
  selections: [
    { code: '1', oddsMilli: 2000 },
    { code: 'X', oddsMilli: 3200 },
    { code: '2', oddsMilli: 3500 },
  ],
};
const HT_1X2: FixtureMarketInput = {
  type: 'ht_1x2',
  line: null,
  selections: [
    { code: '1', oddsMilli: 2400 },
    { code: 'X', oddsMilli: 2100 },
    { code: '2', oddsMilli: 4000 },
  ],
};

/** A catalogue event with feed_provider 'scraped' (betting open), with or without a half-time market. */
export async function createScrapedEvent(
  ctx: ScrapeTestContext,
  options: {
    home?: string;
    away?: string;
    startTime?: Date;
    halfTime?: boolean;
    feedRef?: string;
  } = {},
): Promise<{ eventId: string; feedRef: string; homeTeamId: string; awayTeamId: string }> {
  const feedRef = options.feedRef ?? `fx|${randomUUID()}`;
  const homeTeamId = ctx.team(options.home ?? 'Arsenal');
  const awayTeamId = ctx.team(options.away ?? 'Chelsea');
  const result = await ctx.handle.db.transaction((tx) =>
    upsertFixture(
      tx,
      {
        feedProvider: 'scraped',
        feedRef,
        sport: 'football',
        competitionId: ctx.competitionId,
        homeTeamId,
        awayTeamId,
        startTime: options.startTime ?? KICKOFF,
      },
      options.halfTime ? [ONE_X_TWO, HT_1X2] : [ONE_X_TWO],
    ),
  );
  return { eventId: result.eventId, feedRef, homeTeamId, awayTeamId };
}
