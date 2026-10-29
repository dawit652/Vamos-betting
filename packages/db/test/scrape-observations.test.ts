import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  listCurrentObservations,
  listObservationHistory,
  listUnresolvedObservations,
  observationPayloadHash,
  setObservationResolution,
  setSourceEnabled,
  upsertObservation,
} from '../src/index';
import { scrapeObservationHistory, scrapeObservations } from '../src/schema/index';
import { dropTestDatabase, errorText, pgCode } from './helpers';
import {
  addRun,
  addSource,
  createScrapeDatabase,
  fixtureObs,
  KICKOFF,
  resultObs,
  SYSTEM,
  T0,
  type ScrapeTestContext,
} from './scrape-fixtures';

let ctx: ScrapeTestContext;
let runId: string;
const MIN = 60_000;
const at = (minutes: number) => new Date(T0.getTime() + minutes * MIN);

beforeAll(async () => {
  ctx = await createScrapeDatabase();
  await addSource(ctx.handle.db, 'src-a', { upstream: 'up-a' });
  await addSource(ctx.handle.db, 'src-b', { upstream: 'up-b' });
  runId = (await addRun(ctx.handle.db, 'src-a', 'ok', T0)).id;
});
afterAll(async () => {
  await dropTestDatabase(ctx?.handle);
});

const upsert = (input: Parameters<typeof upsertObservation>[1]) =>
  ctx.handle.db.transaction((tx) => upsertObservation(tx, input));
const history = (id: string) => listObservationHistory(ctx.handle.db, id);

describe('upsertObservation', () => {
  it('inserts a new key with one history row', async () => {
    const result = await upsert(fixtureObs({ sourceId: 'src-a', runId, sourceKey: 'new-1' }));
    expect(result).toMatchObject({ changed: true, created: true, firstSeenAt: T0, changedAt: T0 });
    const rows = await history(result.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ payloadHash: result.payloadHash, seenAt: T0, runId });
  });

  it('an identical payload only moves last_seen_at, run_id and raw_id', async () => {
    const first = await upsert(fixtureObs({ sourceId: 'src-a', runId, sourceKey: 'same-1' }));
    const run2 = (await addRun(ctx.handle.db, 'src-a', 'ok', at(15))).id;
    const second = await upsert(
      fixtureObs({ sourceId: 'src-a', runId: run2, sourceKey: 'same-1', observedAt: at(15) }),
    );
    expect(second).toMatchObject({ changed: false, created: false, id: first.id });
    expect(second.changedAt).toEqual(T0);
    expect(second.lastSeenAt).toEqual(at(15));
    expect(await history(first.id)).toHaveLength(1);
    const [row] = await ctx.handle.db
      .select()
      .from(scrapeObservations)
      .where(eq(scrapeObservations.id, first.id));
    expect(row).toMatchObject({ lastSeenAt: at(15), changedAt: T0, firstSeenAt: T0, runId: run2 });
  });

  it('a changed payload updates the row, sets changed_at and appends history in order', async () => {
    const key = 'change-1';
    const a = await upsert(fixtureObs({ sourceId: 'src-a', runId, sourceKey: key }));
    const b = await upsert(
      fixtureObs({
        sourceId: 'src-a',
        runId,
        sourceKey: key,
        kickoff: at(60 * 24 * 8),
        observedAt: at(20),
      }),
    );
    expect(b).toMatchObject({ changed: true, created: false, id: a.id, changedAt: at(20) });
    expect(b.firstSeenAt).toEqual(T0);
    expect(b.payloadHash).not.toBe(a.payloadHash);
    const c = await upsert(
      fixtureObs({
        sourceId: 'src-a',
        runId,
        sourceKey: key,
        kickoff: at(60 * 24 * 8),
        status: 'postponed',
        observedAt: at(40),
      }),
    );
    expect(c.changed).toBe(true);
    const rows = await history(a.id);
    expect(rows.map((r) => r.status)).toEqual(['scheduled', 'scheduled', 'postponed']);
    expect(rows.map((r) => r.seenAt)).toEqual([T0, at(20), at(40)]);
  });

  it('flipping back to an earlier payload appends a third distinct history row', async () => {
    const key = 'flip-1';
    const base = fixtureObs({ sourceId: 'src-a', runId, sourceKey: key });
    const a = await upsert(base);
    await upsert({ ...base, status: 'postponed', observedAt: at(5) });
    await upsert({ ...base, observedAt: at(10) });
    expect(await history(a.id)).toHaveLength(3);
  });

  it('results carry the score and basis through to the history', async () => {
    const r = await upsert(resultObs({ sourceId: 'src-a', runId, sourceKey: 'res-1' }));
    const corrected = await upsert(
      resultObs({
        sourceId: 'src-a',
        runId,
        sourceKey: 'res-1',
        score: { home: 3, away: 1, htHome: 1, htAway: 0 },
        observedAt: at(30),
      }),
    );
    expect(corrected.changed).toBe(true);
    const rows = await history(r.id);
    expect(rows.map((x) => x.score?.home)).toEqual([2, 3]);
    expect(rows.every((x) => x.scoreBasis === 'regular_time')).toBe(true);
  });

  it('ignores a read older than the current row (no rewind)', async () => {
    const key = 'stale-1';
    const a = await upsert(
      fixtureObs({ sourceId: 'src-a', runId, sourceKey: key, observedAt: at(50) }),
    );
    const stale = await upsert(
      fixtureObs({
        sourceId: 'src-a',
        runId,
        sourceKey: key,
        status: 'postponed',
        observedAt: at(10),
      }),
    );
    expect(stale.changed).toBe(false);
    expect(stale.payloadHash).toBe(a.payloadHash);
    expect(await history(a.id)).toHaveLength(1);
  });

  it('keeps resolved ids while the names are unchanged and clears them when a name changes', async () => {
    const key = 'resolve-keep';
    const base = fixtureObs({
      sourceId: 'src-a',
      runId,
      sourceKey: key,
      competitionId: ctx.competitionId,
      homeTeamId: ctx.team('Arsenal'),
      awayTeamId: ctx.team('Chelsea'),
    });
    const a = await upsert(base);
    // status change, names same, ids not repeated: still resolved
    await upsert({
      ...fixtureObs({ sourceId: 'src-a', runId, sourceKey: key }),
      status: 'postponed',
      observedAt: at(5),
    });
    const [kept] = await ctx.handle.db
      .select()
      .from(scrapeObservations)
      .where(eq(scrapeObservations.id, a.id));
    expect(kept?.homeTeamId).toBe(ctx.team('Arsenal'));
    await upsert({
      ...fixtureObs({ sourceId: 'src-a', runId, sourceKey: key, homeRaw: 'Gunners' }),
      status: 'postponed',
      observedAt: at(6),
    });
    const [cleared] = await ctx.handle.db
      .select()
      .from(scrapeObservations)
      .where(eq(scrapeObservations.id, a.id));
    expect(cleared).toMatchObject({ homeTeamId: null, awayTeamId: null, competitionId: null });
  });

  it('review finding 8: an explicit null resolution is written, undefined keeps the stored one', async () => {
    const key = 'resolve-explicit-null';
    const ids = {
      competitionId: ctx.competitionId,
      homeTeamId: ctx.team('Arsenal'),
      awayTeamId: ctx.team('Chelsea'),
    };
    const a = await upsert(fixtureObs({ sourceId: 'src-a', runId, sourceKey: key, ...ids }));
    const read = async () =>
      (
        await ctx.handle.db.select().from(scrapeObservations).where(eq(scrapeObservations.id, a.id))
      )[0];
    // Identical payload, ids not given: kept.
    await upsert({
      ...fixtureObs({ sourceId: 'src-a', runId, sourceKey: key }),
      observedAt: at(2),
    });
    expect(await read()).toMatchObject({ homeTeamId: ids.homeTeamId });
    // Identical payload, the home team no longer resolves: cleared, the rest kept.
    await upsert({
      ...fixtureObs({ sourceId: 'src-a', runId, sourceKey: key, ...ids }),
      homeTeamId: null,
      observedAt: at(3),
    });
    expect(await read()).toMatchObject({
      homeTeamId: null,
      awayTeamId: ids.awayTeamId,
      competitionId: ids.competitionId,
    });
    // Changed payload, same names, away team explicitly unresolved: cleared too.
    await upsert({
      ...fixtureObs({ sourceId: 'src-a', runId, sourceKey: key, ...ids }),
      homeTeamId: ids.homeTeamId,
      awayTeamId: null,
      status: 'postponed',
      observedAt: at(4),
    });
    expect(await read()).toMatchObject({
      homeTeamId: ids.homeTeamId,
      awayTeamId: null,
      competitionId: ids.competitionId,
    });
  });

  it('rejects inconsistent input before it reaches the database', async () => {
    const base = { sourceId: 'src-a', runId, sourceKey: 'bad-1' };
    await expect(upsert(resultObs({ ...base, score: null }))).rejects.toThrow(/score/);
    await expect(upsert(resultObs({ ...base, status: 'cancelled' }))).rejects.toThrow(/score/);
    await expect(
      upsert(resultObs({ ...base, score: { home: 100, away: 0, htHome: null, htAway: null } })),
    ).rejects.toThrow(/0 to 99/);
    await expect(upsert(resultObs({ ...base, scoreBasis: null }))).rejects.toThrow(/basis/);
    await expect(upsert(fixtureObs({ ...base, status: 'finished' }))).rejects.toThrow(/status/);
    await expect(upsert(fixtureObs({ ...base, scoreBasis: 'regular_time' }))).rejects.toThrow(
      /basis/,
    );
  });

  it('concurrent upserts of one key leave one row and a consistent history', async () => {
    const key = 'race-1';
    const variants = Array.from({ length: 12 }, (_, i) =>
      fixtureObs({
        sourceId: 'src-a',
        runId,
        sourceKey: key,
        // 3 distinct payloads, each sent four times, all with the same clock
        status: (['scheduled', 'postponed', 'cancelled'] as const)[i % 3]!,
        observedAt: at(100),
      }),
    );
    const results = await Promise.all(variants.map((v) => upsert(v)));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    const rows = await ctx.handle.db
      .select()
      .from(scrapeObservations)
      .where(eq(scrapeObservations.sourceKey, key));
    expect(rows).toHaveLength(1);
    const hist = await history(rows[0]!.id);
    // one history row per applied change, never two equal neighbours, and the current row is the last one
    expect(hist.length).toBeGreaterThanOrEqual(3);
    expect(hist.length).toBeLessThanOrEqual(12);
    for (let i = 1; i < hist.length; i += 1) {
      expect(hist[i]!.payloadHash).not.toBe(hist[i - 1]!.payloadHash);
    }
    expect(hist.at(-1)!.payloadHash).toBe(rows[0]!.payloadHash);
    expect(results.filter((r) => r.changed)).toHaveLength(hist.length);
  });

  it('concurrent identical upserts of a new key insert once', async () => {
    const input = fixtureObs({
      sourceId: 'src-b',
      runId,
      sourceKey: 'race-same',
      observedAt: at(1),
    });
    const results = await Promise.all(Array.from({ length: 8 }, () => upsert(input)));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    expect(await history(results[0]!.id)).toHaveLength(1);
  });

  it('payload hash ignores resolved ids and observedAt but not the claim', () => {
    const a = fixtureObs({ sourceId: 'src-a', runId });
    const other = { ...a, observedAt: at(99), competitionId: ctx.competitionId };
    expect(observationPayloadHash(a)).toBe(observationPayloadHash(other));
    expect(observationPayloadHash(a)).not.toBe(observationPayloadHash({ ...a, homeRaw: 'Other' }));
    expect(observationPayloadHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('database constraints on observations', () => {
  const insertRaw = (values: Record<string, unknown>) =>
    ctx.handle.db.execute(sql`
      INSERT INTO scrape_observations (source_id, kind, source_key, sport, competition_raw, home_raw,
        away_raw, kickoff, status, score, score_basis, payload_hash, first_seen_at, last_seen_at,
        changed_at, run_id)
      VALUES ('src-a', ${values.kind ?? 'result'}, ${`chk-${Math.random()}`}, ${values.sport ?? 'football'},
        'c', 'h', 'a', now(), ${values.status ?? 'finished'}, ${values.score ?? null}::jsonb,
        ${values.basis === undefined ? 'regular_time' : values.basis}, ${values.hash ?? 'a'.repeat(64)},
        now(), now(), now(), ${runId})`);

  it('accepts a well-formed finished result and rejects each broken shape', async () => {
    await insertRaw({ score: '{"home":1,"away":0,"htHome":null,"htAway":null}' });
    const bad: Array<[string, Record<string, unknown>]> = [
      ['unknown kind', { kind: 'live', score: null, status: 'scheduled', basis: null }],
      ['unknown sport', { sport: 'cricket', score: '{"home":1,"away":0}' }],
      ['unknown result status', { status: 'won', score: null }],
      ['finished without score', { score: null }],
      ['cancelled with a score', { status: 'cancelled', score: '{"home":1,"away":0}' }],
      ['negative score', { score: '{"home":-1,"away":0}' }],
      ['score above 99', { score: '{"home":100,"away":0}' }],
      ['fractional score', { score: '{"home":1.5,"away":0}' }],
      ['string score', { score: '{"home":"a","away":0}' }],
      ['half time on one side only', { score: '{"home":1,"away":0,"htHome":0}' }],
      ['result without a basis', { score: '{"home":1,"away":0}', basis: null }],
      ['unknown basis', { score: '{"home":1,"away":0}', basis: 'penalties' }],
      ['bad hash', { score: '{"home":1,"away":0}', hash: 'xyz' }],
      [
        'fixture with fixture-invalid status',
        { kind: 'fixture', status: 'finished', score: null, basis: null },
      ],
      [
        'fixture with a score basis',
        { kind: 'fixture', status: 'scheduled', score: null, basis: 'regular_time' },
      ],
    ];
    for (const [name, values] of bad) {
      const error = await insertRaw(values).then(
        () => null,
        (e: unknown) => e,
      );
      expect(pgCode(error), name).toBe('23514');
    }
  });

  it('one current row per (source, kind, source_key)', async () => {
    const input = fixtureObs({ sourceId: 'src-b', runId, sourceKey: 'uniq-1' });
    await upsert(input);
    const error = await ctx.handle.db
      .execute(
        sql`INSERT INTO scrape_observations (source_id, kind, source_key, sport, competition_raw, home_raw,
        away_raw, kickoff, status, payload_hash, first_seen_at, last_seen_at, changed_at, run_id)
        VALUES ('src-b', 'fixture', 'uniq-1', 'football', 'c', 'h', 'a', now(), 'scheduled',
        ${'b'.repeat(64)}, now(), now(), now(), ${runId})`,
      )
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(pgCode(error)).toBe('23505');
  });
});

describe('the history is append-only', () => {
  it('rejects UPDATE, DELETE and TRUNCATE', async () => {
    const r = await upsert(fixtureObs({ sourceId: 'src-a', runId, sourceKey: 'append-1' }));
    for (const statement of [
      sql`UPDATE scrape_observation_history SET status = 'cancelled' WHERE observation_id = ${r.id}`,
      sql`DELETE FROM scrape_observation_history WHERE observation_id = ${r.id}`,
      sql`TRUNCATE scrape_observation_history`,
    ]) {
      const error = await ctx.handle.db.execute(statement).then(
        () => null,
        (e: unknown) => e,
      );
      expect(pgCode(error)).toBe('23001');
      expect(errorText(error)).toMatch(/append-only/);
    }
    expect(await history(r.id)).toHaveLength(1);
  });

  it('the observation a history row points to cannot be deleted', async () => {
    const r = await upsert(fixtureObs({ sourceId: 'src-a', runId, sourceKey: 'append-2' }));
    const error = await ctx.handle.db
      .delete(scrapeObservations)
      .where(eq(scrapeObservations.id, r.id))
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(pgCode(error)).toBe('23503');
    const count = await ctx.handle.db.$count(
      scrapeObservationHistory,
      eq(scrapeObservationHistory.observationId, r.id),
    );
    expect(count).toBe(1);
  });
});

describe('listing', () => {
  it('filters by kind, competition, kickoff window, sources and resolution; hides disabled sources', async () => {
    await addSource(ctx.handle.db, 'src-list', { upstream: 'up-list' });
    const lrun = (await addRun(ctx.handle.db, 'src-list', 'ok', at(200))).id;
    const base = { sourceId: 'src-list', runId: lrun, observedAt: at(200) };
    const early = new Date('2027-01-01T15:00:00Z');
    const late = new Date('2027-01-10T15:00:00Z');
    await upsert(
      fixtureObs({
        ...base,
        sourceKey: 'l1',
        kickoff: early,
        competitionId: ctx.competitionId,
        homeTeamId: ctx.team('Arsenal'),
        awayTeamId: ctx.team('Chelsea'),
      }),
    );
    await upsert(fixtureObs({ ...base, sourceKey: 'l2', kickoff: late }));
    await upsert(
      resultObs({
        ...base,
        sourceKey: 'l3',
        kickoff: early,
        competitionId: ctx.competitionId,
        homeTeamId: ctx.team('Arsenal'),
        awayTeamId: ctx.team('Chelsea'),
      }),
    );
    const db = ctx.handle.db;
    const q = { sourceIds: ['src-list'], limit: 100 };
    const all = await listCurrentObservations(db, q);
    expect(all.map((o) => o.sourceKey)).toEqual(['l1', 'l3', 'l2']);
    expect(all[0]).toMatchObject({
      upstream: 'up-list',
      sourceId: 'src-list',
      kind: 'fixture',
      rawId: null,
    });
    expect(all[0]!.firstSeenAt).toEqual(at(200));
    expect(all[1]).toMatchObject({ scoreBasis: 'regular_time', score: { home: 2, away: 1 } });
    expect(
      (await listCurrentObservations(db, { ...q, kind: 'result' })).map((o) => o.sourceKey),
    ).toEqual(['l3']);
    expect(
      (await listCurrentObservations(db, { ...q, resolvedOnly: true })).map((o) => o.sourceKey),
    ).toEqual(['l1', 'l3']);
    expect(
      (
        await listCurrentObservations(db, {
          ...q,
          competitionId: ctx.competitionId,
          kind: 'fixture',
        })
      ).map((o) => o.sourceKey),
    ).toEqual(['l1']);
    expect(
      (
        await listCurrentObservations(db, { ...q, kickoffFrom: new Date('2027-01-05T00:00:00Z') })
      ).map((o) => o.sourceKey),
    ).toEqual(['l2']);
    expect(
      (await listCurrentObservations(db, { ...q, kickoffTo: new Date('2027-01-05T00:00:00Z') }))
        .length,
    ).toBe(2);
    expect(await listCurrentObservations(db, { sourceIds: [], limit: 10 })).toEqual([]);
    expect(await listCurrentObservations(db, { ...q, limit: 1 })).toHaveLength(1);

    await db.transaction((tx) => setSourceEnabled(tx, 'src-list', false, SYSTEM));
    expect(await listCurrentObservations(db, q)).toEqual([]);
    expect(await listCurrentObservations(db, { ...q, includeDisabledSources: true })).toHaveLength(
      3,
    );
  });

  it('lists unresolved observations and resolves them without touching changed_at', async () => {
    const r = await upsert(
      fixtureObs({ sourceId: 'src-b', runId, sourceKey: 'unres-1', observedAt: at(300) }),
    );
    const unresolved = await listUnresolvedObservations(ctx.handle.db, {
      sourceIds: ['src-b'],
      limit: 50,
    });
    expect(unresolved.map((o) => o.sourceKey)).toContain('unres-1');
    const ok = await ctx.handle.db.transaction((tx) =>
      setObservationResolution(tx, r.id, {
        competitionId: ctx.competitionId,
        homeTeamId: ctx.team('Arsenal'),
        awayTeamId: ctx.team('Chelsea'),
      }),
    );
    expect(ok).toBe(true);
    const after = await listUnresolvedObservations(ctx.handle.db, {
      sourceIds: ['src-b'],
      limit: 50,
    });
    expect(after.map((o) => o.sourceKey)).not.toContain('unres-1');
    const [row] = await ctx.handle.db
      .select()
      .from(scrapeObservations)
      .where(eq(scrapeObservations.id, r.id));
    expect(row?.changedAt).toEqual(at(300));
    expect(
      await ctx.handle.db.transaction((tx) =>
        setObservationResolution(tx, '00000000-0000-4000-8000-000000000000', {
          competitionId: null,
          homeTeamId: null,
          awayTeamId: null,
        }),
      ),
    ).toBe(false);
    void KICKOFF;
  });
});
