import { z } from 'zod';

/** Any common way of writing an Ethiopian mobile number; normalised server-side. */
export const PhoneInput = z.string().trim().min(9).max(20);

/** Gregorian date of birth, YYYY-MM-DD. */
export const DateOfBirth = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');

/**
 * A new password (registration, reset, change): 12 to 128 characters, any
 * characters (ASVS 2.1.1–2.1.4, 2.1.9). The API also refuses the 10,000 most
 * common ones and the phone number (`weak_password`). Login takes any
 * non-empty password, but an account whose password no longer meets these
 * rules must reset it before it can sign in (`password_reset_required`).
 */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

/** The length a password counts for: Unicode characters, a run of spaces counting once. */
export function effectivePasswordLength(password: string): number {
  return Array.from(password.replace(/ {2,}/g, ' ')).length;
}

export const Password = z
  .string()
  .max(MAX_PASSWORD_LENGTH)
  .refine((value) => effectivePasswordLength(value) >= MIN_PASSWORD_LENGTH, {
    message: `at least ${MIN_PASSWORD_LENGTH} characters`,
  });

export const OtpCode = z.string().regex(/^\d{6}$/, 'the code has 6 digits');

export const LocaleSchema = z.enum(['am', 'en', 'om', 'ti']);

export const RegisterRequest = z.object({
  phone: PhoneInput,
  password: Password,
  dateOfBirth: DateOfBirth,
  fullName: z.string().trim().min(2).max(120).optional(),
  locale: LocaleSchema.default('am'),
  acceptTerms: z.literal(true, { error: 'you must accept the terms and confirm you are 21+' }),
});
export type RegisterRequest = z.infer<typeof RegisterRequest>;

/**
 * `demoOtp` is only present for registration codes when the mock SMS provider
 * is active (demo mode), where no real SMS can be delivered; the web app
 * shows it on screen. Password-reset codes are never echoed.
 */
export const OtpSentResponse = z.object({
  otpSentTo: z.string(),
  otpExpiresAt: z.string(),
  demoOtp: z.string().optional(),
});
export type OtpSentResponse = z.infer<typeof OtpSentResponse>;

/** The secret returned by POST /auth/register; it proves who chose the password. */
export const RegistrationToken = z.string().min(16).max(200);

/**
 * `registrationToken` must be sent back with the SMS code (verify-otp) and
 * with resend requests. A newer registration of the same number replaces it,
 * so a code can only activate the account for the person who last chose its
 * password. Keep it in memory only; it is useless once the phone is verified.
 */
export const RegisterResponse = OtpSentResponse.extend({
  registrationToken: RegistrationToken,
});
export type RegisterResponse = z.infer<typeof RegisterResponse>;

export const OtpPurposeSchema = z.enum(['register', 'login', 'password_reset']);

export const VerifyOtpRequest = z.object({
  phone: PhoneInput,
  code: OtpCode,
  purpose: z.literal('register'),
  registrationToken: RegistrationToken,
});
export type VerifyOtpRequest = z.infer<typeof VerifyOtpRequest>;

/** `registrationToken` (from POST /auth/register) is required to resend a registration code. */
export const ResendOtpRequest = z
  .object({
    phone: PhoneInput,
    purpose: OtpPurposeSchema,
    registrationToken: RegistrationToken.optional(),
  })
  .refine((value) => value.purpose !== 'register' || value.registrationToken !== undefined, {
    path: ['registrationToken'],
    message: 'required to resend a registration code',
  });
export type ResendOtpRequest = z.infer<typeof ResendOtpRequest>;

export const LoginRequest = z.object({
  phone: PhoneInput,
  password: z.string().min(1).max(128),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const ForgotPasswordRequest = z.object({ phone: PhoneInput });
export type ForgotPasswordRequest = z.infer<typeof ForgotPasswordRequest>;

export const ResetPasswordRequest = z.object({
  phone: PhoneInput,
  code: OtpCode,
  newPassword: Password,
});
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequest>;

const SessionUserView = z.object({
  id: z.string(),
  phone: z.string(),
  status: z.enum(['pending_verification', 'active', 'suspended', 'closed']),
  locale: LocaleSchema,
});

/**
 * Returned by OTP verification and login. The session token is set as an
 * httpOnly cookie (`vamos_session`, `__Host-vamos_session` over https);
 * `csrfToken` must be echoed in the `x-csrf-token` header on state-changing
 * requests (it is also set as the readable `vamos_csrf` cookie, and GET
 * /auth/session hands it out again). Non-browser clients may instead send
 * `Authorization: Bearer <sessionToken>`, which needs no CSRF token. A
 * session ends at `expiresAt` (12 hours after sign-in) or 30 minutes after
 * its last request (`idleExpiresAt` moves on with every request).
 */
export const SessionResponse = z.object({
  user: SessionUserView,
  csrfToken: z.string(),
  sessionToken: z.string(),
  expiresAt: z.string(),
  idleExpiresAt: z.string(),
});
export type SessionResponse = z.infer<typeof SessionResponse>;

/**
 * GET /auth/session: the request's session (its CSRF token included, for a
 * web app on another host that cannot read the API's cookies), or null
 * without a live one. Always 200.
 */
export const SessionStateResponse = z.object({
  session: z
    .object({
      user: SessionUserView,
      csrfToken: z.string(),
      expiresAt: z.string(),
      idleExpiresAt: z.string(),
    })
    .nullable(),
});
export type SessionStateResponse = z.infer<typeof SessionStateResponse>;

/** The current password, re-entered to confirm a sensitive change (any length, like login). */
export const CurrentPassword = z.string().min(1).max(MAX_PASSWORD_LENGTH);

/**
 * POST /me/password: the current and the new password (ASVS 2.1.5, 2.1.6).
 * Every other session of the account ends, and the player gets an SMS.
 */
export const ChangePasswordRequest = z.object({
  currentPassword: CurrentPassword,
  newPassword: Password,
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;

/** One live session of the player (GET /me/sessions). */
export const PlayerSessionView = z.object({
  id: z.string(),
  /** The session this request was made with. */
  current: z.boolean(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  expiresAt: z.string(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
});
export type PlayerSessionView = z.infer<typeof PlayerSessionView>;

export const PlayerSessionsResponse = z.object({ items: z.array(PlayerSessionView) });
export type PlayerSessionsResponse = z.infer<typeof PlayerSessionsResponse>;

/**
 * POST /me/sessions/revoke: ends one other session (`sessionId`) or, without
 * it, every other session of the account; the password is re-entered first
 * (ASVS 3.3.4). The current session is ended with POST /auth/logout.
 */
export const RevokeSessionsRequest = z.object({
  password: CurrentPassword,
  sessionId: z.uuid().optional(),
});
export type RevokeSessionsRequest = z.infer<typeof RevokeSessionsRequest>;

export const RevokeSessionsResponse = z.object({ revoked: z.number().int().nonnegative() });
export type RevokeSessionsResponse = z.infer<typeof RevokeSessionsResponse>;

export const OkResponse = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof OkResponse>;
