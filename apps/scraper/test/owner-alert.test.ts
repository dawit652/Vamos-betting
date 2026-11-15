import { OWNER_ALERT_MAX_LENGTH } from '@vamos/core';
import {
  creditProjection,
  MIN_MATCH_DURATION_MS,
  SOURCE_STALE_AFTER_MS,
  type CreditStatus,
} from '@vamos/scraper';
import type { Logger } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  raiseUnauthorized,
  raiseUnexpectedCost,
  syncBudgetAlarm,
  syncMarketStaleAlarm,
  syncProjectionAlarm,
  type AlarmRef,
} from '../src/pipeline/credit-alarms';
import { promoteFixtures } from '../src/pipeline/promote-fixtures';
import { promoteResults } from '../src/pipeline/promote-results';
import { flagStaleSources } from '../src/pipeline/stale-sources';
import {
  ARSENAL_CHELSEA_JSON,
  ARSENAL_CHELSEA_OF,
  createHarness,
  finishedOf,
  HOUR,
  jsonDoc,
  KICKOFF,
  MINUTE,
  ofDoc,
  SETUP_TIMEOUT,
  TEST_TIMEOUT,
  URL_A,
  URL_B,
  type Harness,
} from './helpers';

/**
 * Plan task 1.11: the scraper's alarms that tell the owner. Each writes an `owner.alert` outbox row
 * (in the transaction that opens the alarm, or its own where the alarm was a log line) when
 * OWNER_ALERT_PHONES is set, once per episode, and nothing at all when it is not. The alarm's own
 * doing (the review item, the run, the result pass) is the same either way.
 */

const OWNER = '+251911000001';

let h: Harness;
afterEach(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

interface AlertRow {
  key: string;
  message: string;
  raisedAt: string;
  aggregateType: string;
}
const alerts = async (): Promise<AlertRow[]> =>
  (
    await h.pool.query<{ aggregate_type: string; payload: Record<string, string> }>(
      `SELECT aggregate_type, payload FROM outbox_events WHERE type = 'owner.alert' ORDER BY id`,
    )
  ).rows.map((row) => ({
    key: row.payload.key!,
    message: row.payload.message!,
    raisedAt: row.payload.raisedAt!,
    aggregateType: row.aggregate_type,
  }));
const openItems = (kind: string) =>
  h.count(`SELECT count(*) AS n FROM scrape_review_items WHERE kind = $1 AND status = 'open'`, [
    kind,
  ]);

/** The tail of every alert: one line, short, no digits of a phone or an id. */
function expectPlain(rows: readonly AlertRow[]): void {
  for (const row of rows) {
    expect(row.message.length, row.message).toBeLessThanOrEqual(OWNER_ALERT_MAX_LENGTH);
    expect(row.message, row.message).not.toMatch(/[\n\r]/);
    expect(row.message, row.message).not.toMatch(/\+?\d{7,}/);
    expect(row.aggregateType).toBe('owner_alert');
  }
}

const ref = (overrides: Partial<AlarmRef> = {}): AlarmRef => ({
  creditKey: 'theoddsapi',
  sourceId: 'odds-api',
  runId: 'run-1',
  now: new Date('2026-11-13T10:00:00Z'),
  alerts: { phones: [OWNER] },
  ...overrides,
});

const statusOf = (overrides: Partial<CreditStatus>): CreditStatus => ({
  mode: 'normal',
  keyRefused: false,
  quota: 500,
  remaining: 400,
  spentLast24h: 5,
  lastReadAt: null,
  ...overrides,
});

describe('credit alarms', () => {
  it(
    'tell the owner once when the alarm opens, not each time it is refreshed',
    async () => {
      h = await createHarness({ ownerAlertPhones: OWNER });
      const tx = <T>(run: Parameters<typeof h.ctx.db.transaction<T>>[0]) =>
        h.ctx.db.transaction(run);
      const sync = (status: CreditStatus, r = ref()) => tx((t) => syncBudgetAlarm(t, r, status));

      // Economy: budget_low.
      await sync(statusOf({ mode: 'economy', remaining: 90 }));
      await sync(
        statusOf({ mode: 'economy', remaining: 80 }),
        ref({ now: new Date('2026-11-13T10:05:00Z') }),
      );
      expect((await alerts()).map((a) => a.key)).toEqual(['budget_low|theoddsapi']);
      expect((await alerts())[0]!.message).toBe(
        'Bookmaker odds credits are running low: odds are read less often to make them last.',
      );

      // The credits are gone: a worse alarm of the same key, told at once.
      await sync(statusOf({ mode: 'stop', remaining: 0 }));
      expect((await alerts()).map((a) => a.key)).toEqual([
        'budget_low|theoddsapi',
        'budget_exhausted|theoddsapi',
      ]);
      expect((await alerts())[1]!.message).toBe(
        'Bookmaker odds credits are used up: odds reads are stopped until the 1st.',
      );

      // Normal again closes the item; the next low is a new episode and a new alert.
      await sync(statusOf({ mode: 'normal' }));
      expect(await openItems('source_broken')).toBe(0);
      await sync(statusOf({ mode: 'economy', remaining: 70 }));
      expect((await alerts()).map((a) => a.key)).toEqual([
        'budget_low|theoddsapi',
        'budget_exhausted|theoddsapi',
        'budget_low|theoddsapi',
      ]);
      expectPlain(await alerts());
    },
    TEST_TIMEOUT,
  );

  it(
    'cover the projection, a refused key and an unexpected cost',
    async () => {
      h = await createHarness({ ownerAlertPhones: OWNER });
      const now = new Date('2026-11-13T10:00:00Z');
      const status = statusOf({ remaining: 100, spentLast24h: 50 });
      const projection = creditProjection(status, now);
      expect(projection.overruns).toBe(true);
      await h.ctx.db.transaction((t) => syncProjectionAlarm(t, ref(), status, projection));
      await h.ctx.db.transaction((t) => raiseUnauthorized(t, ref()));
      await h.ctx.db.transaction((t) => raiseUnexpectedCost(t, ref(), { cost: 30, expected: 10 }));
      // Refreshed: nothing more.
      await h.ctx.db.transaction((t) => raiseUnauthorized(t, ref()));
      await h.ctx.db.transaction((t) => raiseUnexpectedCost(t, ref(), { cost: 40, expected: 10 }));

      const rows = await alerts();
      expect(rows.map((a) => a.key)).toEqual([
        'budget_projection|theoddsapi',
        'unauthorized|theoddsapi',
        'unexpected_cost|theoddsapi',
      ]);
      expect(rows[0]!.message).toMatch(/would be used up in about 2 days, before the 1st/);
      expect(rows[1]!.message).toBe(
        'The bookmaker odds API refused our key: reads with that key are stopped.',
      );
      expect(rows[2]!.message).toBe(
        'A bookmaker odds request cost 30 credits instead of 10. Reading carries on.',
      );
      expectPlain(rows);
    },
    TEST_TIMEOUT,
  );

  it(
    'write nothing without an owner number, and the alarms are the same',
    async () => {
      h = await createHarness();
      expect(h.ctx.config.ownerAlerts.phones).toEqual([]);
      const off = ref({ alerts: h.ctx.config.ownerAlerts });
      await h.ctx.db.transaction(async (t) => {
        await syncBudgetAlarm(t, off, statusOf({ mode: 'stop', remaining: 0 }));
        await raiseUnauthorized(t, off);
        await raiseUnexpectedCost(t, off, { cost: 30, expected: 10 });
      });
      // A caller that passes no settings (an older call site) writes none either.
      await h.ctx.db.transaction((t) =>
        syncBudgetAlarm(
          t,
          ref({ alerts: undefined, creditKey: 'k2' }),
          statusOf({ mode: 'economy' }),
        ),
      );
      expect(await alerts()).toEqual([]);
      expect(await openItems('source_broken')).toBe(4);
    },
    TEST_TIMEOUT,
  );

  it(
    'leave the per-match alarms (market_stale) to the review queue',
    async () => {
      h = await createHarness({ ownerAlertPhones: OWNER });
      await h.ctx.db.transaction((t) =>
        syncMarketStaleAlarm(t, {
          eventId: '00000000-0000-4000-8000-000000000001',
          kickoff: KICKOFF,
          stale: true,
          now: h.now(),
        }),
      );
      expect(await openItems('source_broken')).toBe(1);
      expect(await alerts()).toEqual([]);
    },
    TEST_TIMEOUT,
  );
});

async function withEvent(): Promise<void> {
  h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
  h.serve(URL_B, jsonDoc([ARSENAL_CHELSEA_JSON]));
  await h.run('src-a');
  await h.run('src-b');
  expect((await promoteFixtures(h.ctx)).created).toBe(1);
}

describe('source_broken', () => {
  async function breakShape(): Promise<void> {
    h.advance(20 * MINUTE);
    h.serve(URL_A, ofDoc([]));
    expect((await h.run('src-a')).status).toBe('broken');
  }

  it(
    'tells the owner when a source stops parsing, once per episode',
    async () => {
      h = await createHarness({ ownerAlertPhones: OWNER });
      await withEvent();
      for (let i = 0; i < 3; i += 1) {
        h.advance(20 * MINUTE);
        expect((await h.run('src-a')).status).toBe('ok');
      }
      expect(await alerts()).toEqual([]);

      await breakShape();
      await breakShape();
      const first = await alerts();
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({
        key: 'source_broken|src-a',
        message:
          'openfootball test: its pages no longer read as before. Nothing from them is stored; the league runs on its other sources.',
      });
      expectPlain(first);
      expect(await openItems('source_broken')).toBe(1);

      // It parses again, then breaks again: a new episode, a new alert (the worker holds it back
      // if it comes inside the interval).
      h.advance(20 * MINUTE);
      h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
      expect((await h.run('src-a')).status).toBe('ok');
      await breakShape();
      expect((await alerts()).map((a) => a.key)).toEqual([
        'source_broken|src-a',
        'source_broken|src-a',
      ]);
    },
    TEST_TIMEOUT,
  );

  it(
    'tells the owner when a source configuration is invalid',
    async () => {
      h = await createHarness({ ownerAlertPhones: OWNER });
      await h.pool.query(
        `UPDATE scrape_sources SET config = '{"nonsense": true}' WHERE id = 'src-a'`,
      );
      expect((await h.run('src-a')).status).toBe('failed');
      expect((await h.run('src-a')).status).toBe('failed');
      const rows = await alerts();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        key: 'source_broken|src-a',
        message:
          'openfootball test: its configuration is invalid, so it is not read. The other sources carry on.',
      });
    },
    TEST_TIMEOUT,
  );

  it(
    'writes nothing by default, and the run is the same',
    async () => {
      h = await createHarness();
      await withEvent();
      for (let i = 0; i < 3; i += 1) {
        h.advance(20 * MINUTE);
        await h.run('src-a');
      }
      await breakShape();
      expect(await openItems('source_broken')).toBe(1);
      expect(await alerts()).toEqual([]);
    },
    TEST_TIMEOUT,
  );
});

describe('source_stale', () => {
  const MATCH_END = new Date(KICKOFF.getTime() + MIN_MATCH_DURATION_MS);
  const STALE_AT = new Date(MATCH_END.getTime() + SOURCE_STALE_AFTER_MS);

  it(
    'tells the owner once per silent source, when its item opens',
    async () => {
      h = await createHarness({ ownerAlertPhones: OWNER });
      await withEvent();
      const poll = async (at: Date) => {
        h.at(at);
        await h.run('src-a');
        await h.run('src-b');
      };
      await poll(new Date(STALE_AT.getTime() - MINUTE));
      expect(await flagStaleSources(h.ctx)).toEqual({ opened: 0, closed: 0 });
      expect(await alerts()).toEqual([]);

      await poll(STALE_AT);
      expect(await flagStaleSources(h.ctx)).toEqual({ opened: 2, closed: 0 });
      const rows = await alerts();
      expect(rows.map((a) => a.key)).toEqual(['source_stale|src-a', 'source_stale|src-b']);
      expect(rows[0]!.message).toMatch(
        /^openfootball test has shown nothing new for \d+ days\. It is marked stale; no result is settled from one source alone\.$/,
      );
      expectPlain(rows);

      // A later pass refreshes the items: the owner is not told again.
      await poll(new Date(STALE_AT.getTime() + HOUR));
      expect(await flagStaleSources(h.ctx)).toEqual({ opened: 0, closed: 0 });
      expect(await alerts()).toHaveLength(2);
    },
    TEST_TIMEOUT,
  );

  it(
    'writes nothing by default',
    async () => {
      h = await createHarness();
      await withEvent();
      h.at(STALE_AT);
      await h.run('src-a');
      await h.run('src-b');
      expect(await flagStaleSources(h.ctx)).toEqual({ opened: 2, closed: 0 });
      expect(await alerts()).toEqual([]);
    },
    TEST_TIMEOUT,
  );
});

describe('ladder_shadow_failed', () => {
  /** A held result (one source only) and a trust table that is gone, so the shadow fails. */
  async function failingShadow(options: { ownerAlertPhones?: string }): Promise<{
    logger: Record<'error' | 'warn' | 'info' | 'debug', ReturnType<typeof vi.fn>>;
    ctx: Harness['ctx'];
  }> {
    h = await createHarness(options);
    h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
    h.serve(URL_B, jsonDoc([ARSENAL_CHELSEA_JSON]));
    await h.run('src-a');
    await h.run('src-b');
    expect((await promoteFixtures(h.ctx)).created).toBe(1);
    h.at(new Date(KICKOFF.getTime() + 2 * HOUR));
    h.serve(URL_A, ofDoc([finishedOf([2, 1], [1, 0])]));
    await h.run('src-a');
    h.at(new Date(KICKOFF.getTime() + 9 * HOUR));
    await h.pool.query(`ALTER TABLE scrape_source_trust RENAME TO scrape_source_trust_gone`);
    const logger = { error: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn() };
    return { logger, ctx: { ...h.ctx, logger: logger as unknown as Logger } };
  }

  it(
    'tells the owner once per pass, and the pass goes on as before',
    async () => {
      const { logger, ctx } = await failingShadow({ ownerAlertPhones: OWNER });
      expect(await promoteResults(ctx)).toMatchObject({ applied: 0, held: 1, failed: 0 });
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ alarm: 'ladder_shadow_failed' }),
        expect.any(String),
      );
      const rows = await alerts();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        key: 'ladder_shadow_failed',
        message:
          'The result ladder shadow failed on this pass. Results and betting carry on as before; nothing was changed.',
      });
      expectPlain(rows);
      // The next pass fails again: one more row (the worker's window decides if it is texted).
      expect(await promoteResults(ctx)).toMatchObject({ applied: 0, held: 1, failed: 0 });
      expect(await alerts()).toHaveLength(2);
    },
    TEST_TIMEOUT,
  );

  it(
    'writes nothing by default, and logs the same alarm',
    async () => {
      const { logger, ctx } = await failingShadow({});
      expect(await promoteResults(ctx)).toMatchObject({ applied: 0, held: 1, failed: 0 });
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.warn).not.toHaveBeenCalled();
      expect(await alerts()).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  it(
    'does not break the pass when the alert cannot be queued',
    async () => {
      const { logger, ctx } = await failingShadow({ ownerAlertPhones: OWNER });
      await h.pool.query(`ALTER TABLE outbox_events RENAME TO outbox_events_gone`);
      try {
        expect(await promoteResults(ctx)).toMatchObject({ applied: 0, held: 1, failed: 0 });
        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ err: expect.any(Error) }),
          expect.stringContaining('owner alert'),
        );
      } finally {
        await h.pool.query(`ALTER TABLE outbox_events_gone RENAME TO outbox_events`);
      }
    },
    TEST_TIMEOUT,
  );
});
