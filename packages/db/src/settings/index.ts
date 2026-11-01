import {
  DEFAULT_BET_RULES,
  DEFAULT_CASH_OUT,
  DEFAULT_JACKPOTS,
  DEFAULT_LIVE_BET_DELAY_MS,
  DEFAULT_MULTI_BONUS,
  DEFAULT_PAYMENT_RULES,
  DEFAULT_RESPONSIBLE_GAMBLING,
  DEFAULT_RISK_LIMITS,
  DEFAULT_TAX,
  MAX_ODDS_MILLI,
  MIN_ODDS_MILLI,
  type BetRules,
  type CashOutConfig,
  type JackpotTemplate,
  type MultiBonusConfig,
  type PaymentRules,
  type ResponsibleGamblingRules,
  type RiskLimits,
  type TaxConfig,
} from '@vamos/core';
import { inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DbExecutor } from '../ledger/types';
import { toJsonSafe } from '../platform/json';
import { settings } from '../schema/platform';

/**
 * Typed business settings (the `settings` table, editable in the back
 * office). Money is stored as decimal santim strings in jsonb and parsed back
 * to bigint here; a missing key (or a missing field of a stored object) falls
 * back to the @vamos/core default.
 */

export type JackpotTemplates = Record<JackpotTemplate['code'], JackpotTemplate>;

export interface GameSettings {
  betRules: BetRules;
  multiBonus: MultiBonusConfig;
  tax: TaxConfig;
  cashOut: CashOutConfig;
  /** Delay before a bet with a live leg is accepted (milliseconds). */
  liveBetDelayMs: number;
  responsibleGambling: ResponsibleGamblingRules;
  jackpots: JackpotTemplates;
  /** Deposit and withdrawal limits, auto-approval and wagering (Phase 6). */
  payments: PaymentRules;
  /** House liability caps checked when a bet is placed (rule L1); no caps by default. */
  riskLimits: RiskLimits;
}

/** `settings.key` of each game setting. */
export const GAME_SETTING_KEYS = {
  betRules: 'bet_rules',
  multiBonus: 'multi_bonus',
  tax: 'tax',
  cashOut: 'cash_out',
  liveBetDelayMs: 'live_bet_delay_ms',
  responsibleGambling: 'responsible_gambling',
  jackpots: 'jackpots',
  payments: 'payments',
  riskLimits: 'risk_limits',
} as const satisfies Record<keyof GameSettings, string>;

export type GameSettingKey = (typeof GAME_SETTING_KEYS)[keyof typeof GAME_SETTING_KEYS];

export const DEFAULT_GAME_SETTINGS: GameSettings = {
  betRules: DEFAULT_BET_RULES,
  multiBonus: DEFAULT_MULTI_BONUS,
  tax: DEFAULT_TAX,
  cashOut: DEFAULT_CASH_OUT,
  liveBetDelayMs: DEFAULT_LIVE_BET_DELAY_MS,
  responsibleGambling: DEFAULT_RESPONSIBLE_GAMBLING,
  jackpots: DEFAULT_JACKPOTS,
  payments: DEFAULT_PAYMENT_RULES,
  riskLimits: DEFAULT_RISK_LIMITS,
};

/** A stored setting does not match its schema. */
export class InvalidSettingError extends Error {
  constructor(
    readonly key: string,
    readonly issues: string[],
  ) {
    super(`setting ${key} is invalid: ${issues.join('; ')}`);
    this.name = 'InvalidSettingError';
  }
}

const INT_RE = /^-?\d+$/;

/** A santim (or other bigint) amount: a decimal integer string as stored, or a safe integer. */
const bigintValue = z
  .union([
    z.string().regex(INT_RE, 'expected a decimal integer string'),
    z.number().int().refine(Number.isSafeInteger, 'expected a safe integer'),
    z.bigint(),
  ])
  .transform((value) => BigInt(value));

const santim = bigintValue.refine((value) => value >= 0n, 'must not be negative');
const positiveSantim = bigintValue.refine((value) => value > 0n, 'must be positive');
const legOdds = z.number().int().min(MIN_ODDS_MILLI).max(MAX_ODDS_MILLI);
const bps = z.number().int().min(0).max(10_000);

export const BetRulesSchema = z
  .object({
    minStake: positiveSantim,
    maxStake: positiveSantim,
    maxPayout: positiveSantim,
    maxLegs: z.number().int().min(1).max(100),
    minLegOddsMilli: legOdds,
    maxTotalOddsMilli: bigintValue.refine((value) => value >= 1000n, 'must be at least 1000'),
  })
  .refine((rules) => rules.minStake <= rules.maxStake, 'minStake must not exceed maxStake')
  // A winning bet must always return at least its stake.
  .refine((rules) => rules.maxStake <= rules.maxPayout, 'maxStake must not exceed maxPayout');

export const MultiBonusSchema = z
  .object({
    enabled: z.boolean(),
    minLegOddsMilli: legOdds,
    tiers: z.array(
      z.object({
        minLegs: z.number().int().min(1).max(100),
        percentBps: z.number().int().min(0).max(1_000_000),
      }),
    ),
    maxBonus: santim,
  })
  .refine(
    (config) =>
      config.tiers.every((tier, i) => i === 0 || tier.minLegs > config.tiers[i - 1]!.minLegs),
    'tiers must be sorted by strictly ascending minLegs',
  );

export const TaxSchema = z.object({
  rateBps: bps,
  base: z.enum(['net_winnings', 'gross_payout']),
  exemptBelow: santim,
});

export const CashOutSchema = z.object({
  enabled: z.boolean(),
  marginBps: bps,
  minOffer: santim,
});

export const LiveBetDelaySchema = z.number().int().min(0).max(60_000);

export const ResponsibleGamblingSchema = z.object({
  minAge: z.number().int().min(18).max(100),
});

export const JackpotTemplateSchema = z
  .object({
    code: z.enum(['daily9', 'weekly13']),
    enabled: z.boolean(),
    gameCount: z.number().int().min(1).max(30),
    costPerCombination: positiveSantim,
    maxCombinations: z.number().int().min(1),
    cancelledRule: z.literal('all_win'),
    prizeTiers: z.array(
      z.object({
        correct: z.number().int().min(0),
        kind: z.enum(['shared', 'fixed']),
        amount: santim,
      }),
    ),
  })
  .refine(
    (t) => t.prizeTiers.every((tier, i) => i === 0 || tier.correct < t.prizeTiers[i - 1]!.correct),
    'prizeTiers must be sorted by strictly descending correct',
  )
  .refine((t) => t.prizeTiers.every((tier) => tier.correct <= t.gameCount), {
    message: 'a prize tier cannot need more correct picks than there are games',
  });

export const JackpotsSchema = z
  .object({ daily9: JackpotTemplateSchema, weekly13: JackpotTemplateSchema })
  .refine(
    (jackpots) => jackpots.daily9.code === 'daily9' && jackpots.weekly13.code === 'weekly13',
    'each template must carry its own code',
  );

export const PaymentRulesSchema = z
  .object({
    minDeposit: positiveSantim,
    maxDeposit: positiveSantim,
    minWithdrawal: positiveSantim,
    maxWithdrawal: positiveSantim,
    dailyWithdrawalCap: positiveSantim,
    autoApproveBelow: santim,
    wageringMultiplierBps: z.number().int().min(0).max(1_000_000),
    depositIntentTtlMinutes: z
      .number()
      .int()
      .min(1)
      .max(7 * 24 * 60),
    payoutMaxAttempts: z.number().int().min(1).max(100),
  })
  .refine((rules) => rules.minDeposit <= rules.maxDeposit, 'minDeposit must not exceed maxDeposit')
  .refine(
    (rules) => rules.minWithdrawal <= rules.maxWithdrawal,
    'minWithdrawal must not exceed maxWithdrawal',
  )
  .refine(
    (rules) => rules.minWithdrawal <= rules.dailyWithdrawalCap,
    'minWithdrawal must not exceed dailyWithdrawalCap',
  );

/** A cap is a positive amount or null (no cap): zero would refuse every bet, which is not a cap. */
const capOrNull = z.union([positiveSantim, z.null()]);

export const RiskLimitsSchema = z
  .object({
    maxSelectionLiability: capOrNull,
    maxEventLiability: capOrNull,
  })
  .refine(
    (limits) =>
      limits.maxSelectionLiability === null ||
      limits.maxEventLiability === null ||
      limits.maxSelectionLiability <= limits.maxEventLiability,
    // A match's liability is at least that of any one of its selections, so a selection cap above
    // the match cap could never bind: more likely the two figures were swapped.
    'maxSelectionLiability must not exceed maxEventLiability',
  );

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Stored object fields override the default's; anything else replaces it. */
function overDefault(defaultValue: unknown, stored: unknown): unknown {
  const base = toJsonSafe(defaultValue);
  if (stored === undefined) return base;
  if (isPlainObject(base) && isPlainObject(stored)) return { ...base, ...stored };
  return stored;
}

function parseWith<S extends z.ZodType>(schema: S, key: string, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new InvalidSettingError(
      key,
      result.error.issues.map((issue) =>
        issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`,
      ),
    );
  }
  return result.data;
}

/**
 * Parses raw setting values (as returned by `getSetting`: santim as strings)
 * into typed settings. Missing keys and missing fields of stored objects take
 * the core defaults; jackpot templates merge per template. Throws
 * InvalidSettingError naming the key when a stored value is invalid.
 */
export function parseGameSettings(raw: Partial<Record<GameSettingKey, unknown>>): GameSettings {
  const k = GAME_SETTING_KEYS;
  const storedJackpots = raw[k.jackpots];
  const defaults = DEFAULT_GAME_SETTINGS;
  const jackpots = isPlainObject(storedJackpots)
    ? {
        daily9: overDefault(defaults.jackpots.daily9, storedJackpots.daily9),
        weekly13: overDefault(defaults.jackpots.weekly13, storedJackpots.weekly13),
      }
    : overDefault(defaults.jackpots, storedJackpots);
  return {
    betRules: parseWith(
      BetRulesSchema,
      k.betRules,
      overDefault(defaults.betRules, raw[k.betRules]),
    ),
    multiBonus: parseWith(
      MultiBonusSchema,
      k.multiBonus,
      overDefault(defaults.multiBonus, raw[k.multiBonus]),
    ),
    tax: parseWith(TaxSchema, k.tax, overDefault(defaults.tax, raw[k.tax])),
    cashOut: parseWith(CashOutSchema, k.cashOut, overDefault(defaults.cashOut, raw[k.cashOut])),
    liveBetDelayMs: parseWith(
      LiveBetDelaySchema,
      k.liveBetDelayMs,
      overDefault(defaults.liveBetDelayMs, raw[k.liveBetDelayMs]),
    ),
    responsibleGambling: parseWith(
      ResponsibleGamblingSchema,
      k.responsibleGambling,
      overDefault(defaults.responsibleGambling, raw[k.responsibleGambling]),
    ),
    jackpots: parseWith(JackpotsSchema, k.jackpots, jackpots),
    payments: parseWith(
      PaymentRulesSchema,
      k.payments,
      overDefault(defaults.payments, raw[k.payments]),
    ),
    riskLimits: parseWith(
      RiskLimitsSchema,
      k.riskLimits,
      overDefault(defaults.riskLimits, raw[k.riskLimits]),
    ),
  };
}

/**
 * Loads every game setting in one query (values read as text, like
 * `getSetting`, so santim strings stay strings) and parses them with
 * `parseGameSettings`. Callers may cache the result briefly; bet placement
 * should pass what it loaded to `placeBet`.
 */
export async function loadGameSettings(exec: DbExecutor): Promise<GameSettings> {
  const rows = await exec
    .select({ key: settings.key, value: sql<string>`${settings.value}::text` })
    .from(settings)
    .where(inArray(settings.key, Object.values(GAME_SETTING_KEYS)));
  const raw: Partial<Record<GameSettingKey, unknown>> = {};
  for (const row of rows) {
    raw[row.key as GameSettingKey] = JSON.parse(row.value) as unknown;
  }
  return parseGameSettings(raw);
}
