import {
  DEFAULT_RESPONSIBLE_GAMBLING,
  isOfAge,
  normalizeEthiopianMsisdn,
  parseIsoDate,
  PIN_LENGTH,
  pinWeaknessReason,
  type PinWeakness,
} from '@vamos/core';
import type { MessageKey } from '@vamos/i18n/translate';

/**
 * Client-side checks that mirror the API (packages/contracts/src/auth.ts and
 * account.ts) so most mistakes are shown before a round trip. The API stays the
 * authority: its answers are mapped onto the same fields by `formErrors`.
 */

export const MIN_AGE = DEFAULT_RESPONSIBLE_GAMBLING.minAge;
export { PIN_LENGTH };
/** Login and "current password" fields take any password: old accounts may still have a long one. */
export const MAX_PASSWORD_LENGTH = 128;

/**
 * True when a well-formed PIN is too easy to guess (the API refuses these with
 * `weak_password`). `phone` is the number the player typed, if any: its last
 * four digits are refused too. The rule is shared with the API (@vamos/core pin).
 */
export function isWeakPin(pin: string, phone?: string): boolean {
  return pinWeaknessReason(pin, phone ?? null) !== null;
}

export type FieldErrors<F extends string> = Partial<Record<F, MessageKey>>;

export function hasErrors(errors: FieldErrors<string>): boolean {
  return Object.values(errors).some((value) => value !== undefined);
}

/** `+2519…` / `+2517…`, or null when it is not an Ethiopian mobile number. */
export function normalizePhone(input: string): string | null {
  return normalizeEthiopianMsisdn(input.trim());
}

export function phoneError(input: string): MessageKey | undefined {
  if (input.trim() === '') return 'account.validation.phoneRequired';
  return normalizePhone(input) === null ? 'account.validation.phone' : undefined;
}

/** Why an easy PIN is refused, in the player's words (the reasons of @vamos/core pinWeaknessReason). */
const PIN_WEAKNESS_MESSAGES: Readonly<Record<PinWeakness, MessageKey>> = {
  repeated: 'account.validation.pinRepeated',
  sequence: 'account.validation.pinSequence',
  pattern: 'account.validation.pinPattern',
  year: 'account.validation.pinYear',
  common: 'account.validation.pinCommon',
  phone: 'account.validation.pinPhone',
};

/** A new PIN: exactly four digits and not an easy one (the message says which rule it breaks). */
export function pinError(input: string, phone?: string): MessageKey | undefined {
  if (input.length === 0) return 'account.validation.passwordRequired';
  if (!new RegExp(`^\\d{${PIN_LENGTH}}$`).test(input)) return 'account.validation.pinFormat';
  const weakness = pinWeaknessReason(input, phone ?? null);
  if (weakness !== null) return PIN_WEAKNESS_MESSAGES[weakness];
  return undefined;
}

export function dateOfBirthError(input: string, now: Date): MessageKey | undefined {
  if (input === '') return 'account.validation.dateOfBirthRequired';
  if (parseIsoDate(input) === null) return 'account.validation.dateOfBirth';
  if (input > isoDate(now)) return 'account.validation.dateOfBirth';
  if (!isOfAge(input, MIN_AGE, now)) return 'account.validation.underage';
  return undefined;
}

/** UTC calendar date of an instant, `YYYY-MM-DD` (the API computes ages in UTC). */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The latest date of birth that is old enough today (the date input's `max`). */
export function latestBirthDate(now: Date, minAge: number = MIN_AGE): string {
  const year = now.getUTCFullYear() - minAge;
  const month = now.getUTCMonth();
  // 29 February in a non-leap target year becomes 28 February (still old enough).
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(now.getUTCDate(), lastDay);
  return isoDate(new Date(Date.UTC(year, month, day)));
}

/**
 * Registration asks for no date of birth: the player confirms 21+ with the
 * terms checkbox and KYC checks the age on the ID (the API still checks a date
 * an older client sends).
 */
export interface RegisterInput {
  phone: string;
  password: string;
  acceptTerms: boolean;
}

export type RegisterField = keyof RegisterInput;

export function validateRegister(input: RegisterInput): FieldErrors<RegisterField> {
  const errors: FieldErrors<RegisterField> = {};
  const phone = phoneError(input.phone);
  if (phone) errors.phone = phone;
  const password = pinError(input.password, input.phone);
  if (password) errors.password = password;
  if (!input.acceptTerms) errors.acceptTerms = 'account.validation.terms';
  return errors;
}

export function validateLogin(input: {
  phone: string;
  password: string;
}): FieldErrors<'phone' | 'password'> {
  const errors: FieldErrors<'phone' | 'password'> = {};
  const phone = phoneError(input.phone);
  if (phone) errors.phone = phone;
  if (input.password.length === 0) errors.password = 'account.validation.passwordRequired';
  return errors;
}

/** Keeps the digits of a typed or pasted SMS code, at most six. */
export function cleanOtp(input: string): string {
  return input.replace(/\D/g, '').slice(0, 6);
}

export function otpError(code: string): MessageKey | undefined {
  return /^\d{6}$/.test(code) ? undefined : 'account.validation.otp';
}

export interface ResetInput {
  phone: string;
  code: string;
  newPassword: string;
  confirmPassword: string;
}

export function validateReset(input: ResetInput): FieldErrors<keyof ResetInput> {
  const errors: FieldErrors<keyof ResetInput> = {};
  const phone = phoneError(input.phone);
  if (phone) errors.phone = phone;
  const code = otpError(input.code);
  if (code) errors.code = code;
  const password = pinError(input.newPassword, input.phone);
  if (password) errors.newPassword = password;
  else if (input.confirmPassword !== input.newPassword) {
    errors.confirmPassword = 'account.validation.passwordMismatch';
  }
  return errors;
}

/** Fayda ID without spaces or dashes: a 12-digit FIN or a 16-digit FAN, else null. */
export function normalizeFaydaId(input: string): string | null {
  const compact = input.trim().replace(/[\s-]/g, '');
  return /^(\d{12}|\d{16})$/.test(compact) ? compact : null;
}

export function fullNameError(input: string): MessageKey | undefined {
  const name = input.trim();
  return name.length < 2 || name.length > 120 ? 'account.validation.fullName' : undefined;
}

export interface KycInput {
  idNumber: string;
  fullName: string;
  dateOfBirth: string;
}

export function validateKyc(input: KycInput, now: Date): FieldErrors<keyof KycInput> {
  const errors: FieldErrors<keyof KycInput> = {};
  if (normalizeFaydaId(input.idNumber) === null) errors.idNumber = 'account.validation.fayda';
  const name = fullNameError(input.fullName);
  if (name) errors.fullName = name;
  const dob = dateOfBirthError(input.dateOfBirth, now);
  if (dob) errors.dateOfBirth = dob;
  return errors;
}
