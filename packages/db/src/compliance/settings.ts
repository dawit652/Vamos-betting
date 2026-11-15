import { AML_SEVERITIES, DEFAULT_AML_RULES, type AmlRules } from '@vamos/core';
import { inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { domainUnprocessable } from '../errors';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { writeAudit } from '../platform/audit';
import { toJsonSafe } from '../platform/json';
import { setSetting } from '../platform/settings';
import { settings } from '../schema/platform';
import { InvalidSettingError } from '../settings/index';

/**
 * The compliance settings (the `settings` table): the AML rule thresholds
 * (`aml_rules`). Missing keys and fields fall back to the defaults in
 * @vamos/core, which are placeholders to confirm with counsel. Santim are
 * stored as decimal strings.
 */

export interface ComplianceSettings {
  amlRules: AmlRules;
}

export const COMPLIANCE_SETTING_KEYS = {
  amlRules: 'aml_rules',
} as const satisfies Record<keyof ComplianceSettings, string>;

export type ComplianceSettingKey =
  (typeof COMPLIANCE_SETTING_KEYS)[keyof typeof COMPLIANCE_SETTING_KEYS];

export const DEFAULT_COMPLIANCE_SETTINGS: ComplianceSettings = {
  amlRules: DEFAULT_AML_RULES,
};

const INT_RE = /^\d+$/;
const santim = z
  .union([
    z.string().regex(INT_RE, 'expected a whole number of santim'),
    z.number().int().nonnegative().refine(Number.isSafeInteger, 'expected a safe integer'),
    z.bigint().nonnegative(),
  ])
  .transform((value) => BigInt(value));
const bps = z.number().int().min(0).max(10_000);
const count = z.number().int().min(0).max(1_000_000);
const hours = z
  .number()
  .int()
  .min(1)
  .max(24 * 31);
const severity = z.enum(AML_SEVERITIES);

const VelocitySchema = z
  .object({
    enabled: z.boolean(),
    severity,
    maxPerHour: count,
    maxPerDay: count,
  })
  .refine((rule) => rule.maxPerHour <= rule.maxPerDay, 'maxPerHour must not exceed maxPerDay');

export const AmlRulesSchema = z.object({
  enabled: z.boolean(),
  holdWithdrawalsOnHighSeverity: z.boolean(),
  depositVelocity: VelocitySchema,
  withdrawalVelocity: VelocitySchema,
  structuring: z.object({
    enabled: z.boolean(),
    severity,
    reportingThreshold: santim.refine((value) => value > 0n, 'must be positive'),
    nearThresholdBps: bps,
    minNearCount: z.number().int().min(1).max(1_000),
    windowHours: hours,
  }),
  depositThenWithdraw: z.object({
    enabled: z.boolean(),
    severity,
    minStakeShareBps: bps,
    minDeposit: santim,
  }),
  cashOutChurn: z.object({
    enabled: z.boolean(),
    severity,
    windowHours: hours,
    minCount: z.number().int().min(1).max(1_000),
    maxMinutesAfterPlacement: z
      .number()
      .int()
      .min(0)
      .max(24 * 60),
  }),
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Stored fields over the default's, one level of nesting deep (each AML rule merges on its own). */
function overDefault(defaultValue: unknown, stored: unknown): unknown {
  const base = toJsonSafe(defaultValue);
  if (stored === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(stored)) return stored;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(stored)) {
    merged[key] =
      isPlainObject(base[key]) && isPlainObject(value) ? { ...base[key], ...value } : value;
  }
  return merged;
}

function issuesOf(error: z.ZodError): string[] {
  return error.issues.map((issue) =>
    issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`,
  );
}

function parseWith<S extends z.ZodType>(schema: S, key: string, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new InvalidSettingError(key, issuesOf(result.error));
  return result.data;
}

/** Typed compliance settings from raw stored values (as getSetting returns them). */
export function parseComplianceSettings(
  raw: Partial<Record<ComplianceSettingKey, unknown>>,
): ComplianceSettings {
  const k = COMPLIANCE_SETTING_KEYS;
  return {
    amlRules: parseWith(
      AmlRulesSchema,
      k.amlRules,
      overDefault(DEFAULT_COMPLIANCE_SETTINGS.amlRules, raw[k.amlRules]),
    ),
  };
}

/** The compliance settings in one query (InvalidSettingError when a stored value is invalid). */
export async function loadComplianceSettings(exec: DbExecutor): Promise<ComplianceSettings> {
  const rows = await exec
    .select({ key: settings.key, value: sql<string>`${settings.value}::text` })
    .from(settings)
    .where(inArray(settings.key, Object.values(COMPLIANCE_SETTING_KEYS)));
  const raw: Partial<Record<ComplianceSettingKey, unknown>> = {};
  for (const row of rows) raw[row.key as ComplianceSettingKey] = JSON.parse(row.value) as unknown;
  return parseComplianceSettings(raw);
}

export interface ComplianceSettingsView {
  settings: ComplianceSettings;
  /** When each stored compliance setting last changed (absent keys use the defaults). */
  changes: Array<{ key: string; updatedAt: Date; updatedBy: string | null }>;
}

export async function getComplianceSettings(exec: DbExecutor): Promise<ComplianceSettingsView> {
  const changes = await exec
    .select({ key: settings.key, updatedAt: settings.updatedAt, updatedBy: settings.updatedBy })
    .from(settings)
    .where(inArray(settings.key, Object.values(COMPLIANCE_SETTING_KEYS)));
  return { settings: await loadComplianceSettings(exec), changes };
}

const SCHEMAS = {
  aml_rules: { field: 'amlRules', schema: AmlRulesSchema },
} as const satisfies Record<
  ComplianceSettingKey,
  { field: keyof ComplianceSettings; schema: z.ZodType }
>;

/**
 * Replaces one compliance setting (settings.edit) with a complete value and
 * returns the settings as they are now. 422 `invalid_setting` (details
 * `{ key, issues }`) for an unknown key or a value the schema refuses.
 * Audited as `settings.updated` with the value before and after; changes
 * of one key are serialised.
 */
export async function updateComplianceSetting(
  tx: DbTransaction,
  input: {
    key: ComplianceSettingKey;
    value: unknown;
    actor: { adminId: string; ip?: string | null };
  },
): Promise<ComplianceSettings> {
  const { actor } = input;
  if (typeof actor?.adminId !== 'string' || actor.adminId.length === 0) {
    throw new RangeError('a settings change needs the admin id');
  }
  if (!Object.hasOwn(SCHEMAS, input.key)) {
    throw domainUnprocessable(
      'invalid_setting',
      `Invalid ${String(input.key)} setting: unknown setting`,
      {
        key: input.key,
        issues: ['unknown setting'],
      },
    );
  }
  const { field, schema } = SCHEMAS[input.key];
  const parsed = (schema as z.ZodType).safeParse(input.value);
  if (!parsed.success) {
    const issues = issuesOf(parsed.error);
    throw domainUnprocessable(
      'invalid_setting',
      `Invalid ${input.key} setting: ${issues[0] ?? ''}`,
      {
        key: input.key,
        issues,
      },
    );
  }
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`vamos:setting:${input.key}`}))`);
  const before = (await loadComplianceSettings(tx))[field];
  await setSetting(tx, input.key, parsed.data, actor.adminId);
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: actor.adminId,
    action: 'settings.updated',
    targetType: 'setting',
    targetId: input.key,
    metadata: { key: input.key, before, after: parsed.data },
    ip: actor.ip ?? null,
  });
  return loadComplianceSettings(tx);
}
