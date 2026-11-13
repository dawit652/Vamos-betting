import { z } from 'zod';
import { KycStatusSchema } from './account';
import { BetChannelSchema, BetStatusSchema, BetView } from './betting';
import { EventStatusSchema, LocalizedNameSchema } from './catalog';
import { IsoDateTime, OddsMilli, Santim } from './common';
import {
  JackpotEntryStatusSchema,
  JackpotOutcomeSchema,
  JackpotRoundStatusSchema,
  JackpotRoundView,
  JackpotSettlementView,
  JackpotTemplateCodeSchema,
  JackpotTemplateView,
  MultiBonusView,
} from './jackpots';
import { DepositStatusSchema, WithdrawalStatusSchema } from './payments';
import { WalletTransaction } from './wallet';

/**
 * The back office API (`/admin/*`, apps/admin). Staff sign in with email,
 * password and a TOTP code; the staff session is a cookie of its own
 * (never a bearer token, never a player session) and unsafe methods need
 * the session's CSRF token in the STAFF_CSRF_HEADER header. Every route
 * needs one permission of the matrix below: 401 `unauthorized` without a
 * staff session, 403 `forbidden` for a role without the permission.
 *
 * Wire conventions as everywhere: santim as decimal strings, odds as
 * integer milli, timestamps as ISO-8601 strings. Lists page with an opaque
 * `cursor` (`nextCursor` is null on the last page).
 */

// ---------------------------------------------------------------------------
// Roles and permissions (the one RBAC matrix: the API guards with it, the
// admin UI builds its navigation from it).

export const STAFF_ROLES = ['admin', 'trader', 'finance', 'kyc', 'support', 'compliance'] as const;
export const StaffRoleSchema = z.enum(STAFF_ROLES);
export type StaffRole = z.infer<typeof StaffRoleSchema>;

/**
 * What each permission allows (routes in brackets):
 * - dashboard.view: the dashboard [GET /admin/dashboard]
 * - users.view: player search and detail [GET /admin/users, /admin/users/:id]
 * - kyc.review: the KYC queue and its decisions [/admin/kyc*]
 * - trading.view: event search and the event's markets [GET /admin/trading/events*]
 * - trading.odds: manual prices [POST /admin/trading/selections/:id/odds]
 * - trading.status: suspend / resume / open / close markets and events, betting on/off
 * - trading.result: result an event or correct its result
 * - trading.void: void a market or a selection
 * - risk.view: liability per selection and big bets [GET /admin/risk/*]
 * - bets.view: bet search and detail [GET /admin/bets*]
 * - withdrawals.view: withdrawal queues and flagged payments [GET /admin/withdrawals*, /admin/deposits/flagged]
 * - withdrawals.approve: approve / reject withdrawals, flag / clear / settle payouts, resolve flagged deposits
 * - payouts.settle_manual: claim, pay by hand and settle SMS-rail payouts [/admin/manual-payouts*]
 *   (never one the same staff member approved: the four-eyes rule)
 * - sms.review: the SMS rail's received messages and review queue, crediting or closing them
 *   [/admin/sms*]
 * - jackpots.view: rounds and their entries [GET /admin/jackpots/*]
 * - jackpots.manage: cancel a round before its first kick-off
 * - settings.view: the business settings [GET /admin/settings]
 * - settings.edit: change them [PUT /admin/settings/:key]
 * - audit.view: the audit log [GET /admin/audit]
 * - staff.manage: staff accounts [/admin/staff*]
 * - reports.view: reconciliation runs, PSP statements, compliance settings
 *   [GET /admin/compliance/*, except aml-flags]
 * - reconciliation.run: run a reconciliation now, upload a PSP statement
 *   [POST /admin/compliance/reconciliation-runs, /psp-statements]
 * - aml.review: AML flags and their review [/admin/compliance/aml-flags*]
 * (COMPLIANCE_ROUTE_PERMISSIONS in compliance.ts lists every compliance route.)
 */
export const STAFF_PERMISSIONS = [
  'dashboard.view',
  'users.view',
  'kyc.review',
  'trading.view',
  'trading.odds',
  'trading.status',
  'trading.result',
  'trading.void',
  'risk.view',
  'bets.view',
  'withdrawals.view',
  'withdrawals.approve',
  'payouts.settle_manual',
  'sms.review',
  'jackpots.view',
  'jackpots.manage',
  'settings.view',
  'settings.edit',
  'audit.view',
  'staff.manage',
  'reports.view',
  'reconciliation.run',
  'aml.review',
] as const;
export const StaffPermissionSchema = z.enum(STAFF_PERMISSIONS);
export type StaffPermission = z.infer<typeof StaffPermissionSchema>;

/** The RBAC matrix: the roles holding each permission (admin holds every one). */
export const PERMISSION_ROLES: Readonly<Record<StaffPermission, readonly StaffRole[]>> = {
  'dashboard.view': ['admin', 'trader', 'finance', 'kyc', 'support', 'compliance'],
  'users.view': ['admin', 'support', 'kyc', 'finance', 'compliance'],
  'kyc.review': ['admin', 'kyc'],
  'trading.view': ['admin', 'trader'],
  'trading.odds': ['admin', 'trader'],
  'trading.status': ['admin', 'trader'],
  'trading.result': ['admin', 'trader'],
  'trading.void': ['admin', 'trader'],
  'risk.view': ['admin', 'trader', 'compliance'],
  'bets.view': ['admin', 'support', 'trader', 'compliance', 'finance'],
  'withdrawals.view': ['admin', 'finance', 'compliance'],
  'withdrawals.approve': ['admin', 'finance'],
  'payouts.settle_manual': ['admin', 'finance'],
  'sms.review': ['admin', 'finance', 'compliance'],
  'jackpots.view': ['admin', 'trader', 'compliance', 'support'],
  'jackpots.manage': ['admin', 'trader'],
  'settings.view': ['admin', 'trader', 'finance', 'compliance'],
  'settings.edit': ['admin'],
  'audit.view': ['admin', 'compliance'],
  'staff.manage': ['admin'],
  'reports.view': ['admin', 'compliance', 'finance'],
  'reconciliation.run': ['admin', 'compliance', 'finance'],
  'aml.review': ['admin', 'compliance'],
};

/** Whether `role` holds `permission` (false for anything unknown). */
export function hasPermission(role: string, permission: string): boolean {
  if (!Object.hasOwn(PERMISSION_ROLES, permission)) return false;
  return (PERMISSION_ROLES[permission as StaffPermission] as readonly string[]).includes(role);
}

/** Every permission of `role`, in matrix order ([] for an unknown role). */
export function permissionsOf(role: string): StaffPermission[] {
  return STAFF_PERMISSIONS.filter((permission) => hasPermission(role, permission));
}

/** Name of the staff session cookie (httpOnly, SameSite=Strict, Secure in production, path /admin). */
export const STAFF_SESSION_COOKIE = 'vamos_staff';
/** Header carrying the staff session's CSRF token on unsafe methods. */
export const STAFF_CSRF_HEADER = 'x-staff-csrf-token';

/** Error codes of the staff routes besides the shared ones. */
export const AdminErrorCodeSchema = z.enum([
  'unauthorized',
  'forbidden',
  'csrf_invalid',
  'invalid_credentials',
  'invalid_cursor',
  'invalid_range',
  'reason_required',
  'note_required',
  'correction_reason_required',
  'event_not_started',
  'invalid_trading_state',
  'invalid_trading_input',
  'kyc_not_pending',
  'kyc_underage',
  'payout_not_reviewable',
  'payout_not_approved',
  'payout_already_closed',
  'payout_in_progress',
  'payout_already_paid',
  'provider_ref_conflict',
  'deposit_not_flagged',
  'deposit_already_credited',
  'jackpot_round_not_cancellable',
  'invalid_setting',
  'staff_email_taken',
  'invalid_staff_email',
  'invalid_staff_name',
  'invalid_staff_role',
  'weak_password',
  'last_admin',
  'invalid_business_date',
  'summary_not_started',
  'summary_not_due',
  'invalid_statement',
  'statement_already_imported',
  'aml_flag_closed',
  'invalid_decision',
]);
export type AdminErrorCode = z.infer<typeof AdminErrorCodeSchema>;

// ---------------------------------------------------------------------------
// Shared pieces.

/** Free text kept in the audit log (a reason or a note). */
const AuditText = z.string().trim().min(1).max(500);
const OptionalAuditText = z.string().trim().max(500).optional();
const Uuid = z.uuid();
const Cursor = z.string().min(1).max(200).optional();

function pageLimit(max: number, fallback: number) {
  return z.coerce.number().int().min(1).max(max).default(fallback);
}

/** A query list: `status=open,won` or repeated `status=open&status=won`. */
function queryList<T extends z.ZodType>(item: T) {
  return z.preprocess(
    (value) =>
      typeof value === 'string'
        ? value
            .split(',')
            .map((part) => part.trim())
            .filter((part) => part.length > 0)
        : value,
    z.array(item).max(20),
  );
}

/** A non-negative santim amount in a query string. */
const QuerySantim = z.string().regex(/^\d{1,18}$/, 'amount must be a whole number of santim');

/** One page of a list. */
function page<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}

export const AmountCountView = z.object({ count: z.number().int(), amount: Santim });
export type AmountCountView = z.infer<typeof AmountCountView>;

/** `{ changed }`: false when the call found the target state already (nothing written). */
export const ChangedResponse = z.object({ changed: z.boolean() });
export type ChangedResponse = z.infer<typeof ChangedResponse>;

// ---------------------------------------------------------------------------
// Staff auth and session.

/** POST /admin/auth/login (rate limited). Every failure is 401 `invalid_credentials`. */
export const StaffLoginRequest = z.object({
  email: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(128),
  /** The 6-digit code of the authenticator app. */
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'enter the 6-digit code from your authenticator app'),
});
export type StaffLoginRequest = z.infer<typeof StaffLoginRequest>;

export const StaffMeView = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  role: StaffRoleSchema,
  permissions: z.array(StaffPermissionSchema),
  /**
   * Someone else chose the password: until the staff member changes it (POST
   * /admin/me/password), every route but the session ones answers 403
   * `password_change_required`.
   */
  passwordChangeRequired: z.boolean(),
});
export type StaffMeView = z.infer<typeof StaffMeView>;

/**
 * POST /admin/auth/login (also sets the session cookie) and GET
 * /admin/session: the staff member, the CSRF token to send on unsafe
 * methods, and when the session ends (absolute, and without activity).
 */
const StaffCode = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'enter the 6-digit code from your authenticator app');

/**
 * POST /admin/me/password: the signed-in staff member's own password. Needs
 * the current password and a code (403 `reauth_failed`, counted like a
 * failed sign-in); 422 `weak_password` / `password_unchanged`. Every other
 * session of the account ends.
 */
export const ChangeOwnPasswordRequest = z.object({
  currentPassword: z.string().min(1).max(128),
  code: StaffCode,
  newPassword: z.string().min(12).max(128),
});
export type ChangeOwnPasswordRequest = z.infer<typeof ChangeOwnPasswordRequest>;

/**
 * POST /admin/me/totp: starts replacing the own authenticator (current
 * password and code; 403 `reauth_failed`). Answers TotpEnrolmentView: the
 * new secret, which takes over once confirmed.
 */
export const StartTotpEnrolmentRequest = z.object({
  password: z.string().min(1).max(128),
  code: StaffCode,
});
export type StartTotpEnrolmentRequest = z.infer<typeof StartTotpEnrolmentRequest>;

/**
 * POST /admin/me/totp/confirm: a code from the new secret (422
 * `invalid_code`; 409 `no_totp_enrolment` when none was started or it
 * expired after 10 minutes). Every other session of the account ends.
 */
export const ConfirmTotpEnrolmentRequest = z.object({ code: StaffCode });
export type ConfirmTotpEnrolmentRequest = z.infer<typeof ConfirmTotpEnrolmentRequest>;

/** GET /admin/me/sessions: the own live sessions, most recently used first (ASVS 3.3.4). */
export const StaffOwnSessionView = z.object({
  id: z.string(),
  /** The session this request was made with. */
  current: z.boolean(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  expiresAt: z.string(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
});
export type StaffOwnSessionView = z.infer<typeof StaffOwnSessionView>;

export const StaffOwnSessionsResponse = z.object({ items: z.array(StaffOwnSessionView) });
export type StaffOwnSessionsResponse = z.infer<typeof StaffOwnSessionsResponse>;

/**
 * POST /admin/me/sessions/revoke: ends one other session (`sessionId`) or,
 * without it, every other session of the account, after the current password
 * and a code (403 `reauth_failed`; 400 `current_session`; 404 when the session
 * is not one of the account's live ones).
 */
export const RevokeOwnStaffSessionsRequest = z.object({
  password: z.string().min(1).max(128),
  code: StaffCode,
  sessionId: z.uuid().optional(),
});
export type RevokeOwnStaffSessionsRequest = z.infer<typeof RevokeOwnStaffSessionsRequest>;

export const RevokeOwnStaffSessionsResponse = z.object({
  revoked: z.number().int().nonnegative(),
});
export type RevokeOwnStaffSessionsResponse = z.infer<typeof RevokeOwnStaffSessionsResponse>;

export const StaffSessionResponse = z.object({
  staff: StaffMeView,
  csrfToken: z.string(),
  expiresAt: z.string(),
  idleExpiresAt: z.string(),
});
export type StaffSessionResponse = z.infer<typeof StaffSessionResponse>;

// ---------------------------------------------------------------------------
// Dashboard (dashboard.view).

/** GET /admin/dashboard?from&to: the window [from, to), at most a year (422 `invalid_range`). */
export const DashboardQuery = z.object({
  from: IsoDateTime,
  to: IsoDateTime,
});
export type DashboardQuery = z.infer<typeof DashboardQuery>;

export const DashboardResponse = z.object({
  from: z.string(),
  to: z.string(),
  betting: z.object({
    /** Bets placed in the window (rejected ones excepted) and their stakes. */
    placed: AmountCountView,
    turnover: Santim,
    /**
     * Bet settlements posted in the window (won, lost, void, cashed out) and their stakes, by
     * ledger time and net of the settlements reversed in it by result corrections (so a window
     * holding a correction can show a negative count, payouts or tax).
     */
    settled: AmountCountView,
    /** Gross payouts posted in the window (winnings and refunds before tax, cash-outs). */
    payouts: Santim,
    taxWithheld: Santim,
    /** settled.amount − payouts. */
    ggr: Santim,
  }),
  jackpots: z.object({
    entries: AmountCountView,
    settled: AmountCountView,
    prizes: Santim,
    refunds: Santim,
    ggr: Santim,
  }),
  /** Now: the open and pending bets. */
  openLiabilities: z.object({
    bets: z.number().int(),
    stakes: Santim,
    potentialPayout: Santim,
    potentialNetPayout: Santim,
  }),
  payments: z.object({
    deposits: AmountCountView,
    withdrawals: AmountCountView,
    openWithdrawals: AmountCountView,
    awaitingReview: z.number().int(),
    flaggedWithdrawals: z.number().int(),
    flaggedDeposits: z.number().int(),
  }),
  players: z.object({
    registered: z.number().int(),
    active: z.number().int(),
  }),
});
export type DashboardResponse = z.infer<typeof DashboardResponse>;

// ---------------------------------------------------------------------------
// Players (users.view) and KYC (kyc.review).

export const PlayerStatusSchema = z.enum(['pending_verification', 'active', 'suspended', 'closed']);
export type PlayerStatus = z.infer<typeof PlayerStatusSchema>;

/** GET /admin/users: `q` is a phone number (or its last digits), a name or a user id. */
export const PlayerSearchQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: PlayerStatusSchema.optional(),
  kycStatus: KycStatusSchema.optional(),
  limit: pageLimit(100, 25),
  cursor: Cursor,
});
export type PlayerSearchQuery = z.infer<typeof PlayerSearchQuery>;

export const PlayerSummaryView = z.object({
  id: z.string(),
  phone: z.string(),
  fullName: z.string().nullable(),
  status: PlayerStatusSchema,
  kycStatus: KycStatusSchema,
  createdAt: z.string(),
  cash: Santim,
  bonus: Santim,
});
export type PlayerSummaryView = z.infer<typeof PlayerSummaryView>;

export const PlayerListResponse = page(PlayerSummaryView);
export type PlayerListResponse = z.infer<typeof PlayerListResponse>;

/** A KYC profile as staff see it (never the ID number). */
export const StaffKycView = z.object({
  status: KycStatusSchema,
  provider: z.string().nullable(),
  idNumberLast4: z.string().nullable(),
  verifiedName: z.string().nullable(),
  verifiedDateOfBirth: z.string().nullable(),
  providerReference: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  submittedAt: z.string().nullable(),
  reviewedAt: z.string().nullable(),
});
export type StaffKycView = z.infer<typeof StaffKycView>;

/** A responsible-gambling limit slot: in force and a requested raise not yet in force. */
export const StaffLimitSlotView = z.object({
  amount: Santim.nullable(),
  pending: z.object({ amount: Santim.nullable(), effectiveFrom: z.string() }).nullable(),
});
export type StaffLimitSlotView = z.infer<typeof StaffLimitSlotView>;

export const StaffExclusionView = z.object({
  kind: z.enum(['cool_off', 'self_exclusion']),
  startsAt: z.string(),
  endsAt: z.string().nullable(),
  reason: z.string().nullable(),
  createdAt: z.string(),
});
export type StaffExclusionView = z.infer<typeof StaffExclusionView>;

export const PlayerBetSummaryView = z.object({
  id: z.string(),
  shortId: z.string(),
  betType: z.enum(['single', 'multi']),
  status: BetStatusSchema,
  stake: Santim,
  totalOddsMilli: z.string(),
  potentialNetPayout: Santim,
  settledNetPayout: Santim.nullable(),
  placedAt: z.string(),
  settledAt: z.string().nullable(),
});
export type PlayerBetSummaryView = z.infer<typeof PlayerBetSummaryView>;

export const PlayerPaymentSummaryView = z.object({
  id: z.string(),
  kind: z.enum(['deposit', 'withdrawal']),
  provider: z.string(),
  amount: Santim,
  /** A deposit or withdrawal status. */
  status: z.string(),
  flagged: z.boolean(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});
export type PlayerPaymentSummaryView = z.infer<typeof PlayerPaymentSummaryView>;

/** GET /admin/users/:id (404 for an unknown player). */
export const PlayerDetailView = z.object({
  id: z.string(),
  phone: z.string(),
  fullName: z.string().nullable(),
  dateOfBirth: z.string(),
  locale: z.string(),
  status: PlayerStatusSchema,
  phoneVerifiedAt: z.string().nullable(),
  termsAcceptedAt: z.string(),
  createdAt: z.string(),
  balances: z.object({ cash: Santim, bonus: Santim }),
  kyc: StaffKycView,
  limits: z.object({
    deposit: z.object({
      day: StaffLimitSlotView,
      week: StaffLimitSlotView,
      month: StaffLimitSlotView,
    }),
    loss: z.object({
      day: StaffLimitSlotView,
      week: StaffLimitSlotView,
      month: StaffLimitSlotView,
    }),
    stake: z.object({ bet: StaffLimitSlotView }),
  }),
  activeExclusion: z
    .object({
      kind: z.enum(['cool_off', 'self_exclusion']),
      startsAt: z.string(),
      endsAt: z.string().nullable(),
    })
    .nullable(),
  exclusions: z.array(StaffExclusionView),
  /** Deposits still to be wagered before a withdrawal. */
  remainingWagering: Santim,
  openBets: AmountCountView,
  recentBets: z.array(PlayerBetSummaryView),
  recentPayments: z.array(PlayerPaymentSummaryView),
  /** The latest cash statement lines (newest first). */
  recentTransactions: z.array(WalletTransaction),
});
export type PlayerDetailView = z.infer<typeof PlayerDetailView>;

/** GET /admin/kyc: profiles by status, oldest submission first (default: the pending queue). */
export const KycQueueQuery = z.object({
  status: z.enum(['pending', 'verified', 'rejected']).default('pending'),
  limit: pageLimit(100, 25),
  cursor: Cursor,
});
export type KycQueueQuery = z.infer<typeof KycQueueQuery>;

export const KycQueueItemView = StaffKycView.extend({
  userId: z.string(),
  phone: z.string(),
  fullName: z.string().nullable(),
  dateOfBirth: z.string(),
  userStatus: PlayerStatusSchema,
});
export type KycQueueItemView = z.infer<typeof KycQueueItemView>;

export const KycQueueResponse = page(KycQueueItemView);
export type KycQueueResponse = z.infer<typeof KycQueueResponse>;

/**
 * POST /admin/kyc/:userId/review: approve or reject a pending profile (a
 * reason is required to reject; 409 `kyc_not_pending`, `kyc_underage`).
 */
export const KycReviewRequest = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('approve'), reason: OptionalAuditText }),
  z.object({ decision: z.literal('reject'), reason: AuditText }),
]);
export type KycReviewRequest = z.infer<typeof KycReviewRequest>;

export const KycReviewResponse = z.object({ changed: z.boolean(), profile: KycQueueItemView });
export type KycReviewResponse = z.infer<typeof KycReviewResponse>;

// ---------------------------------------------------------------------------
// Trading (trading.view / .odds / .status / .result / .void).

export const MarketStatusSchema = z.enum(['open', 'suspended', 'closed', 'settled', 'void']);
export type MarketStatus = z.infer<typeof MarketStatusSchema>;

/** GET /admin/trading/events: `q` is a team or competition name, or a Game ID. */
export const TradingEventQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: queryList(EventStatusSchema).optional(),
  sport: z.string().trim().max(32).optional(),
  from: IsoDateTime.optional(),
  to: IsoDateTime.optional(),
  limit: pageLimit(200, 50),
  cursor: Cursor,
});
export type TradingEventQuery = z.infer<typeof TradingEventQuery>;

const tradingEventFields = {
  id: z.string(),
  gameId: z.number().int(),
  sportId: z.string(),
  competition: LocalizedNameSchema,
  homeTeam: LocalizedNameSchema,
  awayTeam: LocalizedNameSchema,
  startTime: z.string(),
  status: EventStatusSchema,
  bettingOpen: z.boolean(),
  liveMinute: z.number().int().nullable(),
  period: z.string().nullable(),
  scoreHome: z.number().int().nullable(),
  scoreAway: z.number().int().nullable(),
  resultedAt: z.string().nullable(),
  /** Open or pending bets with a leg on the event, and their stakes. */
  openBets: z.number().int(),
  openStake: Santim,
};

export const TradingEventSummaryView = z.object({
  ...tradingEventFields,
  markets: z.object({
    total: z.number().int(),
    open: z.number().int(),
    suspended: z.number().int(),
    voided: z.number().int(),
  }),
});
export type TradingEventSummaryView = z.infer<typeof TradingEventSummaryView>;

export const TradingEventListResponse = page(TradingEventSummaryView);
export type TradingEventListResponse = z.infer<typeof TradingEventListResponse>;

export const TradingSelectionView = z.object({
  id: z.string(),
  code: z.string(),
  oddsMilli: z.number().int(),
  status: z.enum(['open', 'suspended', 'settled']),
  result: z.enum(['won', 'lost', 'void']).nullable(),
  /** Set when a trader voided it (it stays void whatever the result). */
  voidedAt: z.string().nullable(),
  openBets: z.number().int(),
  openStake: Santim,
  /** Σ potential gross payouts of those bets. */
  liability: Santim,
});
export type TradingSelectionView = z.infer<typeof TradingSelectionView>;

export const TradingMarketView = z.object({
  id: z.string(),
  key: z.string(),
  type: z.string(),
  line: z.string().nullable(),
  status: MarketStatusSchema,
  suspendedBy: z.enum(['feed', 'trader']).nullable(),
  voidedAt: z.string().nullable(),
  resultedInPlay: z.boolean(),
  selections: z.array(TradingSelectionView),
});
export type TradingMarketView = z.infer<typeof TradingMarketView>;

/** GET /admin/trading/events/:id (404 for an unknown event). */
export const TradingEventView = z.object({
  ...tradingEventFields,
  htScoreHome: z.number().int().nullable(),
  htScoreAway: z.number().int().nullable(),
  markets: z.array(TradingMarketView),
});
export type TradingEventView = z.infer<typeof TradingEventView>;

/** POST /admin/trading/selections/:id/odds (trading.odds). */
export const SetOddsRequest = z.object({ oddsMilli: OddsMilli, reason: OptionalAuditText });
export type SetOddsRequest = z.infer<typeof SetOddsRequest>;

export const SetOddsResponse = z.object({
  changed: z.boolean(),
  selectionId: z.string(),
  previousOddsMilli: z.number().int().nullable(),
  oddsMilli: z.number().int(),
});
export type SetOddsResponse = z.infer<typeof SetOddsResponse>;

/** POST /admin/trading/markets/:id/status (trading.status). Settled and void markets are final (409). */
export const SetMarketStatusRequest = z.object({
  status: z.enum(['open', 'suspended', 'closed']),
  reason: OptionalAuditText,
});
export type SetMarketStatusRequest = z.infer<typeof SetMarketStatusRequest>;

/**
 * POST /admin/trading/events/:id/suspend and …/resume (trading.status):
 * every open market suspended, or every suspended one re-opened.
 */
export const EventSuspendRequest = z.object({ reason: OptionalAuditText });
export type EventSuspendRequest = z.infer<typeof EventSuspendRequest>;

/** POST /admin/trading/events/:id/betting (trading.status): betting on the whole event on or off. */
export const EventBettingRequest = z.object({ open: z.boolean(), reason: OptionalAuditText });
export type EventBettingRequest = z.infer<typeof EventBettingRequest>;

const Goals = z.number().int().min(0).max(999);

/**
 * POST /admin/trading/events/:id/result (trading.result): the first result
 * or a correction (a correction needs a reason: 422
 * `correction_reason_required`; `finished` before kick-off is 409
 * `event_not_started`). Settlement then (re-)settles the bets.
 */
export const ResultEventRequest = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('finished'),
    score: z.object({
      home: Goals,
      away: Goals,
      htHome: Goals.optional(),
      htAway: Goals.optional(),
    }),
    reason: OptionalAuditText,
  }),
  z.object({
    status: z.enum(['cancelled', 'abandoned', 'postponed']),
    reason: OptionalAuditText,
  }),
]);
export type ResultEventRequest = z.infer<typeof ResultEventRequest>;

export const ResultEventResponse = z.object({
  outcome: z.enum(['resulted', 'corrected', 'unchanged']),
  eventId: z.string(),
  status: z.enum(['finished', 'cancelled', 'abandoned', 'postponed']),
  marketsSettled: z.number().int(),
  marketsVoided: z.number().int(),
});
export type ResultEventResponse = z.infer<typeof ResultEventResponse>;

/** POST /admin/trading/markets/:id/void and /admin/trading/selections/:id/void (trading.void). */
export const VoidRequest = z.object({ reason: AuditText });
export type VoidRequest = z.infer<typeof VoidRequest>;

export const VoidResponse = z.object({
  /** 'unchanged' when it was voided before (nothing written). */
  outcome: z.enum(['voided', 'unchanged']),
  eventId: z.string(),
  marketId: z.string(),
  selectionIds: z.array(z.string()),
  marketStatus: MarketStatusSchema,
  /** Bets with a leg on what was voided (settlement re-checks them). */
  affectedBets: z.number().int(),
});
export type VoidResponse = z.infer<typeof VoidResponse>;

// ---------------------------------------------------------------------------
// Bets (bets.view) and risk (risk.view).

/** GET /admin/bets. */
export const StaffBetQuery = z.object({
  shortId: z.string().trim().max(16).optional(),
  userId: Uuid.optional(),
  phone: z.string().trim().max(20).optional(),
  status: queryList(BetStatusSchema).optional(),
  /** Placement window [from, to). */
  from: IsoDateTime.optional(),
  to: IsoDateTime.optional(),
  eventId: Uuid.optional(),
  minStake: QuerySantim.optional(),
  minPotentialPayout: QuerySantim.optional(),
  limit: pageLimit(100, 25),
  cursor: Cursor,
});
export type StaffBetQuery = z.infer<typeof StaffBetQuery>;

export const StaffBetSummaryView = z.object({
  id: z.string(),
  shortId: z.string(),
  userId: z.string(),
  phone: z.string(),
  betType: z.enum(['single', 'multi']),
  status: BetStatusSchema,
  channel: BetChannelSchema,
  stake: Santim,
  totalOddsMilli: z.string(),
  potentialGrossPayout: Santim,
  potentialNetPayout: Santim,
  settledGrossPayout: Santim.nullable(),
  settledTax: Santim.nullable(),
  settledNetPayout: Santim.nullable(),
  legCount: z.number().int(),
  placedAt: z.string(),
  settledAt: z.string().nullable(),
});
export type StaffBetSummaryView = z.infer<typeof StaffBetSummaryView>;

export const StaffBetListResponse = page(StaffBetSummaryView);
export type StaffBetListResponse = z.infer<typeof StaffBetListResponse>;

/** GET /admin/bets/:id: the bet as the player sees it, with the player and its settlement version. */
export const StaffBetDetailView = BetView.extend({
  userId: z.string(),
  phone: z.string(),
  settlementVersion: z.number().int(),
});
export type StaffBetDetailView = z.infer<typeof StaffBetDetailView>;

/** GET /admin/risk/liabilities: largest first, optionally for one event. */
export const LiabilityQuery = z.object({
  eventId: Uuid.optional(),
  minLiability: QuerySantim.optional(),
  limit: pageLimit(500, 50),
});
export type LiabilityQuery = z.infer<typeof LiabilityQuery>;

export const SelectionLiabilityView = z.object({
  selectionId: z.string(),
  code: z.string(),
  oddsMilli: z.number().int(),
  marketId: z.string(),
  marketKey: z.string(),
  marketStatus: MarketStatusSchema,
  eventId: z.string(),
  gameId: z.number().int(),
  homeTeam: LocalizedNameSchema,
  awayTeam: LocalizedNameSchema,
  competition: LocalizedNameSchema,
  startTime: z.string(),
  eventStatus: EventStatusSchema,
  /** Open bets with an open leg on the selection, their stakes and potential gross payouts. */
  bets: z.number().int(),
  stake: Santim,
  liability: Santim,
  singlesStake: Santim,
  singlesLiability: Santim,
});
export type SelectionLiabilityView = z.infer<typeof SelectionLiabilityView>;

export const LiabilityListResponse = z.object({ items: z.array(SelectionLiabilityView) });
export type LiabilityListResponse = z.infer<typeof LiabilityListResponse>;

/** GET /admin/risk/big-bets: open bets over either threshold (defaults 10,000 / 100,000 ETB). */
export const BigBetsQuery = z.object({
  minStake: QuerySantim.optional(),
  minPotentialPayout: QuerySantim.optional(),
  limit: pageLimit(100, 25),
  cursor: Cursor,
});
export type BigBetsQuery = z.infer<typeof BigBetsQuery>;

// ---------------------------------------------------------------------------
// Withdrawals and flagged payments (withdrawals.view / withdrawals.approve).

export const PaymentPlayerView = z.object({
  phone: z.string(),
  fullName: z.string().nullable(),
  status: PlayerStatusSchema,
  kycStatus: KycStatusSchema,
});
export type PaymentPlayerView = z.infer<typeof PaymentPlayerView>;

export const PayoutFlagReasonSchema = z.enum([
  'ambiguous_result',
  'attempts_exhausted',
  'pending_too_long',
  'staff_review',
  'provider_conflict',
]);
export type PayoutFlagReason = z.infer<typeof PayoutFlagReasonSchema>;

/** A withdrawal as finance sees it (flags and staff fields included). */
export const StaffWithdrawalView = z.object({
  /** SMS rail: paid by hand (see payingBy / settledBy and the destination). */
  manual: z.boolean(),
  destination: z
    .object({
      institution: z.string(),
      institutionName: z.string(),
      kind: z.enum(['wallet', 'bank']),
      account: z.string(),
      name: z.string(),
    })
    .nullable(),
  payingBy: z.string().nullable(),
  settledBy: z.string().nullable(),
  settlementReference: z.string().nullable(),
  /** The outgoing SMS proposed as this payout's proof (shown on the settle form). */
  proposedSms: z
    .object({ id: z.string(), reference: z.string().nullable(), receivedAt: z.string() })
    .nullable(),
  id: z.string(),
  userId: z.string(),
  provider: z.string(),
  amount: Santim,
  currency: z.string(),
  phone: z.string(),
  recipientName: z.string(),
  status: WithdrawalStatusSchema,
  reviewReason: z.string().nullable(),
  approvedBy: z.string().nullable(),
  approvedAt: z.string().nullable(),
  closedBy: z.string().nullable(),
  providerRef: z.string().nullable(),
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  failureReason: z.string().nullable(),
  flagReason: PayoutFlagReasonSchema.nullable(),
  flaggedAt: z.string().nullable(),
  requestedAt: z.string(),
  processingAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  player: PaymentPlayerView,
});
export type StaffWithdrawalView = z.infer<typeof StaffWithdrawalView>;

/**
 * GET /admin/withdrawals: the review queue is `status=requested`, the
 * flagged queue `flagged=true` (oldest first unless `order=desc`).
 */
export const StaffWithdrawalQuery = z.object({
  status: queryList(WithdrawalStatusSchema).optional(),
  flagged: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  userId: Uuid.optional(),
  order: z.enum(['asc', 'desc']).default('asc'),
  limit: pageLimit(200, 50),
  cursor: Cursor,
});
export type StaffWithdrawalQuery = z.infer<typeof StaffWithdrawalQuery>;

export const StaffWithdrawalListResponse = page(StaffWithdrawalView);
export type StaffWithdrawalListResponse = z.infer<typeof StaffWithdrawalListResponse>;

/** The result of a withdrawal change: the payout after it, and whether anything changed. */
export const StaffWithdrawalChangeResponse = z.object({
  changed: z.boolean(),
  withdrawal: StaffWithdrawalView,
});
export type StaffWithdrawalChangeResponse = z.infer<typeof StaffWithdrawalChangeResponse>;

/** POST /admin/withdrawals/:id/reject (the hold goes back to the player). */
export const RejectWithdrawalRequest = z.object({ reason: AuditText });
export type RejectWithdrawalRequest = z.infer<typeof RejectWithdrawalRequest>;

/** POST /admin/withdrawals/:id/flag and …/clear-flag. */
export const PayoutNoteRequest = z.object({ note: AuditText });
export type PayoutNoteRequest = z.infer<typeof PayoutNoteRequest>;

/** POST /admin/withdrawals/:id/settle: after checking with the provider (flag it first while processing). */
export const SettlePayoutRequest = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('paid'),
    providerRef: z.string().trim().min(1).max(200).optional(),
  }),
  z.object({ outcome: z.literal('failed'), reason: AuditText }),
]);
export type SettlePayoutRequest = z.infer<typeof SettlePayoutRequest>;

export const StaffDepositView = z.object({
  id: z.string(),
  userId: z.string(),
  provider: z.string(),
  amount: Santim,
  currency: z.string(),
  phone: z.string(),
  status: DepositStatusSchema,
  providerRef: z.string().nullable(),
  failureReason: z.string().nullable(),
  flagReason: z.string().nullable(),
  flaggedAt: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  player: PaymentPlayerView,
});
export type StaffDepositView = z.infer<typeof StaffDepositView>;

/** GET /admin/deposits/flagged. */
export const StaffDepositListResponse = z.object({ items: z.array(StaffDepositView) });
export type StaffDepositListResponse = z.infer<typeof StaffDepositListResponse>;

/** POST /admin/deposits/:id/resolve: `credit` when the provider collected it, else `close`. */
export const ResolveDepositRequest = z.object({
  resolution: z.enum(['credit', 'close']),
  note: AuditText,
});
export type ResolveDepositRequest = z.infer<typeof ResolveDepositRequest>;

// ---------------------------------------------------------------------------
// SMS rail (sms.review, payouts.settle_manual).

export const ReceivedSmsStatusSchema = z.enum([
  'unparsed',
  'unmatched',
  'ambiguous',
  'matched',
  'flagged',
  'ignored_debit',
  'settlement_proposed',
  'settled',
  'credited_by_staff',
  'closed',
]);
export type ReceivedSmsStatus = z.infer<typeof ReceivedSmsStatusSchema>;

export const StaffSmsView = z.object({
  id: z.string(),
  source: z.enum(['gateway', 'simulator', 'receipt']),
  sender: z.string().nullable(),
  rawText: z.string(),
  institution: z.string().nullable(),
  direction: z.enum(['credit', 'debit']).nullable(),
  amount: Santim.nullable(),
  reference: z.string().nullable(),
  counterpartyName: z.string().nullable(),
  counterpartyPhone: z.string().nullable(),
  balance: Santim.nullable(),
  receivedAt: z.string(),
  status: ReceivedSmsStatusSchema,
  statusReason: z.string().nullable(),
  matchedIntentId: z.string().nullable(),
  flaggedIntentId: z.string().nullable(),
  matchedUserId: z.string().nullable(),
  proposedPayoutId: z.string().nullable(),
  receiptStatus: z.enum(['verified', 'rejected', 'indeterminate', 'skipped']).nullable(),
  receiptReason: z.string().nullable(),
  resolvedBy: z.string().nullable(),
  resolvedAt: z.string().nullable(),
});
export type StaffSmsView = z.infer<typeof StaffSmsView>;

/** GET /admin/sms?queue=review (the review queue) or ?status=… (the log, newest first). */
export const StaffSmsQuery = z.object({
  queue: z.enum(['review', 'all']).default('review'),
  status: ReceivedSmsStatusSchema.optional(),
  limit: pageLimit(500, 100),
});
export type StaffSmsQuery = z.infer<typeof StaffSmsQuery>;

export const StaffSmsListResponse = z.object({ items: z.array(StaffSmsView) });
export type StaffSmsListResponse = z.infer<typeof StaffSmsListResponse>;

/** POST /admin/sms/:id/credit: credit what arrived to a player (after checking who paid). */
export const CreditSmsRequest = z.object({ userId: Uuid, note: AuditText });
export type CreditSmsRequest = z.infer<typeof CreditSmsRequest>;

/** POST /admin/sms/:id/close and …/acknowledge-receipt. */
export const SmsNoteRequest = z.object({ note: AuditText });
export type SmsNoteRequest = z.infer<typeof SmsNoteRequest>;

export const StaffSmsChangeResponse = z.object({ sms: StaffSmsView });
export type StaffSmsChangeResponse = z.infer<typeof StaffSmsChangeResponse>;

/** GET /admin/sms/health: the rail at a glance (also on the dashboard). */
export const SmsRailHealthResponse = z.object({
  mode: z.enum(['simulated', 'live']),
  lastGatewaySmsAt: z.string().nullable(),
  reviewQueue: z.number().int(),
  oldestReviewAt: z.string().nullable(),
  receiptAlarms: z.number().int(),
  manualPayoutsOpen: z.number().int(),
  oldestManualPayoutApprovedAt: z.string().nullable(),
  receiptVerify: z.enum(['off', 'audit']),
  receiptBreaker: z.enum(['closed', 'open', 'half_open']).nullable(),
  /**
   * The last balance reconciliation per collection institution (the worker,
   * hourly over 24 hours): `drift` is actual − expected movement; negative
   * means we credited more than arrived (a forged SMS?), positive that SMS
   * went missing (players waiting).
   */
  balance: z.array(
    z.object({
      institution: z.string(),
      checkedAt: z.string(),
      status: z.enum(['consistent', 'drift', 'insufficient_data']),
      drift: Santim.nullable(),
      observations: z.number().int(),
    }),
  ),
});
export type SmsRailHealthResponse = z.infer<typeof SmsRailHealthResponse>;

/** POST /admin/manual-payouts/:id/release: hand a claimed payout back unpaid. */
export const ReleaseManualPayoutRequest = z.object({ note: AuditText });
export type ReleaseManualPayoutRequest = z.infer<typeof ReleaseManualPayoutRequest>;

/**
 * POST /admin/manual-payouts/:id/settle: the claimer sent the money. Either
 * the outgoing SMS proposed for it (`smsId`) or the transfer reference the
 * banking app showed. Bank payouts need `holderNameConfirmed` (the bank
 * showed the player's own name as the holder).
 */
export const SettleManualPayoutRequest = z
  .object({
    smsId: Uuid.optional(),
    reference: z.string().trim().min(6).max(40).optional(),
    holderNameConfirmed: z.boolean().default(false),
  })
  .refine((v) => v.smsId !== undefined || v.reference !== undefined, {
    message: 'give the proposed SMS or the transfer reference',
  });
export type SettleManualPayoutRequest = z.infer<typeof SettleManualPayoutRequest>;

/** POST /admin/manual-payouts/:id/fail: the transfer did not go out (the hold goes back). */
export const FailManualPayoutRequest = z.object({ reason: AuditText });
export type FailManualPayoutRequest = z.infer<typeof FailManualPayoutRequest>;

// ---------------------------------------------------------------------------
// Jackpots (jackpots.view / jackpots.manage).

/** GET /admin/jackpots/rounds: the latest closing first. */
export const StaffJackpotRoundQuery = z.object({
  status: queryList(JackpotRoundStatusSchema).optional(),
  template: JackpotTemplateCodeSchema.optional(),
  limit: pageLimit(100, 25),
  cursor: Cursor,
});
export type StaffJackpotRoundQuery = z.infer<typeof StaffJackpotRoundQuery>;

export const StaffJackpotRoundView = JackpotRoundView.extend({
  entries: z.number().int(),
  stakes: Santim,
  openEntries: z.number().int(),
  /** The stored decision, also while entries are still being paid or refunded. */
  decision: JackpotSettlementView.nullable(),
});
export type StaffJackpotRoundView = z.infer<typeof StaffJackpotRoundView>;

export const StaffJackpotRoundListResponse = page(StaffJackpotRoundView);
export type StaffJackpotRoundListResponse = z.infer<typeof StaffJackpotRoundListResponse>;

/** GET /admin/jackpots/rounds/:id/entries: oldest first. */
export const StaffJackpotEntryQuery = z.object({
  limit: pageLimit(200, 50),
  cursor: Cursor,
});
export type StaffJackpotEntryQuery = z.infer<typeof StaffJackpotEntryQuery>;

export const StaffJackpotEntryView = z.object({
  id: z.string(),
  roundId: z.string(),
  userId: z.string(),
  phone: z.string(),
  status: JackpotEntryStatusSchema,
  channel: z.string(),
  picks: z.array(z.array(JackpotOutcomeSchema)),
  combinations: z.number().int(),
  cost: Santim,
  bestCorrect: z.number().int().nullable(),
  prizeGross: Santim.nullable(),
  prizeTax: Santim.nullable(),
  prizeNet: Santim.nullable(),
  placedAt: z.string(),
  settledAt: z.string().nullable(),
});
export type StaffJackpotEntryView = z.infer<typeof StaffJackpotEntryView>;

export const StaffJackpotEntryListResponse = page(StaffJackpotEntryView);
export type StaffJackpotEntryListResponse = z.infer<typeof StaffJackpotEntryListResponse>;

/**
 * POST /admin/jackpots/rounds/:id/cancel (jackpots.manage): before the
 * first kick-off only (409 `jackpot_round_not_cancellable`); every entry is
 * refunded in full by the jackpot settlement.
 */
export const CancelJackpotRoundRequest = z.object({ reason: AuditText });
export type CancelJackpotRoundRequest = z.infer<typeof CancelJackpotRoundRequest>;

export const CancelJackpotRoundResponse = z.object({
  outcome: z.enum(['cancelled', 'unchanged']),
  /** `cancelled` at once without entries; `closed` until the refunds are posted. */
  status: z.enum(['closed', 'cancelled']),
  entries: z.number().int(),
  refunds: Santim,
});
export type CancelJackpotRoundResponse = z.infer<typeof CancelJackpotRoundResponse>;

// ---------------------------------------------------------------------------
// Settings (settings.view / settings.edit).

const Bps = z.number().int().min(0).max(10_000);
const PositiveSantimText = Santim.refine((value) => /^[1-9]\d*$/.test(value), {
  message: 'must be a positive amount of santim',
});
const NonNegativeSantimText = Santim.refine((value) => /^\d+$/.test(value), {
  message: 'must not be negative',
});

export const BetRulesView = z.object({
  minStake: PositiveSantimText,
  maxStake: PositiveSantimText,
  maxPayout: PositiveSantimText,
  maxLegs: z.number().int().min(1).max(100),
  minLegOddsMilli: OddsMilli,
  /** Integer milli as a string (it can exceed 2^53). */
  maxTotalOddsMilli: z.string().regex(/^\d+$/),
});
export type BetRulesView = z.infer<typeof BetRulesView>;

export const TaxView = z.object({
  rateBps: Bps,
  base: z.enum(['net_winnings', 'gross_payout']),
  exemptBelow: NonNegativeSantimText,
});
export type TaxView = z.infer<typeof TaxView>;

export const CashOutSettingsView = z.object({
  enabled: z.boolean(),
  marginBps: Bps,
  minOffer: NonNegativeSantimText,
});
export type CashOutSettingsView = z.infer<typeof CashOutSettingsView>;

export const ResponsibleGamblingView = z.object({
  /** At least 21 (the legal minimum). */
  minAge: z.number().int().min(21).max(100),
});
export type ResponsibleGamblingView = z.infer<typeof ResponsibleGamblingView>;

export const PaymentRulesView = z.object({
  minDeposit: PositiveSantimText,
  maxDeposit: PositiveSantimText,
  minWithdrawal: PositiveSantimText,
  maxWithdrawal: PositiveSantimText,
  dailyWithdrawalCap: PositiveSantimText,
  /** Withdrawals below this are approved without staff (0 = every one is reviewed). */
  autoApproveBelow: NonNegativeSantimText,
  wageringMultiplierBps: z.number().int().min(0).max(1_000_000),
  depositIntentTtlMinutes: z.number().int().min(1).max(10_080),
  payoutMaxAttempts: z.number().int().min(1).max(100),
});
export type PaymentRulesView = z.infer<typeof PaymentRulesView>;

/**
 * House liability caps (rule L1), checked when a bet is placed. A cap is a positive amount of
 * santim, or null for no cap. The selection cap cannot exceed the match cap.
 */
export const RiskLimitsView = z
  .object({
    maxSelectionLiability: PositiveSantimText.nullable(),
    maxEventLiability: PositiveSantimText.nullable(),
  })
  .refine(
    (limits) =>
      // Zod runs this even when a field failed its own check: compare only clean digits.
      typeof limits.maxSelectionLiability !== 'string' ||
      typeof limits.maxEventLiability !== 'string' ||
      !/^\d+$/.test(limits.maxSelectionLiability) ||
      !/^\d+$/.test(limits.maxEventLiability) ||
      BigInt(limits.maxSelectionLiability) <= BigInt(limits.maxEventLiability),
    { message: 'maxSelectionLiability must not exceed maxEventLiability' },
  );
export type RiskLimitsView = z.infer<typeof RiskLimitsView>;

/**
 * Margins and limits per market family (plan task 2.5): the margin of each class of factory market
 * and of single families (a factory-only market type such as `htft`), in basis points 0..10000;
 * the factory selections' share of the selection liability cap (bps); and the weekly family job's
 * floor of settled stakes a week (santim). The server checks the family names.
 */
export const MarketFamiliesView = z
  .object({
    marginBps: z.object({ main: Bps, derivative: Bps, long: Bps }).strict(),
    typeMarginBps: z.record(z.string().min(1).max(64), Bps),
    factoryLiabilityShareBps: Bps,
    minWeeklyStake: NonNegativeSantimText,
    /** Plan item P-5: first-half share of goals for factory pricing (0.3..0.7); null is off. */
    firstHalfShare: z.number().min(0.3).max(0.7).nullable().optional(),
    /** Plan item P-4: Dixon-Coles rho of the factory's full-time grid (-0.2..0); null is off. */
    drawCorrection: z.number().min(-0.2).max(0).nullable().optional(),
  })
  .strict();
export type MarketFamiliesView = z.infer<typeof MarketFamiliesView>;

/**
 * One market family with the weekly job's state (task A12): `marginBps` is what it is priced at now
 * (its override or its class's; a returned family's raised margin); `history` the stored history
 * test's line for it, if any.
 */
export const MarketFamilyRow = z.object({
  family: z.string(),
  marginClass: z.enum(['main', 'derivative', 'long']),
  status: z.enum(['active', 'suspended', 'off']),
  sinceWeek: z.string().nullable(),
  raisedMarginBps: Bps.nullable(),
  marginBps: Bps,
  history: z
    .object({ suggestedMarginBps: Bps, holdBps: z.number().int(), passed: z.boolean() })
    .nullable(),
});
export type MarketFamilyRow = z.infer<typeof MarketFamilyRow>;

export const MarketFamilyStatesResponse = z.object({
  families: z.array(MarketFamilyRow),
  /** When the stored history test ran (`eval families --write`), or null. */
  historyTestedAt: z.string().nullable(),
  firstHalfShare: z.number().nullable(),
  drawCorrection: z.number().nullable(),
});
export type MarketFamilyStatesResponse = z.infer<typeof MarketFamilyStatesResponse>;

/** A person puts a suspended or off family back in play; the reason is audited. */
export const ResetMarketFamilyRequest = z
  .object({ reason: z.string().trim().min(3).max(500) })
  .strict();
export type ResetMarketFamilyRequest = z.infer<typeof ResetMarketFamilyRequest>;

export const ResetMarketFamilyResponse = z.object({ family: MarketFamilyRow });
export type ResetMarketFamilyResponse = z.infer<typeof ResetMarketFamilyResponse>;

/** Every business setting in force (santim as strings). */
export const GameSettingsView = z.object({
  betRules: BetRulesView,
  multiBonus: MultiBonusView,
  tax: TaxView,
  cashOut: CashOutSettingsView,
  liveBetDelayMs: z.number().int().min(0).max(60_000),
  responsibleGambling: ResponsibleGamblingView,
  jackpots: z.object({ daily9: JackpotTemplateView, weekly13: JackpotTemplateView }),
  payments: PaymentRulesView,
  riskLimits: RiskLimitsView,
  marketFamilies: MarketFamiliesView,
});
export type GameSettingsView = z.infer<typeof GameSettingsView>;

/** GET /admin/settings, and the answer of PUT /admin/settings/:key. */
export const StaffSettingsResponse = z.object({
  settings: GameSettingsView,
  /** When each stored setting last changed, and by whom (a staff id, 'seed' or 'system'). */
  changes: z.array(
    z.object({ key: z.string(), updatedAt: z.string(), updatedBy: z.string().nullable() }),
  ),
});
export type StaffSettingsResponse = z.infer<typeof StaffSettingsResponse>;

export const StaffSettingKeySchema = z.enum([
  'bet_rules',
  'tax',
  'cash_out',
  'live_bet_delay_ms',
  'responsible_gambling',
  'payments',
  'risk_limits',
  'market_families',
  'multi_bonus',
  'jackpot_template',
]);
export type StaffSettingKey = z.infer<typeof StaffSettingKeySchema>;

/**
 * The value each key of PUT /admin/settings/:key takes (body `{ value }`;
 * `jackpot_template` names its template in `value.code`). The server
 * validates again (422 `invalid_setting`, details { key, issues }).
 */
export const STAFF_SETTING_VALUE_SCHEMAS = {
  bet_rules: BetRulesView,
  tax: TaxView,
  cash_out: CashOutSettingsView,
  live_bet_delay_ms: z.number().int().min(0).max(60_000),
  responsible_gambling: ResponsibleGamblingView,
  payments: PaymentRulesView,
  risk_limits: RiskLimitsView,
  market_families: MarketFamiliesView,
  multi_bonus: MultiBonusView,
  jackpot_template: JackpotTemplateView,
} as const satisfies Record<StaffSettingKey, z.ZodType>;

/** Body of PUT /admin/settings/:key (the value is checked against STAFF_SETTING_VALUE_SCHEMAS[key]). */
export const UpdateSettingRequest = z.object({ value: z.unknown() });
export type UpdateSettingRequest = z.infer<typeof UpdateSettingRequest>;

// ---------------------------------------------------------------------------
// Audit log (audit.view).

export const ActorTypeSchema = z.enum(['user', 'admin', 'system']);

/** GET /admin/audit: newest first; `action` is exact or a prefix ending in '.' or '*'. */
export const AuditLogQuery = z.object({
  actorType: ActorTypeSchema.optional(),
  actorId: z.string().trim().max(100).optional(),
  action: z.string().trim().max(100).optional(),
  targetType: z.string().trim().max(50).optional(),
  targetId: z.string().trim().max(100).optional(),
  from: IsoDateTime.optional(),
  to: IsoDateTime.optional(),
  limit: pageLimit(200, 50),
  cursor: Cursor,
});
export type AuditLogQuery = z.infer<typeof AuditLogQuery>;

export const AuditLogEntryView = z.object({
  id: z.string(),
  actorType: ActorTypeSchema,
  actorId: z.string().nullable(),
  /** For staff actors. */
  actorEmail: z.string().nullable(),
  actorName: z.string().nullable(),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  metadata: z.unknown(),
  ip: z.string().nullable(),
  createdAt: z.string(),
});
export type AuditLogEntryView = z.infer<typeof AuditLogEntryView>;

export const AuditLogResponse = page(AuditLogEntryView);
export type AuditLogResponse = z.infer<typeof AuditLogResponse>;

// ---------------------------------------------------------------------------
// Staff accounts (staff.manage).

export const StaffUserView = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  role: StaffRoleSchema,
  disabledAt: z.string().nullable(),
  lastLoginAt: z.string().nullable(),
  lockedUntil: z.string().nullable(),
  failedLoginAttempts: z.number().int(),
  totpEnrolledAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type StaffUserView = z.infer<typeof StaffUserView>;

export const StaffListResponse = z.object({ items: z.array(StaffUserView) });
export type StaffListResponse = z.infer<typeof StaffListResponse>;

/** POST /admin/staff: without a password one is generated and returned once. */
export const CreateStaffRequest = z.object({
  email: z.email().max(254),
  displayName: z.string().trim().min(1).max(100),
  role: StaffRoleSchema,
  password: z.string().min(12).max(128).optional(),
});
export type CreateStaffRequest = z.infer<typeof CreateStaffRequest>;

/** A TOTP secret to enrol (shown once): type `secret` in, or render `uri` as a QR code. */
export const TotpEnrolmentView = z.object({ secret: z.string(), uri: z.string() });
export type TotpEnrolmentView = z.infer<typeof TotpEnrolmentView>;

export const CreateStaffResponse = z.object({
  user: StaffUserView,
  generatedPassword: z.string().nullable(),
  totp: TotpEnrolmentView,
});
export type CreateStaffResponse = z.infer<typeof CreateStaffResponse>;

/** PATCH /admin/staff/:id: a role change ends the account's sessions (409 `last_admin`). */
export const UpdateStaffRequest = z
  .object({
    role: StaffRoleSchema.optional(),
    displayName: z.string().trim().min(1).max(100).optional(),
  })
  .refine((value) => value.role !== undefined || value.displayName !== undefined, {
    message: 'change the role or the display name',
  });
export type UpdateStaffRequest = z.infer<typeof UpdateStaffRequest>;

/** POST /admin/staff/:id/reset-password (ends the account's sessions). */
export const ResetStaffPasswordRequest = z.object({ password: z.string().min(12).max(128) });
export type ResetStaffPasswordRequest = z.infer<typeof ResetStaffPasswordRequest>;
