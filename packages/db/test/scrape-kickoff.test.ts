import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  KICKOFF_CONFIRMED_AUDIT_ACTION,
  listSourceKickoffFacts,
  loadKickoffEvidence,
  recordKickoffConfirmation,
  setSourceEnabled,
  touchObservationsOfRaw,
  upsertObservation,
  writeAudit,
  type KickoffThresholds,
  type LoadKickoffEvidenceOptions,
} from '../src/index';
import { auditLog, scrapeSources } from '../src/schema/index';
import { dropTestDatabase } from './helpers';
import {
  addRun,
  addSource,
  createScrapeDatabase,
  createScrapedEvent,
  fixtureObs,
  KICKOFF,
  resultObs,
  STAFF,
  SYSTEM,
  type ScrapeTestContext,
} from './scrape-fixtures';

/** The scraper's constants, restated here (the db package does not import @vamos/scraper). */
const MIN = 60_000;
const H = 3_600_000;
const DAY = 24 * H;
const MIN_MATCH = 105 * MIN;
const STALE_AFTER = 48 * H;
const WINDOW = 7 * DAY;
const thresholds: KickoffThresholds = { minMatchDurationMs: MIN_MATCH, staleAfterMs: STALE_AFTER };

/** "Now" of the freshness tests, well after the kickoff the events start at. */
const NOW = new Date('2026-11-20T12:00:00Z');
const START = KICKOFF;

let ctx: ScrapeTestContext;
const db = () => ctx.handle.db;

beforeAll(async () => {
  ctx = await createScrapeDatabase();
});
afterAll(async () => {
  await dropTestDatabase(ctx?.handle);
});

const options = (eventIds: string[], now = NOW): LoadKickoffEvidenceOptions => ({
  ...thresholds,
  eventIds,
  now,
  evidenceWindowMs: WINDOW,
});
const evidenceOf = async (eventId: string, now = NOW) => {
  const found = (await loadKickoffEvidence(db(), options([eventId], now))).get(eventId);
  if (found === undefined) throw new Error('event not found');
  return found;
};
const statementsOf = async (eventId: string, sourceId: string, now = NOW) =>
  (await evidenceOf(eventId, now)).statements.filter((s) => s.sourceId === sourceId);
const factsOf = async (sourceId: string, now = NOW) =>
  (await listSourceKickoffFacts(db(), { ...thresholds, now })).find((f) => f.sourceId === sourceId);

interface Row {
  key: string;
  kind?: 'fixture' | 'result';
  status?: 'scheduled' | 'postponed' | 'cancelled' | 'finished' | 'abandoned';
  kickoff: Date;
  /** When the row took its current value. */
  changedAt: Date;
  home?: string;
  away?: string;
}

/**
 * A source with one ok run at `firstRunAt` that saw the rows (changed at their `changedAt`), and a
 * later ok run at `lastRunAt` that saw them again unchanged: so `changed_at` is what the test says
 * and `last_seen_at` is the latest run.
 */
async function seedSource(
  sourceId: string,
  rows: Row[],
  runs: { firstRunAt: Date; lastRunAt: Date } = {
    firstRunAt: new Date(NOW.getTime() - 20 * DAY),
    lastRunAt: new Date(NOW.getTime() - H),
  },
  names = { home: 'Arsenal', away: 'Chelsea' },
): Promise<void> {
  await addSource(db(), sourceId, { upstream: `up-${sourceId}` });
  const first = await addRun(db(), sourceId, 'ok', runs.firstRunAt);
  const input = (row: Row, observedAt: Date, runId: string) => {
    const home = row.home ?? names.home;
    const away = row.away ?? names.away;
    const base = {
      sourceId,
      runId,
      sourceKey: row.key,
      kickoff: row.kickoff,
      observedAt,
      competitionId: ctx.competitionId,
      homeTeamId: ctx.team(home),
      awayTeamId: ctx.team(away),
      homeRaw: home,
      awayRaw: away,
    };
    return row.kind === 'result'
      ? resultObs({ ...base, status: row.status ?? 'finished' })
      : fixtureObs({ ...base, status: row.status ?? 'scheduled' });
  };
  for (const row of rows) {
    await db().transaction((tx) => upsertObservation(tx, input(row, row.changedAt, first.id)));
  }
  const last = await addRun(db(), sourceId, 'ok', runs.lastRunAt);
  const seen = new Date(runs.lastRunAt.getTime() + 30 * MIN);
  for (const row of rows) {
    await db().transaction((tx) => upsertObservation(tx, input(row, seen, last.id)));
  }
}

describe('statement filter (spec section 2)', () => {
  it('lists the statements of enabled sources about the event, fixtures and results, with upstream and clocks', async () => {
    const ev = await createScrapedEvent(ctx, {
      home: 'Arsenal',
      away: 'Chelsea',
      startTime: START,
    });
    const changedAt = new Date(START.getTime() - 3 * DAY);
    await seedSource('s-basic', [
      { key: 'a', kickoff: START, changedAt },
      {
        key: 'b',
        kind: 'result',
        status: 'finished',
        kickoff: new Date(START.getTime() - 2 * H),
        changedAt: new Date(START.getTime() - 2 * DAY),
      },
      // Another pairing (home and away swapped) is not a statement about this event.
      { key: 'c', kickoff: START, changedAt, home: 'Chelsea', away: 'Arsenal' },
    ]);
    const evidence = await evidenceOf(ev.eventId);
    expect(evidence.event).toMatchObject({
      eventId: ev.eventId,
      feedProvider: 'scraped',
      feedRef: ev.feedRef,
      competitionId: ctx.competitionId,
      homeTeamId: ev.homeTeamId,
      awayTeamId: ev.awayTeamId,
      startTime: START,
      status: 'scheduled',
      bettingOpen: true,
      resultedAt: null,
      score: null,
    });
    expect(evidence.person).toBeNull();
    const mine = evidence.statements.filter((s) => s.sourceId === 's-basic');
    expect(mine).toEqual([
      {
        sourceId: 's-basic',
        upstream: 'up-s-basic',
        kind: 'fixture',
        status: 'scheduled',
        kickoff: START,
        changedAt,
        sourceFresh: false,
      },
      {
        sourceId: 's-basic',
        upstream: 'up-s-basic',
        kind: 'result',
        status: 'finished',
        kickoff: new Date(START.getTime() - 2 * H),
        changedAt: new Date(START.getTime() - 2 * DAY),
        sourceFresh: false,
      },
    ]);
  });

  it('a keyless old-day row is excluded after the next ok run, the new row stays', async () => {
    const ev = await createScrapedEvent(ctx, {
      home: 'Arsenal',
      away: 'Chelsea',
      startTime: START,
    });
    const day1 = new Date(NOW.getTime() - 5 * DAY);
    await addSource(db(), 's-keyless', { upstream: 'up-keyless' });
    const base = {
      sourceId: 's-keyless',
      competitionId: ctx.competitionId,
      homeTeamId: ev.homeTeamId,
      awayTeamId: ev.awayTeamId,
    };
    const r1 = await addRun(db(), 's-keyless', 'ok', day1);
    await db().transaction((tx) =>
      upsertObservation(
        tx,
        fixtureObs({
          ...base,
          runId: r1.id,
          sourceKey: 'day-15',
          kickoff: START,
          observedAt: day1,
        }),
      ),
    );
    expect((await statementsOf(ev.eventId, 's-keyless')).map((s) => s.kickoff)).toEqual([START]);

    // The match moves 19 h earlier: a keyless source writes a NEW row and the old one is no longer shown.
    const day2 = new Date(day1.getTime() + DAY);
    const earlier = new Date(START.getTime() - 19 * H);
    const r2 = await addRun(db(), 's-keyless', 'ok', day2);
    await db().transaction((tx) =>
      upsertObservation(
        tx,
        fixtureObs({
          ...base,
          runId: r2.id,
          sourceKey: 'day-14',
          kickoff: earlier,
          observedAt: day2,
        }),
      ),
    );
    expect((await statementsOf(ev.eventId, 's-keyless')).map((s) => s.kickoff)).toEqual([earlier]);
  });

  it('a disabled source is not a statement (the kill switch), an enabled one is', async () => {
    const ev = await createScrapedEvent(ctx, {
      home: 'Arsenal',
      away: 'Chelsea',
      startTime: START,
    });
    await seedSource('s-off', [
      { key: 'a', kickoff: START, changedAt: new Date(START.getTime() - 3 * DAY) },
    ]);
    expect(await statementsOf(ev.eventId, 's-off')).toHaveLength(1);
    await db().transaction((tx) => setSourceEnabled(tx, 's-off', false, SYSTEM));
    expect(await statementsOf(ev.eventId, 's-off')).toEqual([]);
    expect(await factsOf('s-off')).toBeUndefined();
    await db().transaction((tx) => setSourceEnabled(tx, 's-off', true, SYSTEM));
    expect(await statementsOf(ev.eventId, 's-off')).toHaveLength(1);
  });

  it('a 304 sighting keeps a row in; without it the row drops out after the next ok run', async () => {
    const ev = await createScrapedEvent(ctx, {
      home: 'Arsenal',
      away: 'Chelsea',
      startTime: START,
    });
    const t1 = new Date(NOW.getTime() - 4 * DAY);
    await addSource(db(), 's-304', { upstream: 'up-304' });
    const rawId = randomUUID();
    const r1 = await addRun(db(), 's-304', 'ok', t1);
    await db().transaction((tx) =>
      upsertObservation(
        tx,
        fixtureObs({
          sourceId: 's-304',
          runId: r1.id,
          rawId,
          sourceKey: 'a',
          kickoff: START,
          observedAt: t1,
          competitionId: ctx.competitionId,
          homeTeamId: ev.homeTeamId,
          awayTeamId: ev.awayTeamId,
        }),
      ),
    );
    const t2 = new Date(t1.getTime() + DAY);
    const r2 = await addRun(db(), 's-304', 'ok', t2);
    // The second run got "304 Not Modified" but nothing recorded the sighting yet: the row is not listed.
    expect(await statementsOf(ev.eventId, 's-304')).toEqual([]);
    await db().transaction((tx) =>
      touchObservationsOfRaw(tx, {
        sourceId: 's-304',
        fromRawId: rawId,
        toRawId: randomUUID(),
        runId: r2.id,
        seenAt: t2,
      }),
    );
    const [kept] = await statementsOf(ev.eventId, 's-304');
    expect(kept).toMatchObject({ kickoff: START, changedAt: t1 });
  });

  it('the evidence window: start +- 7 days is in, one millisecond beyond is out', async () => {
    const ev = await createScrapedEvent(ctx, {
      home: 'Arsenal',
      away: 'Chelsea',
      startTime: START,
    });
    const at = (ms: number) => new Date(START.getTime() + ms);
    const changedAt = new Date(START.getTime() - 10 * DAY);
    await seedSource('s-window', [
      { key: 'early-in', kickoff: at(-WINDOW), changedAt },
      { key: 'early-out', kickoff: at(-WINDOW - 1), changedAt },
      { key: 'late-in', kickoff: at(WINDOW), changedAt },
      { key: 'late-out', kickoff: at(WINDOW + 1), changedAt },
    ]);
    expect((await statementsOf(ev.eventId, 's-window')).map((s) => s.kickoff.getTime())).toEqual([
      at(-WINDOW).getTime(),
      at(WINDOW).getTime(),
    ]);
  });

  it('events that do not exist are absent; no ids give an empty map', async () => {
    expect((await loadKickoffEvidence(db(), options([]))).size).toBe(0);
    const missing = await loadKickoffEvidence(db(), options([randomUUID()]));
    expect(missing.size).toBe(0);
    const ev = await createScrapedEvent(ctx, {
      home: 'Arsenal',
      away: 'Chelsea',
      startTime: START,
    });
    const both = await loadKickoffEvidence(db(), options([ev.eventId, randomUUID(), ev.eventId]));
    expect([...both.keys()]).toEqual([ev.eventId]);
  });

  it('a source that failed after an ok run still has its last statements (not fresh)', async () => {
    const ev = await createScrapedEvent(ctx, {
      home: 'Arsenal',
      away: 'Chelsea',
      startTime: START,
    });
    await seedSource('s-failing', [
      {
        key: 'a',
        kickoff: new Date(START.getTime() - 19 * H),
        changedAt: new Date(NOW.getTime() - 5 * DAY),
      },
    ]);
    await addRun(db(), 's-failing', 'failed', new Date(NOW.getTime() - 10 * MIN));
    const [s] = await statementsOf(ev.eventId, 's-failing');
    expect(s).toMatchObject({ kickoff: new Date(START.getTime() - 19 * H), sourceFresh: false });
    expect(await factsOf('s-failing')).toMatchObject({ healthy: false });
  });
});

describe('sourceFresh and the per-source facts', () => {
  const ENDED = STALE_AFTER + MIN_MATCH;
  const kickoffEndedAgo = (ms: number) => new Date(NOW.getTime() - ms);

  it('known and not stale and healthy is fresh; the statements carry the flag', async () => {
    const ev = await createScrapedEvent(ctx, {
      home: 'Liverpool',
      away: 'Arsenal',
      startTime: START,
    });
    const names = { home: 'Liverpool', away: 'Arsenal' };
    await seedSource(
      's-fresh',
      [
        { key: 'about', kickoff: START, changedAt: new Date(NOW.getTime() - 3 * DAY) },
        // A match that ended four days ago and is resulted: known, and not a scheduled row, so not stale.
        {
          key: 'ended',
          kind: 'result',
          status: 'finished',
          kickoff: kickoffEndedAgo(4 * DAY),
          changedAt: kickoffEndedAgo(4 * DAY - 3 * H),
          home: 'Chelsea',
          away: 'Liverpool',
        },
      ],
      undefined,
      names,
    );
    expect(await factsOf('s-fresh')).toEqual({
      sourceId: 's-fresh',
      upstream: 'up-s-fresh',
      healthy: true,
      known: true,
      stale: false,
      fresh: true,
      latestOkRunStartedAt: new Date(NOW.getTime() - H),
    });
    expect((await statementsOf(ev.eventId, 's-fresh')).map((s) => s.sourceFresh)).toEqual([true]);
  });

  it('a source with nothing ended yet is not known, so not fresh', async () => {
    const ev = await createScrapedEvent(ctx, {
      home: 'Liverpool',
      away: 'Arsenal',
      startTime: START,
    });
    await seedSource(
      's-unknown',
      [{ key: 'about', kickoff: START, changedAt: new Date(NOW.getTime() - 3 * DAY) }],
      {
        firstRunAt: new Date(START.getTime() - 20 * DAY),
        lastRunAt: new Date(START.getTime() - H),
      },
      { home: 'Liverpool', away: 'Arsenal' },
    );
    // "Now" is before the match ends.
    const early = new Date(START.getTime() - 2 * DAY);
    expect(await factsOf('s-unknown', early)).toMatchObject({
      healthy: true,
      known: false,
      stale: false,
      fresh: false,
    });
    expect((await statementsOf(ev.eventId, 's-unknown', early)).map((s) => s.sourceFresh)).toEqual([
      false,
    ]);
  });

  it('known at exactly MIN_MATCH_DURATION_MS + SOURCE_STALE_AFTER_MS after the kickoff, not one millisecond before', async () => {
    const names = { home: 'Chelsea', away: 'Liverpool' };
    const changed = new Date(NOW.getTime() - 20 * DAY);
    // A result row (never stale) of a match that ended exactly ENDED ago, and one a millisecond later.
    await seedSource(
      's-edge-in',
      [{ key: 'm', kind: 'result', kickoff: kickoffEndedAgo(ENDED), changedAt: changed }],
      undefined,
      names,
    );
    await seedSource(
      's-edge-out',
      [{ key: 'm', kind: 'result', kickoff: kickoffEndedAgo(ENDED - 1), changedAt: changed }],
      undefined,
      names,
    );
    expect(await factsOf('s-edge-in')).toMatchObject({ known: true, stale: false, fresh: true });
    expect(await factsOf('s-edge-out')).toMatchObject({ known: false, stale: false, fresh: false });
  });

  it('a listed scheduled match that ended long ago with nothing new since is stale (S5 on its own rows)', async () => {
    const ev = await createScrapedEvent(ctx, {
      home: 'Liverpool',
      away: 'Arsenal',
      startTime: START,
    });
    const kickoff = kickoffEndedAgo(4 * DAY);
    await seedSource(
      's-stale',
      [
        { key: 'about', kickoff: START, changedAt: new Date(kickoff.getTime() - 3 * DAY) },
        {
          key: 'ended',
          kickoff,
          changedAt: new Date(kickoff.getTime() - 3 * DAY),
          home: 'Chelsea',
          away: 'Liverpool',
        },
      ],
      undefined,
      { home: 'Liverpool', away: 'Arsenal' },
    );
    expect(await factsOf('s-stale')).toMatchObject({
      healthy: true,
      known: true,
      stale: true,
      fresh: false,
    });
    expect((await statementsOf(ev.eventId, 's-stale')).map((s) => s.sourceFresh)).toEqual([false]);
  });

  it('stale needs the end to be after the last change: a change exactly at the end clears it, one millisecond before does not', async () => {
    const kickoff = kickoffEndedAgo(4 * DAY);
    const end = new Date(kickoff.getTime() + MIN_MATCH);
    const names = { home: 'Chelsea', away: 'Liverpool' };
    const rows = (lastChange: Date): Row[] => [
      { key: 'ended', kickoff, changedAt: new Date(kickoff.getTime() - 3 * DAY) },
      // Something else the source shows changed later: its content is not frozen.
      {
        key: 'other',
        kickoff: new Date(NOW.getTime() + 5 * DAY),
        changedAt: lastChange,
        home: 'Arsenal',
        away: 'Liverpool',
      },
    ];
    await seedSource('s-changed-at', rows(end), undefined, names);
    await seedSource('s-changed-before', rows(new Date(end.getTime() - 1)), undefined, names);
    expect(await factsOf('s-changed-at')).toMatchObject({ known: true, stale: false, fresh: true });
    expect(await factsOf('s-changed-before')).toMatchObject({
      known: true,
      stale: true,
      fresh: false,
    });
  });

  it('rows a source no longer lists make it neither known nor stale', async () => {
    await addSource(db(), 's-gone', { upstream: 'up-gone' });
    const t1 = new Date(NOW.getTime() - 20 * DAY);
    const r1 = await addRun(db(), 's-gone', 'ok', t1);
    const base = {
      sourceId: 's-gone',
      competitionId: ctx.competitionId,
      homeTeamId: ctx.team('Chelsea'),
      awayTeamId: ctx.team('Liverpool'),
    };
    // Run 1 showed a match that ended four days ago (kept as the old-day row of a keyless source).
    await db().transaction((tx) =>
      upsertObservation(
        tx,
        fixtureObs({
          ...base,
          runId: r1.id,
          sourceKey: 'gone',
          kickoff: kickoffEndedAgo(4 * DAY),
          observedAt: t1,
        }),
      ),
    );
    // Run 2 shows only a future match: the old row is not listed any more.
    const t2 = new Date(NOW.getTime() - H);
    const r2 = await addRun(db(), 's-gone', 'ok', t2);
    await db().transaction((tx) =>
      upsertObservation(
        tx,
        fixtureObs({
          ...base,
          runId: r2.id,
          sourceKey: 'future',
          kickoff: new Date(NOW.getTime() + 5 * DAY),
          observedAt: t2,
        }),
      ),
    );
    expect(await factsOf('s-gone')).toMatchObject({
      healthy: true,
      known: false,
      stale: false,
      fresh: false,
    });
  });

  it('a free events source (theoddsapi, mode events) that moves on past an ended match is known', async () => {
    // The same history as the test above, but the source is The Odds API's free /events list: it
    // lists upcoming matches only, so "no longer listed after it ended" is how it shows it follows.
    await addSource(db(), 's-events', { upstream: 'up-events' });
    await db()
      .update(scrapeSources)
      .set({ adapter: 'theoddsapi', config: { mode: 'events', allowedHosts: ['example.test'] } })
      .where(eq(scrapeSources.id, 's-events'));
    const t1 = new Date(NOW.getTime() - 20 * DAY);
    const r1 = await addRun(db(), 's-events', 'ok', t1);
    const base = {
      sourceId: 's-events',
      competitionId: ctx.competitionId,
      homeTeamId: ctx.team('Chelsea'),
      awayTeamId: ctx.team('Liverpool'),
    };
    await db().transaction((tx) =>
      upsertObservation(
        tx,
        fixtureObs({
          ...base,
          runId: r1.id,
          sourceKey: 'gone',
          kickoff: kickoffEndedAgo(4 * DAY),
          observedAt: t1,
        }),
      ),
    );
    const t2 = new Date(NOW.getTime() - H);
    const r2 = await addRun(db(), 's-events', 'ok', t2);
    await db().transaction((tx) =>
      upsertObservation(
        tx,
        fixtureObs({
          ...base,
          runId: r2.id,
          sourceKey: 'future',
          kickoff: new Date(NOW.getTime() + 5 * DAY),
          observedAt: t2,
        }),
      ),
    );
    expect(await factsOf('s-events')).toMatchObject({ healthy: true, known: true, stale: false });
    // Before it has watched a match end it is not known (nothing to show it follows).
    await addSource(db(), 's-events-new', { upstream: 'up-events-new' });
    await db()
      .update(scrapeSources)
      .set({ adapter: 'theoddsapi', config: { mode: 'events', allowedHosts: ['example.test'] } })
      .where(eq(scrapeSources.id, 's-events-new'));
    const r3 = await addRun(db(), 's-events-new', 'ok', t2);
    await db().transaction((tx) =>
      upsertObservation(
        tx,
        fixtureObs({
          ...base,
          sourceId: 's-events-new',
          runId: r3.id,
          sourceKey: 'future',
          kickoff: new Date(NOW.getTime() + 5 * DAY),
          observedAt: t2,
        }),
      ),
    );
    expect(await factsOf('s-events-new')).toMatchObject({ known: false, fresh: false });
  });

  it('a source whose latest finished run failed is not healthy, so not fresh; a skipped run does not count', async () => {
    await seedSource(
      's-unhealthy',
      [
        {
          key: 'ended',
          kind: 'result',
          kickoff: kickoffEndedAgo(4 * DAY),
          changedAt: kickoffEndedAgo(4 * DAY),
        },
      ],
      undefined,
      { home: 'Chelsea', away: 'Liverpool' },
    );
    expect(await factsOf('s-unhealthy')).toMatchObject({ healthy: true, fresh: true });
    await addRun(db(), 's-unhealthy', 'skipped', new Date(NOW.getTime() - 20 * MIN));
    expect(await factsOf('s-unhealthy')).toMatchObject({ healthy: true, fresh: true });
    await addRun(db(), 's-unhealthy', 'broken', new Date(NOW.getTime() - 10 * MIN));
    expect(await factsOf('s-unhealthy')).toMatchObject({
      healthy: false,
      known: true,
      stale: false,
      fresh: false,
    });
    await addRun(db(), 's-unhealthy', 'ok', new Date(NOW.getTime() - 5 * MIN));
    expect(await factsOf('s-unhealthy')).toMatchObject({ healthy: true });
  });

  it('a source that never had an ok run has no latest ok start and no fresh state', async () => {
    await addSource(db(), 's-never', { upstream: 'up-never' });
    await addRun(db(), 's-never', 'failed', new Date(NOW.getTime() - H));
    expect(await factsOf('s-never')).toEqual({
      sourceId: 's-never',
      upstream: 'up-never',
      healthy: false,
      known: false,
      stale: false,
      fresh: false,
      latestOkRunStartedAt: null,
    });
  });
});

describe('person confirmation record', () => {
  const key = (c: string) => c.repeat(64);

  it('round trip: written by a staff member, read back with the start, key and the audit time', async () => {
    const ev = await createScrapedEvent(ctx, {
      home: 'Chelsea',
      away: 'Liverpool',
      startTime: START,
    });
    expect((await evidenceOf(ev.eventId)).person).toBeNull();
    await db().transaction((tx) =>
      recordKickoffConfirmation(tx, {
        eventId: ev.eventId,
        startTime: START,
        evidenceKey: key('a'),
        actor: STAFF,
        via: 'review',
        itemId: 'item-1',
      }),
    );
    const [audit] = await db()
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, KICKOFF_CONFIRMED_AUDIT_ACTION), eq(auditLog.targetId, ev.eventId)),
      );
    expect(audit).toMatchObject({
      actorType: 'admin',
      actorId: STAFF.adminId,
      targetType: 'event',
      ip: STAFF.ip,
      metadata: {
        startTime: START.toISOString(),
        evidenceKey: key('a'),
        via: 'review',
        itemId: 'item-1',
      },
    });
    expect((await evidenceOf(ev.eventId)).person).toEqual({
      startTime: START,
      confirmedAt: audit!.createdAt,
      evidenceKey: key('a'),
    });
  });

  it('the latest record wins; a rolled-back one leaves nothing; other events are separate', async () => {
    const a = await createScrapedEvent(ctx, {
      home: 'Chelsea',
      away: 'Liverpool',
      startTime: START,
    });
    const b = await createScrapedEvent(ctx, {
      home: 'Liverpool',
      away: 'Chelsea',
      startTime: START,
    });
    const record = (
      eventId: string,
      startTime: Date,
      evidenceKey: string,
      via: 'review' | 'trading',
    ) =>
      db().transaction((tx) =>
        recordKickoffConfirmation(tx, { eventId, startTime, evidenceKey, actor: STAFF, via }),
      );
    const moved = new Date(START.getTime() - 19 * H);
    await record(a.eventId, START, key('1'), 'review');
    await record(a.eventId, moved, key('2'), 'trading');
    await record(b.eventId, START, key('3'), 'trading');
    const both = await loadKickoffEvidence(db(), options([a.eventId, b.eventId]));
    expect(both.get(a.eventId)!.person).toMatchObject({ startTime: moved, evidenceKey: key('2') });
    expect(both.get(b.eventId)!.person).toMatchObject({ startTime: START, evidenceKey: key('3') });

    // A refusal after the record rolls it back with the transaction.
    await expect(
      db().transaction(async (tx) => {
        await recordKickoffConfirmation(tx, {
          eventId: a.eventId,
          startTime: START,
          evidenceKey: key('4'),
          actor: STAFF,
          via: 'review',
        });
        throw new Error('O1 refused');
      }),
    ).rejects.toThrow('O1 refused');
    expect((await evidenceOf(a.eventId)).person).toMatchObject({ evidenceKey: key('2') });
  });

  it('a malformed latest record confirms nothing (fail closed)', async () => {
    const ev = await createScrapedEvent(ctx, {
      home: 'Liverpool',
      away: 'Chelsea',
      startTime: START,
    });
    await db().transaction((tx) =>
      recordKickoffConfirmation(tx, {
        eventId: ev.eventId,
        startTime: START,
        evidenceKey: key('5'),
        actor: STAFF,
        via: 'trading',
      }),
    );
    expect((await evidenceOf(ev.eventId)).person).not.toBeNull();
    await db().transaction((tx) =>
      writeAudit(tx, {
        actorType: 'admin',
        actorId: STAFF.adminId,
        action: KICKOFF_CONFIRMED_AUDIT_ACTION,
        targetType: 'event',
        targetId: ev.eventId,
        metadata: { startTime: 'not a date' },
      }),
    );
    expect((await evidenceOf(ev.eventId)).person).toBeNull();
  });

  it('rejects an invalid start time', async () => {
    const ev = await createScrapedEvent(ctx, {
      home: 'Liverpool',
      away: 'Chelsea',
      startTime: START,
    });
    await expect(
      db().transaction((tx) =>
        recordKickoffConfirmation(tx, {
          eventId: ev.eventId,
          startTime: new Date(Number.NaN),
          evidenceKey: key('6'),
          actor: STAFF,
          via: 'review',
        }),
      ),
    ).rejects.toThrow(RangeError);
  });
});
