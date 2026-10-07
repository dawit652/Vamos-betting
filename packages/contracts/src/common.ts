import { z } from 'zod';

/**
 * Wire conventions:
 * - Money amounts travel as decimal strings of santim (e.g. "12550" = 125.50 ETB)
 *   so BigInt values survive JSON without precision loss.
 * - Odds travel as integer milli (1.85 → 1850).
 * - Timestamps are ISO-8601 strings in UTC.
 */
export const Santim = z.string().regex(/^-?\d+$/, 'amount must be an integer number of santim');
export type Santim = z.infer<typeof Santim>;

export const OddsMilli = z.number().int().min(1001).max(1_000_000);

export const IsoDateTime = z.iso.datetime({ offset: true });

export const Id = z.string().min(1).max(64);

export const OperatingModeSchema = z.enum(['demo', 'licensed']);
export type OperatingModeValue = z.infer<typeof OperatingModeSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});
export type PageQuery = z.infer<typeof PageQuery>;
