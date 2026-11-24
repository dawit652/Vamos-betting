import { addTeamAlias } from '@vamos/db';
import { afterEach, describe, expect, it } from 'vitest';
import { runAliasCheck } from '../src/tasks/alias-check';
import { createHarness, HOUR, SETUP_TIMEOUT, TEST_TIMEOUT, type Harness } from './helpers';

/**
 * Rule L3's daily alias check (docs/plans/name-learning.md): recent team aliases that look wrong
 * are logged and told to the owner once (Telegram, alarm `alias_suspicious`); nothing changes.
 */

let h: Harness;
afterEach(async () => {
  await h?.close();
  h = undefined as unknown as Harness;
}, SETUP_TIMEOUT);

const OWNER = '+251911000001';
const ACTOR = { system: 'test' };

const alerts = async () =>
  (
    await h.pool.query<{ payload: { key: string; message: string; telegramOnly?: boolean } }>(
      `SELECT payload FROM outbox_events WHERE type = 'owner.alert' ORDER BY id`,
    )
  ).rows.map((row) => row.payload);

async function alias(aliasNorm: string, team: string): Promise<void> {
  await h.ctx.db.transaction((tx) =>
    addTeamAlias(
      tx,
      { sportId: 'football', aliasNorm, sourceId: null, teamId: h.team(team) },
      ACTOR,
    ),
  );
}

describe('L3: the daily alias check', () => {
  it(
    'a recent alias to another club is listed and the owner told once; right ones are not',
    async () => {
      h = await createHarness({ ownerAlertPhones: OWNER });
      await alias('cfc chelsea', 'Chelsea');
      await alias('everton liverpool', 'Liverpool');
      const summary = await runAliasCheck(h.ctx);
      expect(summary.checked).toBe(2);
      expect(summary.suspicious).toEqual([
        expect.objectContaining({ alias: 'everton liverpool', reason: 'other_club' }),
      ]);
      expect(summary.alerted).toBe(true);
      const [alert, ...more] = await alerts();
      expect(more).toEqual([]);
      expect(alert).toMatchObject({ key: 'alias_suspicious', telegramOnly: true });
      expect(alert?.message).toContain('everton liverpool -> ');
      // Nothing was changed: the alias is still there.
      expect(
        await h.count(
          `SELECT count(*) AS n FROM team_aliases WHERE alias_norm = 'everton liverpool'`,
        ),
      ).toBe(1);
    },
    TEST_TIMEOUT,
  );

  it(
    'aliases older than two days are not listed again, and nothing is sent without one',
    async () => {
      h = await createHarness({ ownerAlertPhones: OWNER });
      await alias('everton liverpool', 'Liverpool');
      // Aliases carry the database's time: written 49 hours before the check.
      await h.pool.query(`UPDATE team_aliases SET created_at = $1`, [
        new Date(h.now().getTime() - 49 * HOUR),
      ]);
      expect(await runAliasCheck(h.ctx)).toEqual({ checked: 0, suspicious: [], alerted: false });
      expect(await alerts()).toEqual([]);
    },
    TEST_TIMEOUT,
  );
});
