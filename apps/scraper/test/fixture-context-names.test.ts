import { upsertSource, setSourceEnabled } from '@vamos/db';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ARSENAL_CHELSEA_OF,
  createHarness,
  jsonDoc,
  ofDoc,
  SETUP_TIMEOUT,
  TEST_TIMEOUT,
  URL_A,
  URL_B,
  type Harness,
  type JsonEvent,
} from './helpers';

/**
 * Rule N4 (U-4 of docs/feed-quality-plan.md): an unknown team name seen against a resolved
 * opponent gets fixture-context suggestions from the catalogue (here src-a's resolved
 * observation of the same match). SCRAPER_AUTO_ALIAS=on applies a strong one as a src-b-only
 * alias, audited, and only where two full-time upstreams protect the competition's results (R2).
 */

const SUBJECT = 'football|arsenal london';
const actor = { system: 'test' };

let h: Harness;
afterEach(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

interface ItemRow {
  status: string;
  payload: {
    rules: string[];
    suggestions: Array<{ id: string; name: string; score: number; basis?: string }>;
    fixture?: {
      opponent: string;
      opponentId: string;
      kickoff: string;
      side: string;
      strong: string | null;
      candidates: Array<{ id: string; score: number }>;
    };
  };
}

async function item(): Promise<ItemRow | undefined> {
  const { rows } = await h.pool.query<ItemRow>(
    `SELECT status, payload FROM scrape_review_items
      WHERE kind = 'unknown_team' AND subject_key = $1 ORDER BY created_at DESC LIMIT 1`,
    [SUBJECT],
  );
  return rows[0];
}

/** src-a reads the catalogue's side (Arsenal FC vs Chelsea FC, and optionally a second match). */
async function catalogue(extra: Array<typeof ARSENAL_CHELSEA_OF> = []): Promise<void> {
  h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF, ...extra]));
  await h.run('src-a');
}

/** src-b shows the match with a home name nobody knows yet (and optionally more matches). */
async function unknownHome(extra: JsonEvent[] = []): Promise<void> {
  h.serve(
    URL_B,
    jsonDoc([
      { id: 1, kick: '2026-11-02T15:00:00Z', h: 'Arsenal London', a: 'Chelsea', st: 'NS' },
      ...extra,
    ]),
  );
  await h.run('src-b');
}

/** A second match of Arsenal, on both sides (L3: N4 maps by itself after two agreeing fixtures). */
const ARSENAL_LIVERPOOL_OF = {
  date: '2026-11-08',
  time: '16:30',
  team1: 'Arsenal FC',
  team2: 'Liverpool FC',
};
const ARSENAL_LONDON_LIVERPOOL: JsonEvent = {
  id: 2,
  kick: '2026-11-08T16:30:00Z',
  h: 'Arsenal London',
  a: 'Liverpool',
  st: 'NS',
};

/** A second full-time upstream for the Premier League (src-b takes its competition per record). */
async function secondUpstream(): Promise<void> {
  await h.ctx.db.transaction(async (tx) => {
    await upsertSource(
      tx,
      {
        id: 'src-c',
        name: 'second openfootball mirror',
        adapter: 'openfootball',
        upstream: 'football-data',
        config: {
          allowedHosts: ['raw.githubusercontent.com'],
          requests: [{ url: `${URL_A}?mirror`, competition: 'Premier League' }],
          timeZone: 'Europe/London',
          sport: 'football',
        },
      },
      actor,
    );
    await setSourceEnabled(tx, 'src-c', true, actor);
  });
}

const aliasCount = () =>
  h.count(`SELECT count(*) AS n FROM team_aliases WHERE alias_norm = 'arsenal london'`);
const autoAudits = () =>
  h.count(`SELECT count(*) AS n FROM audit_log WHERE action = 'scrape.alias.auto'`);

describe('N4: fixture-context suggestions for unknown team names', () => {
  it(
    'a unique fixture against the resolved opponent attaches a strong suggestion and the context',
    async () => {
      h = await createHarness();
      await catalogue();
      await unknownHome();
      const found = await item();
      expect(found?.status).toBe('open');
      expect(found?.payload.rules).toEqual(['N2', 'N3', 'N4']);
      expect(found?.payload.suggestions).toEqual([
        expect.objectContaining({ id: h.team('Arsenal'), score: 0.6, basis: 'fixture' }),
      ]);
      expect(found?.payload.fixture).toMatchObject({
        opponent: 'Chelsea',
        opponentId: h.team('Chelsea'),
        kickoff: '2026-11-02T15:00:00.000Z',
        side: 'home',
        strong: h.team('Arsenal'),
        candidates: [{ id: h.team('Arsenal'), score: 0.6 }],
      });
      // Setting off (the default): suggestions only.
      expect(await aliasCount()).toBe(0);
      expect(await autoAudits()).toBe(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'two candidate teams (Chelsea plays twice within the window) are not strong',
    async () => {
      h = await createHarness({ autoAlias: true });
      await secondUpstream();
      await catalogue([
        { date: '2026-11-03', time: '14:00', team1: 'Tottenham Hotspur', team2: 'Chelsea FC' },
      ]);
      await unknownHome();
      const found = await item();
      expect(found?.payload.fixture?.strong).toBeNull();
      expect(found?.payload.fixture?.candidates.map((c) => c.id).sort()).toEqual(
        [h.team('Arsenal'), h.team('Tottenham')].sort(),
      );
      expect(found?.payload.suggestions.some((s) => s.basis === 'fixture')).toBe(false);
      // Even with the setting on and two upstreams: nothing is applied.
      expect(await aliasCount()).toBe(0);
      expect(found?.status).toBe('open');
    },
    TEST_TIMEOUT,
  );

  it(
    'setting on, two full-time upstreams and two agreeing fixtures: a src-b alias, audited, and the rows re-resolve',
    async () => {
      h = await createHarness({ autoAlias: true });
      await secondUpstream();
      await catalogue([ARSENAL_LIVERPOOL_OF]);
      await unknownHome([ARSENAL_LONDON_LIVERPOOL]);

      const { rows: aliases } = await h.pool.query<{
        id: string;
        source_id: string | null;
        team_id: string;
        created_by: string;
      }>(
        `SELECT id, source_id, team_id, created_by FROM team_aliases WHERE alias_norm = 'arsenal london'`,
      );
      // Source-scoped, never global.
      expect(aliases).toEqual([
        expect.objectContaining({
          source_id: 'src-b',
          team_id: h.team('Arsenal'),
          created_by: 'system:scraper',
        }),
      ]);

      const { rows: audits } = await h.pool.query<{
        actor_type: string;
        target_id: string;
        metadata: Record<string, unknown>;
      }>(
        `SELECT actor_type, target_id, metadata FROM audit_log WHERE action = 'scrape.alias.auto'`,
      );
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        actor_type: 'system',
        target_id: aliases[0]!.id,
        metadata: {
          rule: 'N4',
          sourceId: 'src-b',
          teamId: h.team('Arsenal'),
          raw: 'Arsenal London',
          similarity: 0.6,
          fullTimeUpstreams: 2,
          sightings: [
            {
              side: 'home',
              kickoff: '2026-11-02T15:00:00.000Z',
              opponentId: h.team('Chelsea'),
              competitionId: h.premier,
            },
            {
              side: 'home',
              kickoff: '2026-11-08T16:30:00.000Z',
              opponentId: h.team('Liverpool'),
              competitionId: h.premier,
            },
          ],
        },
      });
      // The usual alias audit is written too.
      expect(
        await h.count(
          `SELECT count(*) AS n FROM audit_log WHERE action = 'scrape.alias.added' AND target_id = $1`,
          [aliases[0]!.id],
        ),
      ).toBe(1);

      // The rows of src-b re-resolved and the item was closed by the system.
      expect(
        await h.count(
          `SELECT count(*) AS n FROM scrape_observations
            WHERE source_id = 'src-b' AND home_raw = 'Arsenal London' AND home_team_id = $1`,
          [h.team('Arsenal')],
        ),
      ).toBeGreaterThan(0);
      expect(
        await h.count(
          `SELECT count(*) AS n FROM scrape_observations
            WHERE source_id = 'src-b' AND home_team_id IS NULL`,
        ),
      ).toBe(0);
      const { rows: items } = await h.pool.query<{ status: string; resolved_by: string }>(
        `SELECT status, resolved_by FROM scrape_review_items WHERE subject_key = $1`,
        [SUBJECT],
      );
      expect(items).toEqual([{ status: 'resolved', resolved_by: 'system:scraper' }]);

      // A second run resolves the name directly: no new item, no second alias.
      await unknownHome([ARSENAL_LONDON_LIVERPOOL]);
      expect(
        await h.count(`SELECT count(*) AS n FROM scrape_review_items WHERE subject_key = $1`, [
          SUBJECT,
        ]),
      ).toBe(1);
      expect(await aliasCount()).toBe(1);
      expect(await autoAudits()).toBe(1);
    },
    TEST_TIMEOUT,
  );

  it(
    'setting on and two upstreams, but one agreeing fixture only (L3 needs two): suggest only',
    async () => {
      h = await createHarness({ autoAlias: true });
      await secondUpstream();
      await catalogue();
      await unknownHome();
      const found = await item();
      expect(found?.payload.fixture?.strong).toBe(h.team('Arsenal'));
      expect(found?.status).toBe('open');
      expect(await aliasCount()).toBe(0);
      expect(await autoAudits()).toBe(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'setting on but one full-time upstream (R2 cannot protect results): suggest only',
    async () => {
      h = await createHarness({ autoAlias: true });
      await catalogue();
      await unknownHome();
      const found = await item();
      expect(found?.payload.fixture?.strong).toBe(h.team('Arsenal'));
      expect(found?.status).toBe('open');
      expect(await aliasCount()).toBe(0);
      expect(await autoAudits()).toBe(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'setting on and two upstreams, but a person removed that alias before: not re-added',
    async () => {
      h = await createHarness({ autoAlias: true });
      await secondUpstream();
      await h.pool.query(
        `INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata)
         VALUES ('admin', 'someone', 'scrape.alias.removed', 'team_alias', 'x',
                 '{"aliasNorm": "arsenal london", "sourceId": "src-b"}')`,
      );
      await catalogue();
      await unknownHome();
      expect((await item())?.payload.fixture?.strong).toBe(h.team('Arsenal'));
      expect(await aliasCount()).toBe(0);
    },
    TEST_TIMEOUT,
  );
});
