import type { Santim } from './money';
import type { ParsedSms } from './smsparse';

/**
 * Matching SMS to deposits and payouts (SMS deposit rail, pure part). Ported
 * from Melabingo's `sms-matcher.ts` and `payout-matcher.ts`.
 *
 * The deposit reference is a unique amount: a player who asks to deposit
 * 100 birr is told to send exactly 100.37, and those santim identify the
 * deposit among all open ones (a partial unique index keeps them unique).
 * Nothing to copy or paste, and matching is exact rather than fuzzy.
 */

/**
 * Widest santim offset a reserved amount carries (money the player pays on top).
 * 99: a whole-birr request keeps its birr figure (100 becomes 100.01 to 100.99).
 */
export const MAX_SANTIM_OFFSET = 99;

const SANTIM_PER_BIRR = 100n;

/**
 * Reserves the amount a new deposit must be sent as: `base` plus 1 to
 * MAX_SANTIM_OFFSET santim, never a whole-birr amount, which another payer
 * might send by chance (a request of 100.01 skips 101.00). `taken` holds the
 * amounts of the open SMS deposits; `randomOffset` returns an integer in
 * 1..MAX_SANTIM_OFFSET (the caller injects a CSPRNG). Null when every usable
 * offset for this base is taken: the deposit is refused (ask for another
 * amount), never given a colliding reference.
 */
export function allocateSmsAmount(
  base: Santim,
  taken: ReadonlySet<Santim>,
  randomOffset: () => number,
): Santim | null {
  if (base <= 0n) throw new RangeError('allocateSmsAmount: base must be positive');
  const start = randomOffset();
  if (!Number.isInteger(start) || start < 1 || start > MAX_SANTIM_OFFSET) {
    throw new RangeError(`allocateSmsAmount: offset must be an integer in 1..${MAX_SANTIM_OFFSET}`);
  }
  for (let step = 0; step < MAX_SANTIM_OFFSET; step++) {
    const offset = ((start - 1 + step) % MAX_SANTIM_OFFSET) + 1;
    const candidate = base + BigInt(offset);
    if (candidate % SANTIM_PER_BIRR === 0n) continue;
    if (!taken.has(candidate)) return candidate;
  }
  return null;
}

/** An open SMS deposit, as the matcher sees it. */
export interface OpenSmsDeposit {
  intentId: string;
  userId: string;
  /** The exact amount the player was told to send. */
  amount: Santim;
  /** The player's registered phone (E.164). */
  phone: string | null;
  /** When the intent stops accepting a match (payment_intents.expires_at). */
  expiresAt: Date;
}

export type SmsMatchConfidence =
  /** The exact reserved amount, from the player's own phone. */
  | 'amount_and_phone'
  /** The exact reserved amount. */
  | 'exact_amount'
  /** A different amount, but the sender's phone names exactly one open deposit. */
  | 'phone_fallback';

export type SmsUnmatchedReason = 'not_a_credit' | 'no_open_deposit' | 'no_amount_or_phone_match';

export type SmsDepositMatch =
  | {
      type: 'matched';
      intentId: string;
      userId: string;
      confidence: SmsMatchConfidence;
      /** What actually arrived (never the requested amount). */
      received: Santim;
      /** True when `received` differs from the reserved amount (Vamos flags these for staff). */
      amountDiffers: boolean;
    }
  | { type: 'ambiguous'; intentIds: string[] }
  | { type: 'unmatched'; reason: SmsUnmatchedReason };

/**
 * Which open deposit a received SMS pays. `open` may be every open SMS
 * deposit (the gateway path) or only the pasting player's own (the checker
 * path, so pasted text can only ever settle the paster's deposit).
 *
 * 1. Only a credit can match.
 * 2. The exact reserved amount matching one open deposit is the designed path.
 * 3. Otherwise the sender's phone, when it names exactly one open deposit
 *    (players send 100 when told 100.37).
 * Anything else is ambiguous or unmatched and goes to a person.
 */
export function matchSmsDeposit(
  sms: Pick<ParsedSms, 'direction' | 'amount' | 'counterpartyPhone'>,
  open: readonly OpenSmsDeposit[],
  now: Date,
): SmsDepositMatch {
  if (sms.direction !== 'credit') return { type: 'unmatched', reason: 'not_a_credit' };
  const live = open.filter((deposit) => deposit.expiresAt.getTime() > now.getTime());
  if (live.length === 0) return { type: 'unmatched', reason: 'no_open_deposit' };

  const exact = live.filter((deposit) => deposit.amount === sms.amount);
  if (exact.length === 1) {
    const deposit = exact[0]!;
    const phoneMatches = sms.counterpartyPhone !== null && deposit.phone === sms.counterpartyPhone;
    return {
      type: 'matched',
      intentId: deposit.intentId,
      userId: deposit.userId,
      confidence: phoneMatches ? 'amount_and_phone' : 'exact_amount',
      received: sms.amount,
      amountDiffers: false,
    };
  }
  // Impossible while the unique index holds; never guess with real money.
  if (exact.length > 1) {
    return { type: 'ambiguous', intentIds: exact.map((deposit) => deposit.intentId) };
  }

  if (sms.counterpartyPhone !== null) {
    const byPhone = live.filter((deposit) => deposit.phone === sms.counterpartyPhone);
    if (byPhone.length === 1) {
      const deposit = byPhone[0]!;
      return {
        type: 'matched',
        intentId: deposit.intentId,
        userId: deposit.userId,
        confidence: 'phone_fallback',
        received: sms.amount,
        amountDiffers: sms.amount !== deposit.amount,
      };
    }
    if (byPhone.length > 1) {
      return { type: 'ambiguous', intentIds: byPhone.map((deposit) => deposit.intentId) };
    }
  }
  return { type: 'unmatched', reason: 'no_amount_or_phone_match' };
}

/** How far an institution's clock may run ahead of ours. */
export const SMS_INSTITUTION_CLOCK_SKEW_MS = 5 * 60_000;
/** How far the collection handset's clock may run ahead of ours (a phone's clock drifts more). */
export const SMS_HANDSET_CLOCK_SKEW_MS = 30 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const EAT_OFFSET_MS = 3 * 60 * 60_000;

/**
 * The latest moment the money in an SMS can have moved: only a deposit
 * created before it can be what the SMS pays. A transfer forwarded hours
 * late (the handset was offline) must not pay a newer deposit that was
 * handed the same exact amount after the first one released it.
 *
 * The earliest of: the institution's time (+ skew; a date without a time,
 * read as midnight EAT, counts as the end of that day), the handset's
 * receive time (+ a larger skew), and now. A time in our future is ignored.
 */
export function smsPaidBy(input: {
  occurredAt: Date | null;
  deviceReceivedAt: Date | null;
  now: Date;
}): Date {
  const now = input.now.getTime();
  let bound = now;
  const occurred = input.occurredAt?.getTime();
  if (
    occurred !== undefined &&
    Number.isFinite(occurred) &&
    occurred <= now + SMS_INSTITUTION_CLOCK_SKEW_MS
  ) {
    const dateOnly = (occurred + EAT_OFFSET_MS) % DAY_MS === 0;
    bound = Math.min(bound, occurred + (dateOnly ? DAY_MS : 0) + SMS_INSTITUTION_CLOCK_SKEW_MS);
  }
  const device = input.deviceReceivedAt?.getTime();
  if (
    device !== undefined &&
    Number.isFinite(device) &&
    device <= now + SMS_HANDSET_CLOCK_SKEW_MS
  ) {
    bound = Math.min(bound, device + SMS_HANDSET_CLOCK_SKEW_MS);
  }
  return new Date(bound);
}

/**
 * The latest claim an outgoing (debit) SMS can be the transfer of: a manual
 * payout claimed after the money moved was not paid by it (an operator who
 * claims a payout and points at an older transfer of the same amount settles
 * nothing). The mirror of smsPaidBy for deposits: the money must have moved
 * at or after the claim minus SMS_INSTITUTION_CLOCK_SKEW_MS by every clock the
 * SMS carries, the institution's (a date without a time counts as the end of
 * its day), the handset's (with its larger skew) and our own receive time.
 * A payout passes when `claimedAt <= latestClaimForSms(sms)`.
 */
export function latestClaimForSms(input: {
  occurredAt: Date | null;
  deviceReceivedAt: Date | null;
  /** When we received the SMS (received_sms.received_at, our clock). */
  receivedAt: Date;
}): Date {
  return smsPaidBy({
    occurredAt: input.occurredAt,
    deviceReceivedAt: input.deviceReceivedAt,
    now: new Date(input.receivedAt.getTime() + SMS_INSTITUTION_CLOCK_SKEW_MS),
  });
}

/** A payout waiting to be paid by hand, as the proposer sees it. */
export interface ManualPayoutCandidate {
  payoutId: string;
  amount: Santim;
  /** The destination the player authorised (E.164 for wallets, an account number for banks). */
  destinationAccount: string;
}

export type PayoutProposal =
  | { type: 'proposed'; payoutId: string; confidence: 'amount_and_account' | 'amount_only' }
  | { type: 'none'; reason: 'not_a_debit' | 'no_candidate' }
  | { type: 'ambiguous' };

/**
 * Which claimed payout an outgoing (debit) SMS from a collection account
 * appears to have paid. The caller passes only payouts that were claimed
 * (`processing`) no later than latestClaimForSms: an unclaimed payout has not
 * been sent by anyone, and a transfer older than the claim did not pay it. It only proposes: settling stays a staff action under
 * the four-eyes rule, because whoever holds the handset could otherwise mark
 * payouts as paid with no money moving (and the player's money is already
 * held, so a false settlement takes it for good).
 *
 * Amount alone is weak evidence (two players withdrawing 500 is routine):
 * when the SMS names the destination it must be the payout's, and without a
 * destination the amount must select exactly one candidate.
 */
export function proposePayoutForSms(
  sms: Pick<ParsedSms, 'direction' | 'amount' | 'counterpartyPhone'>,
  candidates: readonly ManualPayoutCandidate[],
): PayoutProposal {
  if (sms.direction !== 'debit') return { type: 'none', reason: 'not_a_debit' };
  const sameAmount = candidates.filter((candidate) => candidate.amount === sms.amount);
  if (sameAmount.length === 0) return { type: 'none', reason: 'no_candidate' };

  if (sms.counterpartyPhone !== null) {
    const exact = sameAmount.filter(
      (candidate) => candidate.destinationAccount === sms.counterpartyPhone,
    );
    if (exact.length === 1) {
      return { type: 'proposed', payoutId: exact[0]!.payoutId, confidence: 'amount_and_account' };
    }
    if (exact.length > 1) return { type: 'ambiguous' };
    // Right amount, wrong destination: that transfer paid someone else.
    return { type: 'none', reason: 'no_candidate' };
  }
  if (sameAmount.length > 1) return { type: 'ambiguous' };
  return { type: 'proposed', payoutId: sameAmount[0]!.payoutId, confidence: 'amount_only' };
}
