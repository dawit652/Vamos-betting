import { LocaleSchema } from '@vamos/contracts';
import type { z } from 'zod';

export type Locale = z.infer<typeof LocaleSchema>;

/** Narrows a stored locale (a text column) to a supported one; Amharic is the default. */
export function toLocale(value: string | null | undefined): Locale {
  const parsed = LocaleSchema.safeParse(value);
  return parsed.success ? parsed.data : 'am';
}
