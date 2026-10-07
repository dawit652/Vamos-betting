import { z } from 'zod';
import { DateOfBirth, LocaleSchema } from './auth';
import { Santim } from './common';

export const KycStatusSchema = z.enum(['unverified', 'pending', 'verified', 'rejected']);

export const ExclusionSchema = z.object({
  kind: z.enum(['cool_off', 'self_exclusion']),
  startsAt: z.string(),
  endsAt: z.string().nullable(),
});
export type Exclusion = z.infer<typeof ExclusionSchema>;

export const MeResponse = z.object({
  id: z.string(),
  phone: z.string(),
  phoneMasked: z.string(),
  fullName: z.string().nullable(),
  dateOfBirth: z.string(),
  locale: LocaleSchema,
  status: z.enum(['pending_verification', 'active', 'suspended', 'closed']),
  kyc: z.object({ status: KycStatusSchema, idNumberLast4: z.string().nullable() }),
  /** Active cool-off or self-exclusion, if any. */
  exclusion: ExclusionSchema.nullable(),
  /** True when the player may currently place bets and deposit. */
  canGamble: z.boolean(),
  createdAt: z.string(),
});
export type MeResponse = z.infer<typeof MeResponse>;

export const UpdateMeRequest = z
  .object({
    locale: LocaleSchema.optional(),
    fullName: z.string().trim().min(2).max(120).optional(),
  })
  .refine((v) => v.locale !== undefined || v.fullName !== undefined, 'nothing to update');
export type UpdateMeRequest = z.infer<typeof UpdateMeRequest>;

/** Fayda national ID: FIN (12 digits) or FAN (16 digits). */
export const SubmitKycRequest = z.object({
  idNumber: z
    .string()
    .trim()
    .transform((v) => v.replace(/[\s-]/g, ''))
    .pipe(z.string().regex(/^(\d{12}|\d{16})$/, 'enter your 12-digit FIN or 16-digit FAN')),
  fullName: z.string().trim().min(2).max(120),
  dateOfBirth: DateOfBirth,
});
export type SubmitKycRequest = z.infer<typeof SubmitKycRequest>;

export const KycResponse = z.object({
  status: KycStatusSchema,
  idNumberLast4: z.string().nullable(),
  rejectionReason: z.string().nullable(),
});
export type KycResponse = z.infer<typeof KycResponse>;

/** null removes the limit (removals and increases take effect after a cooling-off delay). */
const LimitValue = Santim.nullable().optional();

export const RgLimitsRequest = z.object({
  deposit: z.object({ day: LimitValue, week: LimitValue, month: LimitValue }).partial().optional(),
  loss: z.object({ day: LimitValue, week: LimitValue, month: LimitValue }).partial().optional(),
  stake: z.object({ bet: LimitValue }).partial().optional(),
});
export type RgLimitsRequest = z.infer<typeof RgLimitsRequest>;

export const RgLimitEntry = z.object({
  /** Active limit in santim, or null when none. */
  amount: Santim.nullable(),
  /** A scheduled change that is not active yet. */
  pending: z.object({ amount: Santim.nullable(), effectiveFrom: z.string() }).nullable(),
});
export type RgLimitEntry = z.infer<typeof RgLimitEntry>;

export const RgLimitsResponse = z.object({
  deposit: z.object({ day: RgLimitEntry, week: RgLimitEntry, month: RgLimitEntry }),
  loss: z.object({ day: RgLimitEntry, week: RgLimitEntry, month: RgLimitEntry }),
  stake: z.object({ bet: RgLimitEntry }),
});
export type RgLimitsResponse = z.infer<typeof RgLimitsResponse>;

export const CreateExclusionRequest = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cool_off'), duration: z.enum(['24h', '7d', '30d']) }),
  z.object({
    kind: z.literal('self_exclusion'),
    duration: z.enum(['6m', '1y', '5y', 'permanent']),
  }),
]);
export type CreateExclusionRequest = z.infer<typeof CreateExclusionRequest>;
