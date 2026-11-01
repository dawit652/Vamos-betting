import { SCRAPE_REVIEW_KINDS } from '@vamos/core';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addCompetitionAlias,
  addTeamAlias,
  closeReviewItemsBySubject,
  countReviewItemsByKind,
  getCompetitionPolicy,
  getReviewItem,
  getSource,
  getTeamRatings,
  listAliases,
  listCompetitionPolicies,
  listReviewItems,
  listSources,
  loadAliasInputs,
  markRatingApplied,
  openReviewItem,
  removeAlias,
  resolveReviewItem,
  ScrapeAliasConflictError,
  ScrapeReviewStateError,
  setCompetitionPolicy,
  setSourceEnabled,
  setTeamRatings,
  upsertSource,
} from '../src/index';
import { auditLog, scrapeReviewItems, teamAliases, teams } from '../src/schema/index';
import { dropTestDatabase, errorText, pgCode } from './helpers';
import {
  addSource,
  createScrapeDatabase,
  STAFF,
  SYSTEM,
  type ScrapeTestContext,
} from './scrape-fixtures';

let ctx: ScrapeTestContext;
beforeAll(async () => {
  ctx = await createScrapeDatabase();
  await addSource(ctx.handle.db, 'adm-a', { enabled: false });
  await addSource(ctx.handle.db, 'adm-b', { enabled: false });
});
afterAll(async () => {
  await dropTestDatabase(ctx?.handle);
});

const tx = <T>(fn: Parameters<typeof ctx.handle.db.transaction<T>>[0]) =>
  ctx.handle.db.transaction(fn);
const audits = async (action: string, targetId: string) =>
  ctx.handle.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.targetId, targetId)));

describe('sources', () => {
  it('a new source is disabled; upsert never enables and is idempotent', async () => {
    const input = {
      id: 'src-new',
      name: 'New',
      adapter: 'generic-html' as const,
      upstream: 'up',
      config: { a: 1 },
    };
    const first = await tx((t) => upsertSource(t, input, STAFF));
    expect(first).toMatchObject({
      enabled: false,
      adapter: 'generic-html',
      updatedBy: STAFF.adminId,
    });
    expect(await audits('scrape.source.upserted', 'src-new')).toHaveLength(1);

    await tx((t) => setSourceEnabled(t, 'src-new', true, STAFF));
    const again = await tx((t) => upsertSource(t, input, SYSTEM));
    expect(again.enabled).toBe(true);
    expect(await audits('scrape.source.upserted', 'src-new')).toHaveLength(1); // no-op: nothing audited

    const renamed = await tx((t) => upsertSource(t, { ...input, name: 'Renamed' }, SYSTEM));
    expect(renamed).toMatchObject({ name: 'Renamed', enabled: true, updatedBy: SYSTEM.system });
    expect(await audits('scrape.source.upserted', 'src-new')).toHaveLength(2);
  });

  it('rejects an unknown adapter, a bad id and an empty upstream', async () => {
    const base = { name: 'x', adapter: 'generic-json' as const, upstream: 'u', config: {} };
    await expect(
      tx((t) => upsertSource(t, { ...base, id: 'bad-adapter', adapter: 'nope' as never }, SYSTEM)),
    ).rejects.toMatchObject({ code: 'scrape_bad_adapter' });
    expect(
      pgCode(
        await tx((t) => upsertSource(t, { ...base, id: 'Bad Id' }, SYSTEM)).catch(
          (e: unknown) => e,
        ),
      ),
    ).toBe('23514');
    expect(
      pgCode(
        await tx((t) => upsertSource(t, { ...base, id: 'ok-id', upstream: ' ' }, SYSTEM)).catch(
          (e: unknown) => e,
        ),
      ),
    ).toBe('23514');
  });

  it('setSourceEnabled flips, audits once per change and 404s on a missing source', async () => {
    const on = await tx((t) => setSourceEnabled(t, 'adm-a', true, STAFF));
    expect(on.enabled).toBe(true);
    await tx((t) => setSourceEnabled(t, 'adm-a', true, STAFF)); // no change
    expect(await audits('scrape.source.enabled', 'adm-a')).toHaveLength(1);
    const off = await tx((t) => setSourceEnabled(t, 'adm-a', false, STAFF));
    expect(off.enabled).toBe(false);
    const [entry] = await audits('scrape.source.disabled', 'adm-a');
    expect(entry).toMatchObject({ actorType: 'admin', actorId: STAFF.adminId, ip: STAFF.ip });
    await expect(tx((t) => setSourceEnabled(t, 'nope', true, STAFF))).rejects.toMatchObject({
      status: 404,
    });
    expect((await getSource(ctx.handle.db, 'adm-a'))?.enabled).toBe(false);
    expect(await getSource(ctx.handle.db, 'nope')).toBeNull();
    expect((await listSources(ctx.handle.db)).map((s) => s.id)).toEqual(
      expect.arrayContaining(['adm-a', 'adm-b', 'src-new']),
    );
  });
});

describe('competition policy', () => {
  it('defaults to everything off, patches only given flags and audits before/after', async () => {
    const db = ctx.handle.db;
    expect(await getCompetitionPolicy(db, ctx.competitionId)).toEqual({
      competitionId: ctx.competitionId,
      enabled: false,
      autoOpen: false,
      autoResults: false,
      extraTime: false,
      pricingSource: 'model',
    });
    const on = await tx((t) =>
      setCompetitionPolicy(t, ctx.competitionId, { enabled: true }, STAFF),
    );
    expect(on).toMatchObject({ enabled: true, autoOpen: false });
    const more = await tx((t) =>
      setCompetitionPolicy(t, ctx.competitionId, { autoResults: true }, STAFF),
    );
    expect(more).toMatchObject({ enabled: true, autoResults: true, autoOpen: false });
    await tx((t) => setCompetitionPolicy(t, ctx.competitionId, { autoResults: true }, STAFF));
    const logged = await audits('scrape.policy.updated', ctx.competitionId);
    expect(logged).toHaveLength(2);
    expect(logged[1]?.metadata).toMatchObject({
      before: { enabled: true, autoResults: false },
      after: { enabled: true, autoResults: true },
    });
    expect(await getCompetitionPolicy(db, ctx.competitionId)).toMatchObject({ autoResults: true });
  });

  it('pricing source: model by default, switched and switched back, audited, nothing else changes', async () => {
    const db = ctx.handle.db;
    const other = [...ctx.ids.competitions.values()].find((id) => id !== ctx.competitionId)!;
    expect(await getCompetitionPolicy(db, other)).toMatchObject({ pricingSource: 'model' });
    const market = await tx((t) =>
      setCompetitionPolicy(t, other, { pricingSource: 'market' }, STAFF),
    );
    expect(market).toMatchObject({ pricingSource: 'market', enabled: false });
    expect(await getCompetitionPolicy(db, other)).toMatchObject({ pricingSource: 'market' });
    expect(
      (await listCompetitionPolicies(db, { sportId: 'football' })).find(
        (r) => r.competitionId === other,
      ),
    ).toMatchObject({ pricingSource: 'market', configured: true });
    // Another flag keeps it; no change writes nothing.
    await tx((t) => setCompetitionPolicy(t, other, { autoOpen: true }, STAFF));
    await tx((t) => setCompetitionPolicy(t, other, { pricingSource: 'market' }, STAFF));
    expect(await getCompetitionPolicy(db, other)).toMatchObject({
      pricingSource: 'market',
      autoOpen: true,
    });
    await tx((t) => setCompetitionPolicy(t, other, { pricingSource: 'model' }, STAFF));
    expect(await getCompetitionPolicy(db, other)).toMatchObject({ pricingSource: 'model' });
    const logged = (await audits('scrape.policy.updated', other)).filter(
      (a) =>
        (a.metadata as { before: { pricingSource: string } }).before.pricingSource !== undefined,
    );
    expect(
      logged.map((a) => (a.metadata as { after: { pricingSource: string } }).after.pricingSource),
    ).toEqual(['market', 'market', 'model']);
    // The database refuses any other value.
    await expect(
      ctx.handle.pool.query(
        `UPDATE scrape_competition_policy SET pricing_source = 'crowd' WHERE competition_id = $1`,
        [other],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('lists every competition with slug and name; unconfigured ones are off', async () => {
    const rows = await listCompetitionPolicies(ctx.handle.db, { sportId: 'football' });
    const pl = rows.find((r) => r.competitionId === ctx.competitionId);
    expect(pl).toMatchObject({ slug: 'premier-league', configured: true, enabled: true });
    expect(pl?.name.en).toBeTruthy();
    const other = rows.find((r) => r.competitionId !== ctx.competitionId);
    expect(other).toMatchObject({
      configured: false,
      enabled: false,
      autoOpen: false,
      pricingSource: 'model',
    });
  });

  it('refuses an unknown competition and concurrent patches keep each other flags', async () => {
    await expect(
      tx((t) =>
        setCompetitionPolicy(t, '00000000-0000-4000-8000-000000000000', { enabled: true }, STAFF),
      ),
    ).rejects.toMatchObject({ status: 404 });
    const other = [...ctx.ids.competitions.values()].find((id) => id !== ctx.competitionId)!;
    await Promise.all([
      tx((t) => setCompetitionPolicy(t, other, { enabled: true }, STAFF)),
      tx((t) => setCompetitionPolicy(t, other, { autoOpen: true }, STAFF)),
      tx((t) => setCompetitionPolicy(t, other, { extraTime: true }, STAFF)),
    ]);
    expect(await getCompetitionPolicy(ctx.handle.db, other)).toMatchObject({
      enabled: true,
      autoOpen: true,
      extraTime: true,
      autoResults: false,
    });
  });
});

describe('aliases', () => {
  const arsenal = () => ctx.team('Arsenal');
  const chelsea = () => ctx.team('Chelsea');

  it('is idempotent for the same mapping and conflicts for another team', async () => {
    const input = { sportId: 'football', aliasNorm: 'gunners', sourceId: null, teamId: arsenal() };
    const first = await tx((t) => addTeamAlias(t, input, STAFF));
    expect(first.created).toBe(true);
    const again = await tx((t) => addTeamAlias(t, input, STAFF));
    expect(again).toMatchObject({ created: false, alias: { id: first.alias.id } });
    expect(await audits('scrape.alias.added', first.alias.id)).toHaveLength(1);
    const clash = await tx((t) => addTeamAlias(t, { ...input, teamId: chelsea() }, STAFF)).catch(
      (e: unknown) => e,
    );
    expect(clash).toBeInstanceOf(ScrapeAliasConflictError);
    expect(clash).toMatchObject({
      status: 409,
      code: 'scrape_alias_conflict',
      existingTargetId: arsenal(),
    });
  });

  it('treats a null source and a named source as different scopes, but one null scope as unique', async () => {
    await tx((t) =>
      addTeamAlias(
        t,
        { sportId: 'football', aliasNorm: 'blues', sourceId: null, teamId: chelsea() },
        STAFF,
      ),
    );
    const scoped = await tx((t) =>
      addTeamAlias(
        t,
        { sportId: 'football', aliasNorm: 'blues', sourceId: 'adm-a', teamId: arsenal() },
        STAFF,
      ),
    );
    expect(scoped.created).toBe(true);
    // The unique expression index itself: a second NULL-source row cannot be inserted around the service.
    const error = await ctx.handle.db
      .insert(teamAliases)
      .values({ sportId: 'football', aliasNorm: 'blues', sourceId: null, teamId: arsenal() })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(pgCode(error)).toBe('23505');
    expect(errorText(error)).toMatch(/team_aliases_uq|duplicate/);
  });

  it('validates the alias text, the sport and the target', async () => {
    await expect(
      tx((t) =>
        addTeamAlias(
          t,
          { sportId: 'football', aliasNorm: ' x', sourceId: null, teamId: arsenal() },
          STAFF,
        ),
      ),
    ).rejects.toMatchObject({ code: 'scrape_bad_alias' });
    await expect(
      tx((t) =>
        addTeamAlias(
          t,
          { sportId: 'football', aliasNorm: '', sourceId: null, teamId: arsenal() },
          STAFF,
        ),
      ),
    ).rejects.toMatchObject({ code: 'scrape_bad_alias' });
    await expect(
      tx((t) =>
        addTeamAlias(
          t,
          { sportId: 'basketball', aliasNorm: 'x', sourceId: null, teamId: arsenal() },
          STAFF,
        ),
      ),
    ).rejects.toMatchObject({ code: 'scrape_alias_sport' });
    await expect(
      tx((t) =>
        addTeamAlias(
          t,
          {
            sportId: 'football',
            aliasNorm: 'x',
            sourceId: null,
            teamId: '00000000-0000-4000-8000-000000000000',
          },
          STAFF,
        ),
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      pgCode(
        await tx((t) =>
          addTeamAlias(
            t,
            { sportId: 'football', aliasNorm: 'x', sourceId: 'no-such-source', teamId: arsenal() },
            STAFF,
          ),
        ).catch((e: unknown) => e),
      ),
    ).toBe('23503');
  });

  it('competition aliases behave the same and removal is audited', async () => {
    const input = {
      sportId: 'football',
      aliasNorm: 'epl',
      sourceId: null,
      competitionId: ctx.competitionId,
    };
    const first = await tx((t) => addCompetitionAlias(t, input, STAFF));
    expect((await tx((t) => addCompetitionAlias(t, input, STAFF))).created).toBe(false);
    const other = [...ctx.ids.competitions.values()].find((id) => id !== ctx.competitionId)!;
    await expect(
      tx((t) => addCompetitionAlias(t, { ...input, competitionId: other }, STAFF)),
    ).rejects.toBeInstanceOf(ScrapeAliasConflictError);
    const removed = await tx((t) => removeAlias(t, 'competition', first.alias.id, STAFF));
    expect(removed).toMatchObject({ aliasNorm: 'epl', kind: 'competition' });
    expect(await audits('scrape.alias.removed', first.alias.id)).toHaveLength(1);
    await expect(
      tx((t) => removeAlias(t, 'competition', first.alias.id, STAFF)),
    ).rejects.toMatchObject({ status: 404 });
    // After removal the name can point elsewhere.
    expect(
      (await tx((t) => addCompetitionAlias(t, { ...input, competitionId: other }, STAFF))).created,
    ).toBe(true);
  });

  it('loadAliasInputs returns the arrays the alias index expects; listAliases shows labels', async () => {
    const inputs = await loadAliasInputs(ctx.handle.db, 'football');
    const team = inputs.teams.find((x) => x.id === arsenal());
    expect(team).toMatchObject({ sportId: 'football', shortName: expect.any(String) });
    expect(team?.names).toContain('Arsenal');
    expect(new Set(team?.names).size).toBe(team?.names.length);
    expect(inputs.teamAliases).toEqual(
      expect.arrayContaining([{ aliasNorm: 'gunners', sourceId: null, teamId: arsenal() }]),
    );
    expect(inputs.teamAliases).toEqual(
      expect.arrayContaining([{ aliasNorm: 'blues', sourceId: 'adm-a', teamId: arsenal() }]),
    );
    const comp = inputs.competitions.find((c) => c.id === ctx.competitionId);
    expect(comp).toMatchObject({ slug: 'premier-league', sportId: 'football' });
    expect(comp?.names.length).toBeGreaterThan(0);
    expect(inputs.competitionAliases).toEqual(
      expect.arrayContaining([expect.objectContaining({ aliasNorm: 'epl' })]),
    );
    expect((await loadAliasInputs(ctx.handle.db, 'tennis')).teamAliases).toEqual([]);

    const listed = await listAliases(ctx.handle.db, { kind: 'team', sportId: 'football' });
    expect(listed.length).toBeGreaterThanOrEqual(3);
    expect(listed.every((a) => a.kind === 'team' && a.targetLabel !== '')).toBe(true);
    const bySource = await listAliases(ctx.handle.db, { sourceId: 'adm-a' });
    expect(bySource.map((a) => a.aliasNorm)).toEqual(['blues']);
  });
});

describe('review items', () => {
  const open = (
    subjectKey: string,
    extra: Record<string, unknown> = {},
    kind: 'unknown_team' | 'result_ready' = 'unknown_team',
  ) =>
    tx((t) =>
      openReviewItem(t, {
        kind,
        subjectKey,
        severity: 'warning',
        title: `T ${subjectKey}`,
        payload: { n: 1, ...extra },
      }),
    );

  it('is idempotent while open and refreshes the payload', async () => {
    const a = await open('rv-1');
    expect(a.created).toBe(true);
    const b = await open('rv-1', { n: 2 });
    expect(b.created).toBe(false);
    expect(b.item.id).toBe(a.item.id);
    expect(b.item.payload).toEqual({ n: 2 });
    expect(b.item.createdAt).toEqual(a.item.createdAt);
    expect(b.item.updatedAt.getTime()).toBeGreaterThanOrEqual(a.item.updatedAt.getTime());
    const rows = await ctx.handle.db
      .select()
      .from(scrapeReviewItems)
      .where(eq(scrapeReviewItems.subjectKey, 'rv-1'));
    expect(rows).toHaveLength(1);
  });

  it('a second open item for the same (kind, subject) is impossible; another kind is fine', async () => {
    await open('rv-2');
    const dup = await ctx.handle.db
      .insert(scrapeReviewItems)
      .values({
        kind: 'unknown_team',
        subjectKey: 'rv-2',
        severity: 'info',
        title: 'dup',
        payload: {},
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(pgCode(dup)).toBe('23505');
    expect((await open('rv-2', {}, 'result_ready')).created).toBe(true);
  });

  it('concurrent opens converge on one item', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => open('rv-race')));
    expect(new Set(results.map((r) => r.item.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
  });

  it('resolves only an open item, audits it, and a new item opens afterwards', async () => {
    const a = await open('rv-3');
    const done = await tx((t) =>
      resolveReviewItem(t, a.item.id, {
        status: 'resolved',
        resolution: 'mapped alias',
        actor: STAFF,
      }),
    );
    expect(done).toMatchObject({
      status: 'resolved',
      resolution: 'mapped alias',
      resolvedBy: STAFF.adminId,
    });
    expect(done.resolvedAt).toBeInstanceOf(Date);
    expect(await audits('scrape.review.resolved', a.item.id)).toHaveLength(1);
    const again = await tx((t) =>
      resolveReviewItem(t, a.item.id, { status: 'dismissed', resolution: 'x', actor: STAFF }),
    ).catch((e: unknown) => e);
    expect(again).toBeInstanceOf(ScrapeReviewStateError);
    expect((again as ScrapeReviewStateError).status).toBe(409);
    expect((await getReviewItem(ctx.handle.db, a.item.id))?.status).toBe('resolved');
    await expect(
      tx((t) =>
        resolveReviewItem(t, '00000000-0000-4000-8000-000000000000', {
          status: 'resolved',
          resolution: 'x',
          actor: STAFF,
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
    const next = await open('rv-3', { n: 9 });
    expect(next.created).toBe(true);
    expect(next.item.id).not.toBe(a.item.id);
  });

  it('two people resolving at once: one wins', async () => {
    const a = await open('rv-4');
    const results = await Promise.allSettled([
      tx((t) =>
        resolveReviewItem(t, a.item.id, { status: 'resolved', resolution: 'a', actor: STAFF }),
      ),
      tx((t) =>
        resolveReviewItem(t, a.item.id, { status: 'dismissed', resolution: 'b', actor: SYSTEM }),
      ),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      await audits(
        `scrape.review.${(await getReviewItem(ctx.handle.db, a.item.id))!.status}`,
        a.item.id,
      ),
    ).toHaveLength(1);
  });

  it('closeReviewItemsBySubject closes the open ones by the system, only those', async () => {
    const a = await open('rv-5');
    const b = await open('rv-5', {}, 'result_ready');
    const old = await open('rv-5-old');
    await tx((t) =>
      resolveReviewItem(t, old.item.id, { status: 'dismissed', resolution: 'x', actor: STAFF }),
    );
    const closed = await tx((t) =>
      closeReviewItemsBySubject(t, 'rv-5', { kinds: ['unknown_team'] }),
    );
    expect(closed.map((i) => i.id)).toEqual([a.item.id]);
    expect(closed[0]).toMatchObject({ status: 'resolved', resolvedBy: 'system:scraper' });
    expect((await getReviewItem(ctx.handle.db, b.item.id))?.status).toBe('open');
    const rest = await tx((t) => closeReviewItemsBySubject(t, 'rv-5'));
    expect(rest.map((i) => i.id)).toEqual([b.item.id]);
    expect(await tx((t) => closeReviewItemsBySubject(t, 'rv-5'))).toEqual([]);
    expect(await tx((t) => closeReviewItemsBySubject(t, 'rv-5-old'))).toEqual([]);
  });

  it('lists by status and kind and pages by (created_at, id)', async () => {
    const base = new Date('2030-01-01T00:00:00Z');
    for (let i = 0; i < 5; i += 1) {
      await tx((t) =>
        openReviewItem(t, {
          kind: 'kickoff_change',
          subjectKey: `page-${i}`,
          severity: 'info',
          title: `p${i}`,
          payload: {},
          // three items share a created_at: the id breaks the tie
          now: new Date(base.getTime() + Math.floor(i / 3) * 1000),
        }),
      );
    }
    const seen: string[] = [];
    let after: { createdAt: Date; id: string } | undefined;
    for (;;) {
      const page = await listReviewItems(ctx.handle.db, {
        status: 'open',
        kind: 'kickoff_change',
        limit: 2,
        ...(after === undefined ? {} : { after }),
      });
      if (page.length === 0) break;
      seen.push(...page.map((i) => i.subjectKey));
      const last = page.at(-1)!;
      after = { createdAt: last.createdAt, id: last.id };
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(seen.slice(0, 2).sort()).toEqual(['page-3', 'page-4']); // newest second first
    const counts = await countReviewItemsByKind(ctx.handle.db);
    expect(counts.kickoff_change).toBe(5);
    expect(counts.source_broken).toBe(0);
    // Every kind is present, whatever their number (a new kind is added in one place).
    expect(Object.keys(counts).sort()).toEqual([...SCRAPE_REVIEW_KINDS].sort());
    expect(
      (await listReviewItems(ctx.handle.db, { status: 'dismissed' })).every(
        (i) => i.status === 'dismissed',
      ),
    ).toBe(true);
  });

  it('the database rejects unknown kinds, severities and statuses', async () => {
    for (const values of [
      { kind: 'bogus', severity: 'info', status: 'open' },
      { kind: 'unknown_team', severity: 'fatal', status: 'open' },
      { kind: 'unknown_team', severity: 'info', status: 'closed' },
      { kind: 'unknown_team', severity: 'info', status: 'resolved' }, // resolved without resolved_at
    ]) {
      const error = await ctx.handle.db
        .insert(scrapeReviewItems)
        .values({ ...values, subjectKey: `bad-${Math.random()}`, title: 't', payload: {} })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(pgCode(error), JSON.stringify(values)).toBe('23514');
    }
  });
});

describe('ratings', () => {
  it('markRatingApplied is true only the first time, also under concurrency', async () => {
    expect(await tx((t) => markRatingApplied(t, 'fx|a|b|c|2026-11-08'))).toBe(true);
    expect(await tx((t) => markRatingApplied(t, 'fx|a|b|c|2026-11-08'))).toBe(false);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => tx((t) => markRatingApplied(t, 'fx|race'))),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('a rolled-back transaction does not consume the mark', async () => {
    await tx(async (t) => {
      await markRatingApplied(t, 'fx|rollback');
      t.rollback();
    }).catch(() => undefined);
    expect(await tx((t) => markRatingApplied(t, 'fx|rollback'))).toBe(true);
  });

  it('reads and sets team ratings (audited), exposing matches and manual', async () => {
    const db = ctx.handle.db;
    const id = ctx.team('Arsenal');
    await db.update(teams).set({ ratings: null }).where(eq(teams.id, id));
    expect((await getTeamRatings(db, [id])).get(id)).toEqual({
      ratings: null,
      matches: 0,
      manual: false,
    });
    const set = await tx((t) =>
      setTeamRatings(t, id, { attack: 1.4, defence: 0.9, matches: 12, manual: 1 }, STAFF),
    );
    expect(set).toMatchObject({ matches: 12, manual: true });
    expect((await getTeamRatings(db, [id, id, ctx.team('Chelsea')])).get(id)).toMatchObject({
      matches: 12,
      manual: true,
      ratings: { attack: 1.4, defence: 0.9 },
    });
    const [entry] = await audits('scrape.ratings.updated', id);
    expect(entry?.metadata).toMatchObject({ before: null, after: { matches: 12 } });
    expect(await tx((t) => getTeamRatings(t, [id], { forUpdate: true }))).toHaveProperty('size', 1);
    expect((await getTeamRatings(db, [])).size).toBe(0);
    await expect(
      tx((t) => setTeamRatings(t, id, { attack: Number.NaN }, STAFF)),
    ).rejects.toMatchObject({
      code: 'scrape_bad_ratings',
    });
    await expect(
      tx((t) => setTeamRatings(t, '00000000-0000-4000-8000-000000000000', { attack: 1 }, STAFF)),
    ).rejects.toMatchObject({ status: 404 });
  });
});
