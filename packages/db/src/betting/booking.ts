import {
  BOOKING_CODE_LENGTH,
  DEFAULT_BET_RULES,
  encodeCode,
  isValidCode,
  normalizeCode,
  validateSlip,
  type BetRules,
  type SlipError,
} from '@vamos/core';
import { eq } from 'drizzle-orm';
import { domainGone, DomainError } from '../errors';
import type { DbExecutor } from '../ledger/types';
import { bookingCodes } from '../schema/betting';
import { selectionUnavailableError, slipInvalidError } from './place';
import {
  isUuid,
  loadSelectionSnapshots,
  snapshotOf,
  unavailableReason,
  type SelectionSnapshot,
  type UnavailableReason,
} from './selections';

/** How long a booking code stays loadable (72 hours). */
export const BOOKING_CODE_TTL_MS = 72 * 60 * 60_000;
/** Attempts at drawing an unused booking code before giving up. */
const MAX_CODE_ATTEMPTS = 8;

const STRUCTURAL_ERRORS: ReadonlySet<SlipError['code']> = new Set([
  'no_selections',
  'too_many_legs',
  'duplicate_selection',
  'duplicate_event',
]);

export interface BookingLeg {
  selectionId: string;
  available: boolean;
  reason: UnavailableReason | null;
  currentOddsMilli: number | null;
  isLive: boolean;
  selection: SelectionSnapshot | null;
}

export interface BookingCode {
  code: string;
  createdAt: Date;
  expiresAt: Date;
  legs: BookingLeg[];
}

function bookingLegs(
  selectionIds: readonly string[],
  snapshots: ReadonlyMap<string, SelectionSnapshot>,
  now: Date,
): BookingLeg[] {
  return selectionIds.map((selectionId) => {
    const snapshot = snapshotOf(snapshots, selectionId);
    const reason = unavailableReason(snapshot, now);
    return {
      selectionId: snapshot?.selectionId ?? selectionId,
      available: reason === null,
      reason,
      currentOddsMilli: snapshot?.oddsMilli ?? null,
      isLive: snapshot?.eventStatus === 'live',
      selection: snapshot ?? null,
    };
  });
}

export interface CreateBookingCodeInput {
  legs: ReadonlyArray<{ selectionId: string }>;
  /** The player sharing the slip, when logged in. */
  userId?: string | null;
  now: Date;
  randomBytes: (size: number) => Uint8Array;
  /** For the leg count; default DEFAULT_BET_RULES. */
  rules?: Pick<BetRules, 'maxLegs'>;
  /** Default BOOKING_CODE_TTL_MS. */
  ttlMs?: number;
}

/**
 * Saves a betslip under a new BOOKING_CODE_LENGTH-symbol code. Every
 * selection must exist and be bettable now (409 `selection_unavailable`), and
 * the slip must be well formed: 1..maxLegs legs, no selection twice, one per
 * event (422 `slip_invalid`). A code collision draws a new code.
 */
export async function createBookingCode(
  exec: DbExecutor,
  input: CreateBookingCodeInput,
): Promise<BookingCode> {
  const { now } = input;
  const rules = {
    ...DEFAULT_BET_RULES,
    maxLegs: input.rules?.maxLegs ?? DEFAULT_BET_RULES.maxLegs,
  };
  const ids = input.legs.map((leg) => leg.selectionId);
  const snapshots = await loadSelectionSnapshots(exec, ids);
  const legs = bookingLegs(ids, snapshots, now);
  const errors = validateSlip({
    stake: rules.minStake,
    legs: legs.map((leg) => ({
      selectionId: leg.selectionId.toLowerCase(),
      eventId: leg.selection?.eventId ?? leg.selectionId,
      oddsMilli: leg.currentOddsMilli ?? rules.minLegOddsMilli,
    })),
    rules,
  }).filter((error) => STRUCTURAL_ERRORS.has(error.code));
  if (errors.length > 0) throw slipInvalidError(errors);
  const unavailable = legs.filter((leg) => !leg.available);
  if (unavailable.length > 0) {
    throw selectionUnavailableError(
      unavailable.map((leg) => ({
        selectionId: leg.selectionId,
        reason: leg.reason ?? 'not_found',
      })),
    );
  }

  const ttlMs = input.ttlMs ?? BOOKING_CODE_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new RangeError('ttlMs must be positive');
  const expiresAt = new Date(now.getTime() + ttlMs);
  const stored = legs.map((leg) => ({ selectionId: leg.selectionId }));
  const userId = input.userId !== undefined && isUuid(input.userId) ? input.userId : null;
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
    const code = encodeCode(input.randomBytes(BOOKING_CODE_LENGTH), BOOKING_CODE_LENGTH);
    const [row] = await exec
      .insert(bookingCodes)
      .values({ code, legs: stored, createdByUserId: userId, createdAt: now, expiresAt })
      .onConflictDoNothing({ target: bookingCodes.code })
      .returning({ code: bookingCodes.code });
    if (row !== undefined) return { code: row.code, createdAt: now, expiresAt, legs };
  }
  throw new Error(`no free booking code after ${MAX_CODE_ATTEMPTS} attempts`);
}

/**
 * Loads a booking code (typed or pasted; normalised first) with the current
 * odds and availability of each leg. 404 `booking_code_not_found` for an
 * unknown or malformed code, 410 `booking_code_expired` after its expiry.
 */
export async function loadBookingCode(
  exec: DbExecutor,
  input: string,
  now: Date,
): Promise<BookingCode> {
  const notFound = () =>
    new DomainError(404, 'booking_code_not_found', 'This booking code does not exist.');
  const code = typeof input === 'string' ? normalizeCode(input) : '';
  if (!isValidCode(code, BOOKING_CODE_LENGTH)) throw notFound();
  const [row] = await exec.select().from(bookingCodes).where(eq(bookingCodes.code, code)).limit(1);
  if (row === undefined) throw notFound();
  if (row.expiresAt.getTime() <= now.getTime()) {
    throw domainGone('booking_code_expired', 'This booking code has expired.', {
      expiresAt: row.expiresAt.toISOString(),
    });
  }
  const ids = row.legs.map((leg) => leg.selectionId);
  const snapshots = await loadSelectionSnapshots(exec, ids);
  return {
    code: row.code,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    legs: bookingLegs(ids, snapshots, now),
  };
}
