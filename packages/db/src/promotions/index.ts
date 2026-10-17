import type { JackpotTemplate, MultiBonusConfig } from '@vamos/core';
import { sql } from 'drizzle-orm';
import type { z } from 'zod';
import { domainUnprocessable } from '../errors';
import { listOpenJackpotRounds } from '../jackpots/queries';
import type { JackpotRound, JackpotTemplateCode } from '../jackpots/types';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { writeAudit } from '../platform/audit';
import { setSetting } from '../platform/settings';
import {
  GAME_SETTING_KEYS,
  JackpotTemplateSchema,
  loadGameSettings,
  MultiBonusSchema,
} from '../settings/index';

/**
 * Promotions (Phase 8): the accumulator bonus ladder and the jackpot
 * templates as settings the back office edits (the routes come with staff
 * auth in Phase 9), and what the public promotions page shows.
 *
 * A change applies to what is created after it only: a bet keeps the
 * ladder (and tax and rules) it was placed under in bets.terms, and a
 * jackpot round keeps the template and tax it was opened with in
 * jackpot_rounds.terms, so editing a setting never changes the terms of a
 * bet or round that already exists.
 */

/** Who changes a setting: a person in the back office (or the system, e.g. a migration). */
export interface SettingsActor {
  type: 'admin' | 'system';
  /** The admin user's id (required for 'admin'). */
  id?: string | null;
  ip?: string | null;
}

/** Most tiers the multi-bonus ladder may have. */
export const MAX_MULTI_BONUS_TIERS = 50;
/** Most combinations a jackpot template may allow per entry. */
export const MAX_JACKPOT_COMBINATIONS = 1_000_000;

const MultiBonusUpdateSchema = MultiBonusSchema.refine(
  (config) => !config.enabled || config.tiers.length > 0,
  'an enabled bonus needs at least one tier',
).refine(
  (config) => config.tiers.length <= MAX_MULTI_BONUS_TIERS,
  `at most ${MAX_MULTI_BONUS_TIERS} tiers`,
);

const JackpotTemplateUpdateSchema = JackpotTemplateSchema.refine(
  (template) => template.prizeTiers.length > 0,
  'a jackpot needs at least one prize tier',
)
  .refine(
    (template) => template.prizeTiers[0]?.correct === template.gameCount,
    'the first prize tier must be for every game correct',
  )
  .refine(
    (template) => template.prizeTiers.every((tier) => tier.correct >= 1 && tier.amount > 0n),
    'every prize tier needs at least one correct prediction and a positive amount',
  )
  .refine(
    (template) => template.maxCombinations <= MAX_JACKPOT_COMBINATIONS,
    `maxCombinations must not exceed ${MAX_JACKPOT_COMBINATIONS}`,
  );

function issuesOf(error: z.ZodError): string[] {
  return error.issues.map((issue) =>
    issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`,
  );
}

/** 422 `invalid_setting`, details `{ key, issues }`. */
function invalidSetting(key: string, issues: string[]) {
  return domainUnprocessable('invalid_setting', `Invalid ${key} setting: ${issues[0] ?? ''}`, {
    key,
    issues,
  });
}

function checkActor(actor: SettingsActor): {
  actorType: 'admin' | 'system';
  actorId: string | null;
} {
  if (actor.type === 'admin' && (typeof actor.id !== 'string' || actor.id.length === 0)) {
    throw new RangeError('an admin settings change needs the admin id');
  }
  return { actorType: actor.type, actorId: actor.type === 'admin' ? (actor.id ?? null) : null };
}

/** Serialises changes of one setting key (also when the row does not exist yet). */
async function lockSetting(tx: DbTransaction, key: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`vamos:setting:${key}`}))`);
}

/** The multi-bonus ladder in force (the typed settings loader). */
export async function getMultiBonusSettings(exec: DbExecutor): Promise<MultiBonusConfig> {
  return (await loadGameSettings(exec)).multiBonus;
}

/** Every jackpot template as configured now. */
export async function getJackpotTemplates(
  exec: DbExecutor,
): Promise<Record<JackpotTemplateCode, JackpotTemplate>> {
  return (await loadGameSettings(exec)).jackpots;
}

/**
 * Replaces the multi-bonus ladder (the whole `multi_bonus` setting), in the
 * caller's transaction: `value` is validated with the settings schema (santim
 * as decimal strings or integers) plus: an enabled bonus needs a tier, at
 * most MAX_MULTI_BONUS_TIERS tiers → else 422 `invalid_setting` (details
 * `{ key, issues }`). Writes the setting and an audit record
 * (`settings.updated` with the value before and after). New bets use it;
 * placed bets keep theirs.
 */
export async function updateMultiBonusSettings(
  tx: DbTransaction,
  input: { value: unknown; actor: SettingsActor },
): Promise<MultiBonusConfig> {
  const key = GAME_SETTING_KEYS.multiBonus;
  const actor = checkActor(input.actor);
  const parsed = MultiBonusUpdateSchema.safeParse(input.value);
  if (!parsed.success) throw invalidSetting(key, issuesOf(parsed.error));
  await lockSetting(tx, key);
  const before = await getMultiBonusSettings(tx);
  await setSetting(tx, key, parsed.data, actor.actorId ?? actor.actorType);
  await writeAudit(tx, {
    ...actor,
    action: 'settings.updated',
    targetType: 'setting',
    targetId: key,
    metadata: { key, before, after: parsed.data },
    ip: input.actor.ip ?? null,
  });
  return parsed.data;
}

/**
 * Replaces one jackpot template inside the `jackpots` setting, in the
 * caller's transaction (the other template is kept as it is): `value` must
 * be a whole template with this code, valid for the settings schema and
 * with at least one prize tier, the first one for every game correct,
 * every tier with at least one correct prediction and a positive amount,
 * and at most MAX_JACKPOT_COMBINATIONS combinations → else 422
 * `invalid_setting`. Writes the setting and an audit record. Rounds opened
 * from now on use it; open rounds keep the terms they were opened with.
 */
export async function updateJackpotTemplate(
  tx: DbTransaction,
  input: { code: JackpotTemplateCode; value: unknown; actor: SettingsActor },
): Promise<JackpotTemplate> {
  const key = GAME_SETTING_KEYS.jackpots;
  const actor = checkActor(input.actor);
  const parsed = JackpotTemplateUpdateSchema.safeParse(input.value);
  if (!parsed.success) throw invalidSetting(key, issuesOf(parsed.error));
  if (parsed.data.code !== input.code) {
    throw invalidSetting(key, [`code: expected ${input.code}, got ${parsed.data.code}`]);
  }
  await lockSetting(tx, key);
  const templates = await getJackpotTemplates(tx);
  const before = templates[input.code];
  const next = { ...templates, [input.code]: parsed.data };
  await setSetting(tx, key, next, actor.actorId ?? actor.actorType);
  await writeAudit(tx, {
    ...actor,
    action: 'settings.updated',
    targetType: 'setting',
    targetId: key,
    metadata: { key, code: input.code, before, after: parsed.data },
    ip: input.actor.ip ?? null,
  });
  return parsed.data;
}

/** What the public promotions page shows. */
export interface Promotions {
  /** The accumulator bonus ladder in force (`enabled: false` = no bonus now). */
  multiBonus: MultiBonusConfig;
  /** The jackpot rounds taking entries now, soonest closing first. */
  jackpots: JackpotRound[];
}

/** The multi-bonus ladder in force and the open jackpot rounds (reads only). */
export async function getPromotions(exec: DbExecutor, now: Date): Promise<Promotions> {
  return {
    multiBonus: await getMultiBonusSettings(exec),
    jackpots: await listOpenJackpotRounds(exec, { now }),
  };
}
