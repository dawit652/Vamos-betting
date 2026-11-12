import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ladderShadowKey,
  listLadderShadow,
  listSourceTrust,
  listTruthCheckEvents,
  newestSourceTrustMeasuredAt,
  recordLadderShadow,
  resultEvent,
  startRun,
  upsertObservation,
  upsertSourceTrust,
  writeAudit,
  type LadderShadowDecision,
} from '../src/index';
import { dropTestDatabase } from './helpers';
import {
  addSource,
  createScrapeDatabase,
  createScrapedEvent,
  KICKOFF,
  resultObs,
  T0,
  type ScrapeTestContext,
} from './scrape-fixtures';

let ctx: ScrapeTestContext;
beforeAll(async () => {
  ctx = await createScrapeDatabase();
});
afterAll(async () => {
  await dropTestDatabase(ctx?.handle);
});

const H = 3_600_000;

describe('scrape_source_trust', () => {
  it('upserts one row per upstream and sport and lists them by upstream', async () => {
    const { db } = ctx.handle;
    expect(await newestSourceTrustMeasuredAt(db, 'football')).toBeNull();
    expect((await listSourceTrust(db, 'football')).size).toBe(0);

    const row = {
      upstream: 'opta',
      sport: 'football',
      compared: 1000,
      agreed: 999,
      windowFrom: new Date('2026-07-01T00:00:00Z'),
      windowTo: new Date('2026-11-01T00:00:00Z'),
      disagreements: [{ eventId: 'x' }],
      measuredAt: T0,
    };
    await upsertSourceTrust(db, row);
    await upsertSourceTrust(db, { ...row, upstream: 'sportmonks', compared: 10, agreed: 10 });
    expect(await listSourceTrust(db, 'football')).toEqual(
      new Map([
        ['opta', { compared: 1000, agreed: 999 }],
        ['sportmonks', { compared: 10, agreed: 10 }],
      ]),
    );

    const later = new Date(T0.getTime() + H);
    await upsertSourceTrust(db, { ...row, compared: 1200, agreed: 1200, measuredAt: later });
    expect((await listSourceTrust(db, 'football')).get('opta')).toEqual({
      compared: 1200,
      agreed: 1200,
    });
    expect(await newestSourceTrustMeasuredAt(db, 'football')).toEqual(later);
    expect((await listSourceTrust(db, 'basketball')).size).toBe(0);
  });

  it('refuses an upstream that is not normalised and counts that cannot be', async () => {
    const { db } = ctx.handle;
    const base = {
      sport: 'football',
      compared: 1,
      agreed: 1,
      windowFrom: null,
      windowTo: null,
      disagreements: [],
      measuredAt: T0,
    };
    await expect(upsertSourceTrust(db, { ...base, upstream: 'Opta' })).rejects.toThrow(RangeError);
    await expect(upsertSourceTrust(db, { ...base, upstream: ' opta' })).rejects.toThrow(RangeError);
    await expect(upsertSourceTrust(db, { ...base, upstream: 'opta', agreed: 2 })).rejects.toThrow(
      RangeError,
    );
  });
});

describe('listTruthCheckEvents', () => {
  it('returns applied events with finished regular-time observations and the votes applied on', async () => {
    const { db } = ctx.handle;
    await addSource(db, 'tc-a', { upstream: 'up-a' });
    await addSource(db, 'tc-b', { upstream: 'up-b', enabled: false });
    const runs = new Map<string, string>();
    for (const id of ['tc-a', 'tc-b']) {
      runs.set(id, (await startRun(db, { sourceId: id, startedAt: T0 })).id);
    }
    const ev = await createScrapedEvent(ctx, { halfTime: true });
    const obs = (
      sourceId: string,
      overrides: Partial<Parameters<typeof resultObs>[0]> = {},
    ): Promise<unknown> =>
      db.transaction((tx) =>
        upsertObservation(tx, {
          ...resultObs({ sourceId, runId: runs.get(sourceId) as string, ...overrides }),
          competitionId: ctx.competitionId,
          homeTeamId: ev.homeTeamId,
          awayTeamId: ev.awayTeamId,
        }),
      );
    await obs('tc-a');
    // A disabled source still said what it said.
    await obs('tc-b', { score: { home: 2, away: 0, htHome: null, htAway: null } });
    // An extra-time score is not a regular-time score.
    await obs('tc-a', {
      sourceKey: 'm-et',
      scoreBasis: 'includes_extra_time',
      score: { home: 9, away: 9, htHome: null, htAway: null },
    });

    // Not applied yet: nothing to compare with.
    const since = new Date(KICKOFF.getTime() - H);
    expect(await listTruthCheckEvents(db, { sport: 'football', since })).toEqual([]);

    await db.transaction(async (tx) => {
      await resultEvent(tx, ev.eventId, {
        status: 'finished',
        score: { home: 2, away: 1, htHome: 1, htAway: 0 },
      });
      await writeAudit(tx, {
        actorType: 'system',
        actorId: 'scraper',
        action: 'scrape.result.applied',
        targetType: 'event',
        targetId: ev.eventId,
        metadata: { upstreams: ['up-a', 'up-c'] },
      });
    });

    const [row, ...rest] = await listTruthCheckEvents(db, { sport: 'football', since });
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      eventId: ev.eventId,
      applied: { home: 2, away: 1, htHome: 1, htAway: 0 },
      appliedOn: ['up-a', 'up-c'],
    });
    expect(
      row?.observations.map((o) => [o.sourceId, o.upstream, o.score.home, o.score.htHome]),
    ).toEqual([
      ['tc-a', 'up-a', 2, 1],
      ['tc-b', 'up-b', 2, null],
    ]);

    // Kicked off before `since`: left out. Other sport: left out.
    expect(
      await listTruthCheckEvents(db, { sport: 'football', since: new Date(KICKOFF.getTime() + H) }),
    ).toEqual([]);
    expect(await listTruthCheckEvents(db, { sport: 'basketball', since })).toEqual([]);
  });

  it('keeps appliedOn null for a result with no scraper audit row', async () => {
    const { db } = ctx.handle;
    const start = new Date(KICKOFF.getTime() + 24 * H);
    const ev = await createScrapedEvent(ctx, {
      home: 'Liverpool',
      away: 'Everton',
      startTime: start,
    });
    const run = await startRun(db, { sourceId: 'tc-a', startedAt: T0 });
    await db.transaction(async (tx) => {
      await upsertObservation(tx, {
        ...resultObs({
          sourceId: 'tc-a',
          runId: run.id,
          sourceKey: 'hand',
          kickoff: start,
          homeRaw: 'Liverpool',
          awayRaw: 'Everton',
        }),
        competitionId: ctx.competitionId,
        homeTeamId: ev.homeTeamId,
        awayTeamId: ev.awayTeamId,
      });
      await resultEvent(tx, ev.eventId, {
        status: 'finished',
        score: { home: 2, away: 1, htHome: 1, htAway: 0 },
      });
    });
    const rows = await listTruthCheckEvents(db, { sport: 'football', since: start });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.appliedOn).toBeNull();
  });
});

describe('scrape_ladder_shadow', () => {
  const apply: LadderShadowDecision = {
    action: 'apply',
    rung: 'C',
    score: { home: 2, away: 1, htHome: 1, htAway: 0 },
    upstreams: ['opta'],
    dissent: [],
  };
  const voidD: LadderShadowDecision = {
    action: 'void',
    rung: 'D',
    reason: 'no_result',
    strict: false,
    notPlayed: [],
  };

  it('builds the decision key', () => {
    expect(ladderShadowKey(apply)).toBe('apply:C::2-1/1-0');
    expect(
      ladderShadowKey({ ...apply, score: { home: 0, away: 0, htHome: null, htAway: null } }),
    ).toBe('apply:C::0-0/-');
    expect(ladderShadowKey(voidD)).toBe('void:D:no_result:');
    expect(ladderShadowKey({ action: 'wait' })).toBeNull();
  });

  it('ignores wait and none', async () => {
    const { db } = ctx.handle;
    const ev = await createScrapedEvent(ctx);
    expect(
      await recordLadderShadow(db, { eventId: ev.eventId, decision: { action: 'wait' }, now: T0 }),
    ).toBe(false);
    expect(
      await recordLadderShadow(db, { eventId: ev.eventId, decision: { action: 'none' }, now: T0 }),
    ).toBe(false);
    expect(
      (await listLadderShadow(db, { since: new Date(0) })).filter((r) => r.eventId === ev.eventId),
    ).toEqual([]);
  });

  it('writes the same decision once within an hour, refreshes it after, and keeps a changed decision as a new row', async () => {
    const { db } = ctx.handle;
    const ev = await createScrapedEvent(ctx, { home: 'Liverpool', away: 'Everton' });
    const rows = async () =>
      (await listLadderShadow(db, { since: new Date(0) })).filter((r) => r.eventId === ev.eventId);
    const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
    const record = (decision: LadderShadowDecision, minutes: number) =>
      recordLadderShadow(db, { eventId: ev.eventId, decision, now: at(minutes) });

    expect(await record(apply, 0)).toBe(true);
    // A pass every minute does not rewrite the row; exactly one hour is not "more than".
    expect(await record(apply, 1)).toBe(false);
    expect(await record(apply, 60)).toBe(false);
    expect((await rows()).map((r) => r.lastDecidedAt)).toEqual([at(0)]);
    expect(await record(apply, 61)).toBe(true);
    const [first, ...others] = await rows();
    expect(others).toEqual([]);
    expect(first).toMatchObject({
      rung: 'C',
      action: 'apply',
      reason: null,
      strict: null,
      upstreams: ['opta'],
      dissent: [],
      score: { home: 2, away: 1, htHome: 1, htAway: 0 },
      firstDecidedAt: at(0),
      lastDecidedAt: at(61),
      event: { status: 'scheduled', resultedAt: null, score: null },
    });

    // Another score, and a void, are new rows.
    expect(await record({ ...apply, score: { home: 3, away: 1, htHome: 1, htAway: 0 } }, 62)).toBe(
      true,
    );
    expect(await record(voidD, 63)).toBe(true);
    const all = await rows();
    expect(all.map((r) => r.decisionKey).sort()).toEqual([
      'apply:C::2-1/1-0',
      'apply:C::3-1/1-0',
      'void:D:no_result:',
    ]);
    expect(all.find((r) => r.action === 'void')).toMatchObject({
      rung: 'D',
      reason: 'no_result',
      strict: false,
      score: null,
    });
  });

  it('refuses a row the table would refuse (a void needs strict, a rung C needs a score)', async () => {
    const { db } = ctx.handle;
    const ev = await createScrapedEvent(ctx, { home: 'Arsenal', away: 'Everton' });
    await expect(
      recordLadderShadow(db, {
        eventId: ev.eventId,
        decision: { ...voidD, rung: 'C' } as unknown as LadderShadowDecision,
        now: T0,
      }),
    ).rejects.toThrow();
  });

  it('lists from the first decision on, with the event as it is now', async () => {
    const { db } = ctx.handle;
    const ev = await createScrapedEvent(ctx, { home: 'Chelsea', away: 'Everton' });
    await recordLadderShadow(db, {
      eventId: ev.eventId,
      decision: apply,
      now: new Date(T0.getTime() + 100 * H),
    });
    await db.transaction((tx) =>
      resultEvent(tx, ev.eventId, {
        status: 'finished',
        score: { home: 2, away: 1, htHome: 1, htAway: 0 },
      }),
    );
    const after = await listLadderShadow(db, { since: new Date(T0.getTime() + 99 * H) });
    expect(after.map((r) => r.eventId)).toEqual([ev.eventId]);
    expect(after[0]?.event).toMatchObject({
      status: 'finished',
      score: { home: 2, away: 1, htHome: 1, htAway: 0 },
    });
    expect(await listLadderShadow(db, { since: new Date(T0.getTime() + 101 * H) })).toEqual([]);
  });
});
