import { z } from 'zod';
import { IsoDateTime } from './common';

/** Any common way of writing an Ethiopian mobile number; normalised server-side. */
export const PhoneInput = z.string().trim().min(9).max(20);

/** Gregorian date of birth, YYYY-MM-DD. */
export const DateOfBirth = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');

/**
 * A new player password (registration, reset, change) is a **4-digit PIN**: the owner's choice
 * (16 Nov 2026), so players sign in as they do on their mobile money app. The API also refuses the
 * easiest PINs (`weak_password`: one digit four times, a straight run, the last four digits of the
 * phone). Guessing is held back by the login limits per number (per 15
 * minutes and per day, lifted by the SMS reset) and per address. Staff passwords are not PINs.
 *
 * Login (and the current password of a change) takes any non-empty password, so an account made
 * under the older rule (MIN_PASSWORD_LENGTH characters or more) keeps signing in with it.
 */
export const PIN_LENGTH = 4;
/** The rule older player passwords were made under; such a password still signs in. */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

/** The length a password counts for: Unicode characters, a run of spaces counting once. */
export function effectivePasswordLength(password: string): number {
  return Array.from(password.replace(/ {2,}/g, ' ')).length;
}

/** A new player PIN: exactly PIN_LENGTH digits. */
export const Password = z
  .string()
  .regex(new RegExp(`^\\d{${PIN_LENGTH}}$`), `a ${PIN_LENGTH}-digit PIN`);

export const OtpCode = z.string().regex(/^\d{6}$/, 'the code has 6 digits');

export const LocaleSchema = z.enum(['am', 'en', 'om', 'ti']);

export const RegisterRequest = z.object({
  phone: PhoneInput,
  password: Password,
  /**
   * Optional: the web form no longer asks for it (the player confirms 21+ with
   * `acceptTerms`, and KYC checks the age on the ID). When a client still sends
   * one, it is validated and an underage date is refused as before.
   */
  dateOfBirth: DateOfBirth.optional(),
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
  /** True when REGISTRATION_SMS_VERIFICATION=off: `demoOtp` is the code and the web app submits it itself. */
  registrationWithoutSms: z.boolean().optional(),
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
 * Forgot PIN at a shop (no SMS or Telegram; cashier phase "assisted PIN reset"): the browser keeps a
 * random secret (base64url, 43 characters for 32 bytes) and sends only its SHA-256 (hex) to start.
 * The secret itself goes in the bodies of the status and the completion, never in a URL.
 */
export const ShopPinResetSecret = z
  .string()
  .min(32)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, 'base64url');
/** POST /auth/password/shop-reset */
export const ShopPinResetStartRequest = z
  .object({
    phone: PhoneInput,
    secretHash: z.string().regex(/^[0-9a-f]{64}$/, 'SHA-256 in hex'),
  })
  .strict();
export type ShopPinResetStartRequest = z.infer<typeof ShopPinResetStartRequest>;
/** The same answer whether or not the number has an account. */
export const ShopPinResetStartResponse = z.object({
  /** Eight digits the player tells the cashier. */
  deskCode: z.string(),
  expiresAt: IsoDateTime,
});
export type ShopPinResetStartResponse = z.infer<typeof ShopPinResetStartResponse>;
/** POST /auth/password/shop-reset/status */
export const ShopPinResetStatusRequest = z.object({ secret: ShopPinResetSecret }).strict();
export type ShopPinResetStatusRequest = z.infer<typeof ShopPinResetStatusRequest>;
export const ShopPinResetState = z.enum([
  'waiting_desk',
  'waiting_approval',
  'approved',
  'rejected',
  'expired',
  'done',
]);
export type ShopPinResetState = z.infer<typeof ShopPinResetState>;
export const ShopPinResetStatusResponse = z.object({
  state: ShopPinResetState,
  deskCode: z.string(),
  /** When the current step ends (null once it is over). */
  until: IsoDateTime.nullable(),
});
export type ShopPinResetStatusResponse = z.infer<typeof ShopPinResetStatusResponse>;
/** POST /auth/password/shop-reset/complete: after the approval, from the browser that started. */
export const ShopPinResetCompleteRequest = z
  .object({ secret: ShopPinResetSecret, newPassword: Password })
  .strict();
export type ShopPinResetCompleteRequest = z.infer<typeof ShopPinResetCompleteRequest>;

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
 * player session ends at `expiresAt` (PLAYER_SESSION_HOURS after sign-in: a
 * year by default) and, only when PLAYER_SESSION_IDLE_MINUTES is set, that
 * long after its last request (`idleExpiresAt` moves on with every request;
 * without an idle limit it equals `expiresAt`). Staff sessions are separate
 * (12 hours, 30 minutes idle).
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

/**
 * POST /internal/telegram/password-reset: the Telegram bot (worker) asks the API for a PIN reset
 * code for a number the person proved by sharing their own Telegram contact. Only the worker can
 * call it: `x-vamos-signature` is the HMAC-SHA256 (hex) of telegramResetSigningInput under
 * SESSION_SECRET, which the API and the worker share, and a request older than
 * TELEGRAM_RESET_MAX_AGE_SECONDS is refused (as long as the code's resend cooldown, so a replay
 * gets nothing). `timestamp` is in seconds.
 */
export const TelegramResetCodeRequest = z.object({
  phone: z.string().min(1).max(32),
  chatId: z.number().int(),
  timestamp: z.number().int().positive(),
});
export type TelegramResetCodeRequest = z.infer<typeof TelegramResetCodeRequest>;

export const TELEGRAM_RESET_PATH = '/internal/telegram/password-reset';
export const TELEGRAM_RESET_MAX_AGE_SECONDS = 60;

/** The text both sides sign (never the code: there is none in the request). */
export function telegramResetSigningInput(input: TelegramResetCodeRequest): string {
  return `telegram-reset:v1:${input.timestamp}:${input.phone}:${input.chatId}`;
}

export const TelegramResetCodeResponse = z.discriminatedUnion('status', [
  z.object({ status: z.literal('sent'), code: z.string().regex(/^\d{6}$/), expiresAt: z.string() }),
  z.object({ status: z.literal('no_account') }),
]);
export type TelegramResetCodeResponse = z.infer<typeof TelegramResetCodeResponse>;
