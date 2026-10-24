import { z } from 'zod';

/** Any common way of writing an Ethiopian mobile number; normalised server-side. */
export const PhoneInput = z.string().trim().min(9).max(20);

/** Gregorian date of birth, YYYY-MM-DD. */
export const DateOfBirth = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');

/**
 * A new password (registration, reset). The API also refuses common ones
 * (`weak_password`). Login takes any non-empty password, so accounts created
 * under the earlier 6-character rule keep working until they change it.
 */
export const MIN_PASSWORD_LENGTH = 8;
export const Password = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `at least ${MIN_PASSWORD_LENGTH} characters`)
  .max(128);

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

/**
 * Returned by OTP verification and login. The session token is set as an
 * httpOnly cookie (`vamos_session`); `csrfToken` must be echoed in the
 * `x-csrf-token` header on state-changing requests (it is also set as the
 * readable `vamos_csrf` cookie). Non-browser clients may instead send
 * `Authorization: Bearer <sessionToken>`, which needs no CSRF token.
 */
export const SessionResponse = z.object({
  user: z.object({
    id: z.string(),
    phone: z.string(),
    status: z.enum(['pending_verification', 'active', 'suspended', 'closed']),
    locale: LocaleSchema,
  }),
  csrfToken: z.string(),
  sessionToken: z.string(),
  expiresAt: z.string(),
});
export type SessionResponse = z.infer<typeof SessionResponse>;

export const OkResponse = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof OkResponse>;
