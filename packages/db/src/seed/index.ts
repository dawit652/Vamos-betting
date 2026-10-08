import {
  DEFAULT_BET_RULES,
  DEFAULT_CASH_OUT,
  DEFAULT_JACKPOTS,
  DEFAULT_LIVE_BET_DELAY_MS,
  DEFAULT_MULTI_BONUS,
  DEFAULT_RESPONSIBLE_GAMBLING,
  DEFAULT_TAX,
} from '@vamos/core';
import type { Database } from '../client';
import { ensureAccount } from '../ledger/accounts';
import type { HouseAccountKind } from '../ledger/types';
import { toJsonSafe } from '../platform/json';
import {
  claimOperatingMode,
  getDatabaseOperatingMode,
  type DatabaseOperatingMode,
} from '../platform/operating-mode';
import { settings } from '../schema/platform';
import { seedCatalog } from './catalog';

export {
  CATALOG_CATEGORIES,
  CATALOG_SPORTS,
  CATALOG_TEAMS,
  DEFAULT_TEAM_RATINGS,
  loadFeedTeams,
  seedCatalog,
  type CatalogSeedSummary,
  type FeedTeamsConfig,
} from './catalog';

/** Every house ledger account with a fixed key (PSP clearing accounts are opened per provider). */
export const HOUSE_ACCOUNT_KINDS = [
  'house_stakes',
  'house_revenue',
  'house_tax_payable',
  'house_demo_funding',
  'house_promotions',
  'house_jackpot',
] as const satisfies readonly HouseAccountKind[];

/**
 * Default business settings (key -> value as stored in the `settings` table).
 * Money values are bigint santim here and become decimal strings in jsonb.
 */
export const DEFAULT_SETTINGS: Readonly<Record<string, unknown>> = {
  bet_rules: DEFAULT_BET_RULES,
  multi_bonus: DEFAULT_MULTI_BONUS,
  tax: DEFAULT_TAX,
  cash_out: DEFAULT_CASH_OUT,
  live_bet_delay_ms: DEFAULT_LIVE_BET_DELAY_MS,
  responsible_gambling: DEFAULT_RESPONSIBLE_GAMBLING,
  jackpots: DEFAULT_JACKPOTS,
};

/** `settings.updated_by` for rows written by the seed. */
export const SEED_ACTOR = 'seed';

/** The house accounts a database of the given mode needs (no demo funding when licensed). */
export function houseAccountKinds(mode: DatabaseOperatingMode | null): HouseAccountKind[] {
  return HOUSE_ACCOUNT_KINDS.filter((kind) => mode !== 'licensed' || kind !== 'house_demo_funding');
}

export interface SeedOptions {
  /**
   * The configured operating mode. When given, it is claimed for the database
   * first (OperatingModeMismatchError if the database belongs to the other
   * mode). Without it, the mode already recorded in the database (if any) is used.
   */
  mode?: DatabaseOperatingMode;
}

/**
 * Idempotent seed, safe to run on every deploy and concurrently:
 * - claims or checks the operating mode (see `SeedOptions.mode`);
 * - opens every house ledger account the mode needs. A licensed database
 *   gets no demo funding account. Existing accounts and balances are untouched;
 * - writes the default business settings that are absent. Settings that already
 *   exist (possibly edited in the back office) are never overwritten;
 * - upserts the sports catalogue reference data (sports, categories,
 *   competitions, teams; see `seedCatalog`). Back-office edits survive.
 *
 * Returns `{ houseAccounts, settingsCreated }`: the number of house accounts
 * that exist after the run and the number of settings rows inserted by it.
 * Call `seedCatalog` directly for the catalogue's own counts.
 */
export async function seed(
  db: Database,
  options: SeedOptions = {},
): Promise<Record<string, number>> {
  return db.transaction(async (tx) => {
    const mode =
      options.mode === undefined
        ? await getDatabaseOperatingMode(tx)
        : (await claimOperatingMode(tx, options.mode)).mode;
    const kinds = houseAccountKinds(mode);
    for (const kind of kinds) {
      await ensureAccount(tx, { kind });
    }

    const rows = Object.entries(DEFAULT_SETTINGS).map(([key, value]) => {
      const json = toJsonSafe(value);
      if (json === undefined) {
        throw new TypeError(`default setting ${key} has no JSON representation`);
      }
      return { key, value: json, updatedBy: SEED_ACTOR };
    });
    const created = await tx
      .insert(settings)
      .values(rows)
      .onConflictDoNothing({ target: settings.key })
      .returning({ key: settings.key });

    await seedCatalog(tx);

    return { houseAccounts: kinds.length, settingsCreated: created.length };
  });
}
