import type { MessageKey, MessageVars } from '@vamos/i18n/translate';
import { errorMessageKey, isApiClientError } from '@/lib/api/errors';
import type { FieldErrors } from './validation';

/**
 * Maps an API failure onto a form: per-field messages where the API says which
 * field is wrong (a `validation_error` path or a field-specific code), and one
 * form-level message otherwise.
 */
export interface FormErrorConfig<F extends string> {
  /** `validation_error` detail path (e.g. "phone", "deposit.day") → field and message. */
  paths?: Readonly<Partial<Record<string, readonly [F, MessageKey]>>>;
  /** API error code → field message (with `field`) or form message (without). */
  codes?: Readonly<Partial<Record<string, { field?: F; key: MessageKey }>>>;
}

export interface FormErrorResult<F extends string> {
  fields: FieldErrors<F>;
  form: MessageKey | null;
}

interface ValidationIssue {
  path: string;
  message: string;
}

function validationIssues(details: unknown): ValidationIssue[] {
  if (!Array.isArray(details)) return [];
  return details.filter(
    (item): item is ValidationIssue =>
      item !== null &&
      typeof item === 'object' &&
      typeof (item as { path?: unknown }).path === 'string',
  );
}

export function formErrors<F extends string>(
  error: unknown,
  config: FormErrorConfig<F> = {},
): FormErrorResult<F> {
  const fields: FieldErrors<F> = {};
  if (!isApiClientError(error)) return { fields, form: errorMessageKey(error) };

  const mapped = config.codes?.[error.code];
  if (mapped !== undefined) {
    if (mapped.field === undefined) return { fields, form: mapped.key };
    fields[mapped.field] = mapped.key;
    return { fields, form: null };
  }

  if (error.code === 'validation_error') {
    let unmatched = false;
    for (const issue of validationIssues(error.details)) {
      const target = config.paths?.[issue.path];
      if (target === undefined) {
        unmatched = true;
      } else if (fields[target[0]] === undefined) {
        fields[target[0]] = target[1];
      }
    }
    const matchedAny = Object.keys(fields).length > 0;
    return { fields, form: matchedAny && !unmatched ? null : 'common.errors.validation' };
  }

  return { fields, form: errorMessageKey(error) };
}

/** A message key plus its placeholder values. */
export interface Message {
  key: MessageKey;
  vars?: MessageVars;
}

/** Reads a string property of an API error's details object. */
export function detailString(error: unknown, name: string): string | null {
  if (!isApiClientError(error)) return null;
  const details = error.details;
  if (details === null || typeof details !== 'object' || Array.isArray(details)) return null;
  const value = (details as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : null;
}

/** True when the error says the player is under a cool-off or self-exclusion. */
export function isExclusionError(error: unknown): boolean {
  return (
    isApiClientError(error) && (error.code === 'cooling_off' || error.code === 'self_excluded')
  );
}

/** `retryAfterSeconds` of an `otp_cooldown` answer (429), or null. */
export function retryAfterSeconds(error: unknown): number | null {
  if (!isApiClientError(error) || error.code !== 'otp_cooldown') return null;
  const details = error.details as { retryAfterSeconds?: unknown } | null | undefined;
  const value = details?.retryAfterSeconds;
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? Math.min(value, 3600)
    : null;
}
