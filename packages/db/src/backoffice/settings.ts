import { DEFAULT_RESPONSIBLE_GAMBLING } from '@vamos/core';
import { inArray, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { domainUnprocessable } from '../errors';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { writeAudit } from '../platform/audit';
import { setSetting } from '../platform/settings';
import { updateJackpotTemplate, updateMultiBonusSettings } from '../promotions/index';
import { settings } from '../schema/platform';
import {
  BetRulesSchema,
  CashOutSchema,
  GAME_SETTING_KEYS,
  LiveBetDelaySchema,
  loadGameSettings,
  PaymentRulesSchema,
  ResponsibleGamblingSchema,
  RiskLimitsSchema,
  TaxSchema,
  type GameSettings,
} from '../settings/index';
import type { StaffActor } from './common';

/**
 * Business settings in the back office (settings.edit): every game setting
 * with when and by whom it was last changed, and validated updates. A change
 * applies to what is created after it only (bets and jackpot rounds keep
 * the terms they were made under). Each update replaces one whole setting,
 * is validated with the settings schema (santim as decimal strings) plus the
 * business floors below, and is audited as `settings.updated` with the value
 * before and after, in the caller's transaction.
 */

/** What staff can change: one setting, or one jackpot template (value.code names it). */
export type StaffSettingKey =
  | 'bet_rules'
  | 'tax'
  | 'cash_out'
  | 'live_bet_delay_ms'
  | 'responsible_gambling'
  | 'payments'
  | 'risk_limits'
  | 'multi_bonus'
  | 'jackpot_template';

export const STAFF_SETTING_KEYS: readonly StaffSettingKey[] = [
  'bet_rules',
  'tax',
  'cash_out',
  'live_bet_delay_ms',
  'responsible_gambling',
  'payments',
  'risk_limits',
  'multi_bonus',
  'jackpot_template',
];

export interface SettingChangeInfo {
  key: string;
  updatedAt: Date;
  /** The staff member's id (or 'seed', 'system'). */
  updatedBy: string | null;
}

export interface StaffSettingsView {
  settings: GameSettings;
  /** When each stored setting last changed (keys never changed use the defaults and are absent). */
  changes: SettingChangeInfo[];
}

/** Every game setting in force, with its last change. */
export async function getStaffSettings(exec: DbExecutor): Promise<StaffSettingsView> {
  const rows = await exec
    .select({ key: settings.key, updatedAt: settings.updatedAt, updatedBy: settings.updatedBy })
    .from(settings)
    .where(inArray(settings.key, Object.values(GAME_SETTING_KEYS)));
  return { settings: await loadGameSettings(exec), changes: rows };
}

const ResponsibleGamblingUpdateSchema = ResponsibleGamblingSchema.refine(
  (rules) => rules.minAge >= DEFAULT_RESPONSIBLE_GAMBLING.minAge,
  `minAge must be at least ${DEFAULT_RESPONSIBLE_GAMBLING.minAge} (the legal minimum)`,
);

/** The schema of each plain setting (multi_bonus and the jackpot templates have their own services). */
const PLAIN_SETTINGS = {
  bet_rules: { key: GAME_SETTING_KEYS.betRules, schema: BetRulesSchema },
  tax: { key: GAME_SETTING_KEYS.tax, schema: TaxSchema },
  cash_out: { key: GAME_SETTING_KEYS.cashOut, schema: CashOutSchema },
  live_bet_delay_ms: { key: GAME_SETTING_KEYS.liveBetDelayMs, schema: LiveBetDelaySchema },
  responsible_gambling: {
    key: GAME_SETTING_KEYS.responsibleGambling,
    schema: ResponsibleGamblingUpdateSchema,
  },
  payments: { key: GAME_SETTING_KEYS.payments, schema: PaymentRulesSchema },
  risk_limits: { key: GAME_SETTING_KEYS.riskLimits, schema: RiskLimitsSchema },
} as const satisfies Record<
  Exclude<StaffSettingKey, 'multi_bonus' | 'jackpot_template'>,
  { key: string; schema: z.ZodType }
>;

const FIELD_OF_KEY: Record<string, keyof GameSettings> = Object.fromEntries(
  Object.entries(GAME_SETTING_KEYS).map(([field, key]) => [key, field]),
) as Record<string, keyof GameSettings>;

function issuesOf(error: z.ZodError): string[] {
  return error.issues.map((issue) =>
    issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`,
  );
}

/** 422 `invalid_setting`, details `{ key, issues }` (like the promotions services). */
function invalidSetting(key: string, issues: string[]) {
  return domainUnprocessable('invalid_setting', `Invalid ${key} setting: ${issues[0] ?? ''}`, {
    key,
    issues,
  });
}

/**
 * Replaces one setting (settings.edit) and returns every setting as it is
 * now. 422 `invalid_setting` (details `{ key, issues }`) for a value the
 * schema refuses, an unknown key, or a minimum age below the legal 21.
 * Changes of one key are serialised; the audit record names the staff
 * member and holds the value before and after.
 */
export async function updateStaffSetting(
  tx: DbTransaction,
  input: { key: StaffSettingKey; value: unknown; actor: StaffActor },
): Promise<GameSettings> {
  const { actor } = input;
  if (typeof actor?.adminId !== 'string' || actor.adminId.length === 0) {
    throw new RangeError('a settings change needs the admin id');
  }
  const settingsActor = { type: 'admin' as const, id: actor.adminId, ip: actor.ip ?? null };
  if (input.key === 'multi_bonus') {
    await updateMultiBonusSettings(tx, { value: input.value, actor: settingsActor });
    return loadGameSettings(tx);
  }
  if (input.key === 'jackpot_template') {
    const code = (input.value as { code?: unknown } | null)?.code;
    if (code !== 'daily9' && code !== 'weekly13') {
      throw invalidSetting(GAME_SETTING_KEYS.jackpots, ['code: expected daily9 or weekly13']);
    }
    await updateJackpotTemplate(tx, { code, value: input.value, actor: settingsActor });
    return loadGameSettings(tx);
  }
  if (!Object.hasOwn(PLAIN_SETTINGS, input.key)) {
    throw invalidSetting(String(input.key), ['unknown setting']);
  }
  const { key, schema } = PLAIN_SETTINGS[input.key];
  const parsed = (schema as z.ZodType).safeParse(input.value);
  if (!parsed.success) throw invalidSetting(key, issuesOf(parsed.error));
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`vamos:setting:${key}`}))`);
  const field = FIELD_OF_KEY[key];
  if (field === undefined) throw new Error(`no game setting field for ${key}`);
  const before = (await loadGameSettings(tx))[field];
  await setSetting(tx, key, parsed.data, actor.adminId);
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: actor.adminId,
    action: 'settings.updated',
    targetType: 'setting',
    targetId: key,
    metadata: { key, before, after: parsed.data },
    ip: actor.ip ?? null,
  });
  // Re-read through the typed loader: the stored value must parse as the game uses it.
  return loadGameSettings(tx);
}
