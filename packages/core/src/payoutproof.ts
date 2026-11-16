import type { Santim } from './money';
import { payoutDestination } from './paymentmethods';
import { normalizeEthiopianMsisdn } from './phone';
import { compareReceiptAccount, RECEIPT_ACCOUNT_MIN_REVEALED } from './receiptaccount';

/**
 * Settling a claimed manual payout on double proof (design:
 * docs/plans/c2-double-proof-design.md, section 3). The worker may record a
 * telebirr wallet payout as paid only when two independent proofs agree:
 * the debit SMS the collection handset forwarded, and the institution's own
 * receipt page for the same transaction reference. The operator who claimed
 * the payout still sends the money; the settlement is recorded under them.
 *
 * Pure and total: no I/O, never throws, the same input always gives the same
 * decision, and the input is never mutated. Every check is a positive
 * assertion: each one must explicitly return `pass`, and a missing, null,
 * empty, mistyped or unreadable value never does. Amounts are compared as
 * exact `bigint` santim.
 */

export const DOUBLE_PROOF_RULE_VERSION = 1;
export const AUTO_SETTLE_ACTOR = 'system:double_proof';

/** The receipt shows the time to the minute; the SMS time (when present) must agree within this. */
export const DOUBLE_PROOF_TIME_AGREEMENT_MS = 2 * 60_000;

/**
 * How far the institution's clock may differ from ours (T1's `claim⁻`, T2).
 * The same 5 minutes as `SMS_INSTITUTION_CLOCK_SKEW_MS` in smsmatch.ts, but
 * deliberately its own constant: widening the deposit matcher's tolerance
 * must not silently widen what may settle a payout.
 */
export const DOUBLE_PROOF_CLOCK_SKEW_MS = 5 * 60_000;

export interface ProofPayout {
  id: string;
  manual: boolean;
  /** Must be 'sms'. */
  provider: string;
  /** Must be 'processing'. */
  status: string;
  amount: Santim;
  /** payouts.destination_institution */
  destinationInstitution: string;
  /** E.164 for wallets (copied at request time). */
  destinationAccount: string;
  /** users.phone now (CLAUDE.md: the currently registered wallet). */
  playerCurrentPhone: string | null;
  approvedBy: string | null;
  /** The claimer. */
  payingBy: string | null;
  /** payouts.processing_at (reset on every claim). */
  claimedAt: Date | null;
  /** amlHoldsWithdrawals(user) */
  amlHold: boolean;
  /** Any of the player's credited SMS with receipt_status 'rejected', unresolved. */
  openReceiptAlarm: boolean;
  /** Another payout has settlement_reference = sms.reference. */
  referenceSettledElsewhere: boolean;
}

export interface ProofSms {
  id: string;
  /** Must be 'gateway'. */
  source: string;
  institution: string | null;
  direction: 'credit' | 'debit' | null;
  amount: Santim | null;
  reference: string | null;
  /** E.164 parsed from the SMS. */
  counterpartyPhone: string | null;
  /** The institution's time in the SMS. */
  occurredAt: Date | null;
  /** OUR server clock (received_sms.received_at). */
  receivedAt: Date;
  /** Must be 'settlement_proposed'. */
  status: string;
  /** Must be payout.id. */
  proposedPayoutId: string | null;
}

export interface DebitReceiptFacts {
  reference: string | null;
  /** The labelled transferred amount, NOT "any figure on the page". */
  principalAmount: Santim | null;
  /** Possibly masked. */
  payerAccount: string | null;
  /** Possibly masked. */
  receiverAccount: string | null;
  completed: boolean | null;
  /** Minute precision, EAT. */
  occurredAt: Date | null;
}

export type DebitReceiptResult =
  | {
      status: 'verified' | 'rejected';
      reason: string | null;
      facts: DebitReceiptFacts;
      fetchedAt: Date;
    }
  /** telebirr's "This request is not correct" page. */
  | { status: 'not_found'; fetchedAt: Date }
  | {
      status: 'indeterminate';
      reason: 'unparseable' | 'unavailable' | 'timeout' | 'breaker_open';
      fetchedAt: Date;
    }
  | { status: 'skipped'; fetchedAt: Date };

export interface ProofPolicy {
  /** PAYOUT_AUTO_SETTLE_INSTITUTIONS, ['telebirr']. */
  institutions: readonly string[];
  /** Ours at payout.destinationInstitution. */
  collectionAccounts: readonly string[];
  maxPerPayout: Santim;
  /** Daily cap minus today's auto-settled total (EAT day), read under lock. */
  remainingToday: Santim;
  /** Per-operator daily cap, same. */
  remainingTodayForClaimer: Santim;
  /** Claim → SMS received, default 4 h. */
  windowMs: number;
  /** Default 5 min. */
  maxReceiptAgeMs: number;
  /** Default 15 min: the page may lag a fresh transfer. */
  notFoundGraceMs: number;
  /**
   * Default 6, set from the real fixture. Counted in the last eight digits
   * (the prefix and the network digit 9 or 7 reveal nothing); never below 4.
   * A mask that shows the first four and the last four characters
   * (`2519****4426`) reveals four, so it can never satisfy 6.
   */
  minRevealedDestinationDigits: number;
}

/** Reasons to leave the payout to a person or to look again later. */
export type WaitCode =
  | 'not_manual'
  | 'institution_not_allowed'
  | 'over_payout_cap'
  | 'over_daily_cap'
  | 'player_on_hold'
  | 'destination_not_current_phone'
  | 'not_processing'
  | 'sms_not_proposed'
  | 'sms_not_from_gateway'
  | 'sms_without_destination'
  | 'sms_before_claim'
  | 'outside_window'
  | 'receipt_indeterminate'
  | 'receipt_unsupported'
  | 'receipt_not_found_yet'
  | 'receipt_stale'
  | 'receipt_status_unreadable'
  | 'receipt_reference_unreadable'
  | 'receipt_amount_unreadable'
  | 'payer_unreadable'
  | 'receiver_unreadable'
  | 'receipt_time_unreadable';

/** `receipt_<reason>` for a receipt the verifier rejected (`receipt_rejected` without a usable reason). */
export type ReceiptRejectedCode = `receipt_${string}`;

/** Reasons the two proofs (or the payout and its proofs) disagree: alarm, never settle. */
export type MismatchCode =
  | 'four_eyes_violation'
  | 'sms_not_debit'
  | 'sms_institution_differs'
  | 'sms_destination_differs'
  | 'sms_amount_differs'
  | 'receipt_not_found'
  | 'receipt_not_completed'
  | 'reference_differs'
  | 'receipt_amount_differs'
  | 'payer_not_ours'
  | 'receiver_differs'
  | 'transfer_before_claim'
  | 'sms_precedes_transfer'
  | 'times_disagree'
  | 'reference_already_used'
  | ReceiptRejectedCode;

export interface ProofWait {
  code: WaitCode;
  /** false: hand to a human, stop checking. */
  retry: boolean;
}

export type ProofDecision =
  | { decision: 'settle'; ruleVersion: number; settledBy: string }
  | { decision: 'wait'; reasons: ProofWait[]; ruleVersion: number }
  | { decision: 'mismatch'; reasons: MismatchCode[]; ruleVersion: number };

export interface DoubleProofInput {
  payout: ProofPayout;
  sms: ProofSms;
  receipt: DebitReceiptResult;
  policy: ProofPolicy;
  now: Date;
}

/** Whether a wait is worth checking again (true) or is handed to a person (false). */
export const DOUBLE_PROOF_WAIT_RETRY: Readonly<Record<WaitCode, boolean>> = {
  not_manual: false,
  institution_not_allowed: false,
  over_payout_cap: false,
  over_daily_cap: false,
  player_on_hold: false,
  destination_not_current_phone: false,
  not_processing: false,
  sms_not_proposed: false,
  sms_not_from_gateway: false,
  sms_without_destination: false,
  sms_before_claim: false,
  outside_window: false,
  receipt_indeterminate: true,
  receipt_unsupported: false,
  receipt_not_found_yet: true,
  receipt_stale: true,
  receipt_status_unreadable: true,
  receipt_reference_unreadable: true,
  receipt_amount_unreadable: true,
  payer_unreadable: true,
  receiver_unreadable: false,
  receipt_time_unreadable: false,
};

const MINUTE_MS = 60_000;

/**
 * The earliest the receipt may say the transfer happened (`claim⁻`): the
 * claim time floored to the minute (the receipt shows minutes only), less
 * the institution's clock skew. Null for an absent or invalid time.
 */
export function doubleProofEarliestTransfer(claimedAt: Date | null): Date | null {
  const claim = timeOf(claimedAt);
  if (claim === null) return null;
  return new Date(Math.floor(claim / MINUTE_MS) * MINUTE_MS - DOUBLE_PROOF_CLOCK_SKEW_MS);
}

type Verdict =
  { kind: 'pass' } | { kind: 'wait'; code: WaitCode } | { kind: 'mismatch'; code: MismatchCode };

const PASS: Verdict = { kind: 'pass' };
const wait = (code: WaitCode): Verdict => ({ kind: 'wait', code });
const mismatch = (code: MismatchCode): Verdict => ({ kind: 'mismatch', code });

/** An object's own fields, or none: a deleted or non-object input reads as all-absent. */
function fieldsOf<T>(value: unknown): Partial<T> {
  return typeof value === 'object' && value !== null ? value : {};
}

/** A non-blank string, else null. */
function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function santimOf(value: unknown): bigint | null {
  return typeof value === 'bigint' ? value : null;
}

/** Milliseconds of a valid Date, else null. */
function timeOf(value: unknown): number | null {
  if (!(value instanceof Date)) return null;
  const ms = value.getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** A finite, non-negative duration, else null. */
function durationOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function textListOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => textOf(v) !== null) : [];
}

const REJECTION_REASON = /^[a-z][a-z0-9_]{0,47}$/;

function rejectedCode(reason: unknown): ReceiptRejectedCode {
  return typeof reason === 'string' && REJECTION_REASON.test(reason)
    ? `receipt_${reason}`
    : 'receipt_rejected';
}

/**
 * Decides whether a claimed manual payout may be settled on its two proofs.
 *
 * Every check runs and reasons are collected. Any mismatch → `mismatch` (all
 * mismatch reasons); else any wait → `wait`; else `settle`, recorded under
 * the claimer (`payout.payingBy`). A value one check needs that another
 * check owns (the claim time, the SMS receive time, the payout's amount or
 * destination) reports the owning check's reason, so a released payout or
 * a malformed row reads as a wait, not as a forgery alarm.
 */
export function decideDoubleProof(input: DoubleProofInput): ProofDecision {
  const given = fieldsOf<DoubleProofInput>(input);
  const payout = fieldsOf<ProofPayout>(given.payout);
  const sms = fieldsOf<ProofSms>(given.sms);
  const receipt = fieldsOf<{
    status: string;
    reason: string | null;
    facts: DebitReceiptFacts;
    fetchedAt: Date;
  }>(given.receipt);
  const policy = fieldsOf<ProofPolicy>(given.policy);

  const now = timeOf(given.now);
  const payoutId = textOf(payout.id);
  const amount = santimOf(payout.amount);
  const institution = textOf(payout.destinationInstitution);
  const destination = textOf(payout.destinationAccount);
  const payingBy = textOf(payout.payingBy);
  const approvedBy = textOf(payout.approvedBy);
  const claimedAt = timeOf(payout.claimedAt);
  const receivedAt = timeOf(sms.receivedAt);

  // E1 Manual SMS-rail payout.
  const e1 = payout.manual === true && payout.provider === 'sms' ? PASS : wait('not_manual');

  // E2 Institution allowlisted, wallet kind.
  const e2 =
    institution !== null &&
    textListOf(policy.institutions).includes(institution) &&
    payoutDestination(institution)?.kind === 'wallet'
      ? PASS
      : wait('institution_not_allowed');

  // E3 Per-payout cap (and a positive amount: nothing to settle otherwise).
  const maxPerPayout = santimOf(policy.maxPerPayout);
  const e3 =
    amount !== null && maxPerPayout !== null && amount > 0n && amount <= maxPerPayout
      ? PASS
      : wait('over_payout_cap');

  // E4 Daily caps.
  const remainingToday = santimOf(policy.remainingToday);
  const remainingForClaimer = santimOf(policy.remainingTodayForClaimer);
  const e4 =
    amount !== null &&
    remainingToday !== null &&
    remainingForClaimer !== null &&
    amount <= remainingToday &&
    amount <= remainingForClaimer
      ? PASS
      : wait('over_daily_cap');

  // E5 No hold on the player.
  const e5 =
    payout.amlHold === false && payout.openReceiptAlarm === false ? PASS : wait('player_on_hold');

  // E6 Destination is the player's current phone (and a canonical E.164 wallet number).
  const e6 =
    destination !== null &&
    destination === textOf(payout.playerCurrentPhone) &&
    normalizeEthiopianMsisdn(destination) === destination
      ? PASS
      : wait('destination_not_current_phone');

  // S1 Payout is claimed.
  const s1 =
    payout.status === 'processing' && payingBy !== null && claimedAt !== null
      ? PASS
      : wait('not_processing');

  // S2 Four eyes: the claimer is a person who did not approve it, and someone approved it.
  let s2: Verdict;
  if (payingBy === null) s2 = wait('not_processing');
  else if (approvedBy === null || payingBy === approvedBy || payingBy.startsWith('system:')) {
    s2 = mismatch('four_eyes_violation');
  } else s2 = PASS;

  // S3 SMS is the live proposal for this payout.
  const s3 =
    sms.status === 'settlement_proposed' &&
    textOf(sms.id) !== null &&
    payoutId !== null &&
    sms.proposedPayoutId === payoutId
      ? PASS
      : wait('sms_not_proposed');

  // P1 SMS came from the handset.
  const p1 = sms.source === 'gateway' ? PASS : wait('sms_not_from_gateway');

  // P2 SMS is a debit of the same institution.
  const p2Debit = sms.direction === 'debit' ? PASS : mismatch('sms_not_debit');
  let p2Institution: Verdict;
  if (institution === null) p2Institution = wait('institution_not_allowed');
  else if (textOf(sms.institution) === institution) p2Institution = PASS;
  else p2Institution = mismatch('sms_institution_differs');

  // P3 SMS names the destination in full; P4 it is the payout's destination.
  const counterparty = textOf(sms.counterpartyPhone);
  let p34: Verdict;
  if (counterparty === null) p34 = wait('sms_without_destination');
  else if (destination === null) p34 = wait('destination_not_current_phone');
  else if (counterparty === destination) p34 = PASS;
  else p34 = mismatch('sms_destination_differs');

  // P5 SMS amount, exact santim.
  const smsAmount = santimOf(sms.amount);
  let p5: Verdict;
  if (amount === null) p5 = wait('over_payout_cap');
  else if (smsAmount !== null && smsAmount === amount) p5 = PASS;
  else p5 = mismatch('sms_amount_differs');

  // P6 SMS received after this claim (our clock).
  let p6: Verdict;
  if (claimedAt === null) p6 = wait('not_processing');
  else if (receivedAt !== null && receivedAt > claimedAt) p6 = PASS;
  else p6 = wait('sms_before_claim');

  // P7 Within the window.
  const windowMs = durationOf(policy.windowMs);
  let p7: Verdict;
  if (claimedAt === null) p7 = wait('not_processing');
  else if (receivedAt === null) p7 = wait('sms_before_claim');
  else if (windowMs !== null && receivedAt - claimedAt <= windowMs) p7 = PASS;
  else p7 = wait('outside_window');

  // R1 Receipt fetched and verified.
  let r1: Verdict;
  switch (receipt.status) {
    case 'verified':
      r1 = PASS;
      break;
    case 'rejected':
      r1 = mismatch(rejectedCode(receipt.reason));
      break;
    case 'not_found': {
      const grace = durationOf(policy.notFoundGraceMs);
      if (now === null || receivedAt === null || grace === null) {
        r1 = wait('receipt_not_found_yet');
      } else {
        r1 =
          now - receivedAt < grace ? wait('receipt_not_found_yet') : mismatch('receipt_not_found');
      }
      break;
    }
    case 'skipped':
      r1 = wait('receipt_unsupported');
      break;
    default:
      // 'indeterminate', and any status this version does not know.
      r1 = wait('receipt_indeterminate');
  }

  // R2 Receipt fresh: fetched no later than now and no longer ago than the
  // policy allows. An age below zero (a fetch time in our future) is not a
  // fresh receipt but a clock or caller error, so it waits too: the caller
  // must take `now` and `fetchedAt` from the same clock.
  const fetchedAt = timeOf(receipt.fetchedAt);
  const maxReceiptAge = durationOf(policy.maxReceiptAgeMs);
  const receiptAge = now !== null && fetchedAt !== null ? now - fetchedAt : null;
  const r2 =
    receiptAge !== null && maxReceiptAge !== null && receiptAge >= 0 && receiptAge <= maxReceiptAge
      ? PASS
      : wait('receipt_stale');

  // R3–T3 read the receipt's facts, which only a verified or rejected receipt carries.
  const hasFacts = receipt.status === 'verified' || receipt.status === 'rejected';
  const facts = fieldsOf<DebitReceiptFacts>(hasFacts ? receipt.facts : undefined);
  const factCheck = (check: () => Verdict): Verdict => (hasFacts ? check() : r1);

  // R3 Completed.
  const r3 = factCheck(() => {
    if (facts.completed === true) return PASS;
    if (facts.completed === false) return mismatch('receipt_not_completed');
    return wait('receipt_status_unreadable');
  });

  // R4 Same transaction reference on both proofs.
  const r4 = factCheck(() => {
    const receiptReference = textOf(facts.reference);
    if (receiptReference === null) return wait('receipt_reference_unreadable');
    return receiptReference === textOf(sms.reference) ? PASS : mismatch('reference_differs');
  });

  // R5 Receipt amount, exact santim.
  const r5 = factCheck(() => {
    const principal = santimOf(facts.principalAmount);
    if (principal === null) return wait('receipt_amount_unreadable');
    if (amount === null) return wait('over_payout_cap');
    return principal === amount ? PASS : mismatch('receipt_amount_differs');
  });

  // R6 Payer is OUR collection account. Revealed digits are counted in the
  // last eight digits only (as for R7): `251******111` and `2519*****111`
  // name any number ending in 111, so they are too masked to say the money
  // left from us.
  const r6 = factCheck(() => {
    const results = textListOf(policy.collectionAccounts).map((account) =>
      compareReceiptAccount(facts.payerAccount, account, { subscriberDigitsOnly: true }),
    );
    if (results.includes('match')) return PASS;
    if (textOf(facts.payerAccount) === null || results.includes('unreadable')) {
      return wait('payer_unreadable');
    }
    return mismatch('payer_not_ours');
  });

  // R7 Receiver is the payout's destination, revealing enough of the subscriber number.
  const r7 = factCheck(() => {
    if (destination === null) return wait('destination_not_current_phone');
    const minRevealed = policy.minRevealedDestinationDigits;
    if (typeof minRevealed !== 'number' || !Number.isInteger(minRevealed)) {
      return wait('receiver_unreadable');
    }
    const result = compareReceiptAccount(facts.receiverAccount, destination, {
      minRevealed: Math.max(minRevealed, RECEIPT_ACCOUNT_MIN_REVEALED),
      subscriberDigitsOnly: true,
    });
    if (result === 'match') return PASS;
    return result === 'unreadable' ? wait('receiver_unreadable') : mismatch('receiver_differs');
  });

  const transferAt = timeOf(facts.occurredAt);

  // T1 Transfer after the claim.
  const t1 = factCheck(() => {
    if (transferAt === null) return wait('receipt_time_unreadable');
    const earliest = doubleProofEarliestTransfer(payout.claimedAt ?? null);
    if (claimedAt === null || earliest === null) return wait('not_processing');
    return transferAt >= earliest.getTime() ? PASS : mismatch('transfer_before_claim');
  });

  // T2 SMS not received before the transfer happened.
  const t2 = factCheck(() => {
    if (transferAt === null) return wait('receipt_time_unreadable');
    if (receivedAt === null) return wait('sms_before_claim');
    return transferAt <= receivedAt + DOUBLE_PROOF_CLOCK_SKEW_MS
      ? PASS
      : mismatch('sms_precedes_transfer');
  });

  // T3 SMS time agrees with the receipt, when the SMS carries one (exactly null = it carries none).
  const t3 = factCheck(() => {
    if (sms.occurredAt === null) return PASS;
    const smsAt = timeOf(sms.occurredAt);
    if (smsAt === null) return mismatch('times_disagree');
    if (transferAt === null) return wait('receipt_time_unreadable');
    return Math.abs(smsAt - transferAt) <= DOUBLE_PROOF_TIME_AGREEMENT_MS
      ? PASS
      : mismatch('times_disagree');
  });

  // U1 Reference used once.
  const u1 = payout.referenceSettledElsewhere === false ? PASS : mismatch('reference_already_used');

  const verdicts: readonly Verdict[] = [
    e1,
    e2,
    e3,
    e4,
    e5,
    e6,
    s1,
    s2,
    s3,
    p1,
    p2Debit,
    p2Institution,
    p34,
    p5,
    p6,
    p7,
    r1,
    r2,
    r3,
    r4,
    r5,
    r6,
    r7,
    t1,
    t2,
    t3,
    u1,
  ];

  const mismatches: MismatchCode[] = [];
  const waits: WaitCode[] = [];
  for (const verdict of verdicts) {
    if (verdict.kind === 'mismatch' && !mismatches.includes(verdict.code)) {
      mismatches.push(verdict.code);
    } else if (verdict.kind === 'wait' && !waits.includes(verdict.code)) {
      waits.push(verdict.code);
    }
  }
  const ruleVersion = DOUBLE_PROOF_RULE_VERSION;
  if (mismatches.length > 0) return { decision: 'mismatch', reasons: mismatches, ruleVersion };
  // Settle only when every check explicitly passed; the claimer is then known.
  if (waits.length > 0 || payingBy === null || !verdicts.every((v) => v.kind === 'pass')) {
    const reasons = (waits.length > 0 ? waits : (['not_processing'] as const)).map((code) => ({
      code,
      retry: DOUBLE_PROOF_WAIT_RETRY[code],
    }));
    return { decision: 'wait', reasons, ruleVersion };
  }
  return { decision: 'settle', ruleVersion, settledBy: payingBy };
}
