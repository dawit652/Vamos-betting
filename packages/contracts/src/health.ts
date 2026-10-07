import { z } from 'zod';
import { OperatingModeSchema } from './common';

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
  mode: OperatingModeSchema,
  version: z.string(),
  time: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
