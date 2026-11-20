import { randomUUID } from 'node:crypto';
import {
  applyOddsChangePolicy,
  BET_SHORT_ID_LENGTH,
  encodeCode,
  formatBirr,
  hasRiskLimits,
  largestStakeWithin,
  isFactoryOnlyMarketType,
  liabilityBreach,
  quoteBet,
  toWire,
  validateSlip,
  type BetQuote,
  type LegOddsChange,
  type OddsChangePolicy,
  type SlipError,
  type SlipLeg,
} from '@vamos/core';
import { and, asc, eq } from 'drizzle-orm';
import { type DomainError, domainConflict, domainUnprocessable } from '../errors';
import { InsufficientFundsError } from '../ledger/errors';
import { postTransaction } from '../ledger/post';
import type { AccountRef, DbExecutor, DbTransaction } from '../ledger/types';
import { writeAudit } from '../platform/audit';
import { enqueueOutbox } from '../platform/outbox';
import { lockUser, assertStakeAllowed } from '../rg/limits';
import { betLegs, bets } from '../schema/betting';
import type { GameSettings } from '../settings/index';
import { BET_PLACED } from './events';
import { stakeEntries, stakeLedgerKey } from './postings';
import { assembleUserBets, type BetRow } from './queries';
import { lockEventsForRisk, openLiabilities } from './risk';
import {
  loadSelectionSnapshots,
  snapshotOf,
  unavailableReason,
  type SelectionSnapshot,
  type UnavailableReason,
} from './selections';
import { serializeTerms, type BetChannel, type UserBet } from './types';

/** Attempts at drawing an unused short id before giving up. */
const MAX_SHORT_ID_ATTEMPTS = 8;

export type GameSettingsForBets = Pick<
  GameSettings,
  'betRules' | 'multiBonus' | 'tax' | 'liveBetDelayMs' | 'riskLimits' | 'marketFamilies'
>;

export interface SlipLegInput {
  selectionId: string;
  /** The odds the client showed the punter (milli). */
  oddsMilli: number;
}

/**
 * Where a bet's stake comes from. `wallet` (the default): the player's cash. `retail`: a ticket sold
 * at a shop's counter (docs/plans/agent-shops.md phase 3): the bettor is the agent's counter
 * bettor, the stake leaves `account` (the agent's balance, or HQ's retail cash), only legs whose
 * match has not started are taken (shops sell prematch only), the channel is `shop` and the
 * cashier is the actor.
 */
export type BetFunding =
  { kind: 'wallet' } | { kind: 'retail'; account: AccountRef; staffId: string };

export interface PlaceBetInput {
  userId: string;
  /** Default: the player's wallet. */
  funding?: BetFunding;
  legs: readonly SlipLegInput[];
  /** Santim. */
  stake: bigint;
  policy: OddsChangePolicy;
  /** Default 'web'. */
  channel?: BetChannel;
  /** The client's idempotency key (already validated: 8–100 printable characters). */
  idempotencyKey: string;
  now: Date;
  /** Usually loadGameSettings(); the bet keeps these terms for settlement. */
  settings: GameSettingsForBets;
  /** Random source for the short id, e.g. crypto.randomBytes. */
  randomBytes: (size: number) => Uint8Array;
  /** Client address for the audit log. */
  ip?: string | null;
}

export interface PlaceBetResult {
  bet: UserBet;
  /** true when the idempotency key had been used already: nothing was written. */
  replayed: boolean;
}

export interface UnavailableSelection {
  selectionId: string;
  reason: UnavailableReason;
}

/** 409 `selection_unavailable`, details `{ selections: [{ selectionId, reason }] }`. */
export function selectionUnavailableError(unavailable: UnavailableSelection[]): DomainError {
  return domainConflict(
    'selection_unavailable',
    unavailable.length === 1
      ? 'A selection on your betslip is no longer available.'
      : `${unavailable.length} selections on your betslip are no longer available.`,
    { selections: unavailable },
  );
}

/** 409 `odds_changed`, details `{ policy, changes: [{ selectionId, requestedOddsMilli, currentOddsMilli, direction }] }`. */
export function oddsChangedError(policy: OddsChangePolicy, changes: LegOddsChange[]): DomainError {
  return domainConflict(
    'odds_changed',
    changes.length === 1
      ? 'The odds of a selection on your betslip have changed.'
      : `The odds of ${changes.length} selections on your betslip have changed.`,
    { policy, changes },
  );
}

/**
 * 422 `liability_limit`, details `{ maxStake }`: the bet would take the house past a liability cap
 * (rule L1). `maxStake` is the largest stake that still fits (wire santim), or null when even the
 * minimum stake does not. The caps and the open liability are not shown, though `maxStake` times
 * the odds reveals roughly how much room is left: the price of telling a player what they can bet.
 */
export function liabilityLimitError(maxStake: bigint | null): DomainError {
  return domainUnprocessable(
    'liability_limit',
    maxStake === null
      ? 'This bet is too large for this match right now.'
      : `This bet is too large for this match right now. The largest stake that fits is ${formatBirr(maxStake, { currency: true })}.`,
    { maxStake: maxStake === null ? null : toWire(maxStake) },
  );
}

/** 422 `slip_invalid`, details `{ errors: SlipError[] }` (core validateSlip). */
export function slipInvalidError(errors: SlipError[]): DomainError {
  return domainUnprocessable(
    'slip_invalid',
    errors[0]?.message ?? 'This betslip cannot be placed.',
    { errors },
  );
}

const EARLY_SLIP_ERRORS: ReadonlySet<SlipError['code']> = new Set([
  'no_selections',
  'too_many_legs',
  'duplicate_selection',
  'invalid_odds',
  'invalid_stake',
]);

/** Early errors that do not depend on the bet rules (a bet already placed can never have them). */
const RULE_FREE_SLIP_ERRORS: ReadonlySet<SlipError['code']> = new Set([
  'no_selections',
  'duplicate_selection',
  'invalid_odds',
  'invalid_stake',
]);

/** Errors visible from the request alone (before anything is loaded or locked). */
function requestErrors(input: PlaceBetInput): SlipError[] {
  const legs = input.legs.map((leg) => ({
    selectionId: leg.selectionId.toLowerCase(),
    // The event is not known yet; one per selection keeps duplicate_event out.
    eventId: leg.selectionId.toLowerCase(),
    oddsMilli: leg.oddsMilli,
  }));
  return validateSlip({ stake: input.stake, legs, rules: input.settings.betRules }).filter(
    (error) => EARLY_SLIP_ERRORS.has(error.code),
  );
}

function sameRequest(
  input: PlaceBetInput,
  channel: BetChannel,
  bet: BetRow,
  legs: (typeof betLegs.$inferSelect)[],
) {
  if (bet.stake !== input.stake) return false;
  if (bet.oddsChangePolicy !== input.policy) return false;
  if (bet.channel !== channel) return false;
  if (legs.length !== input.legs.length) return false;
  return legs.every((leg, i) => {
    const requested = input.legs[i];
    return (
      requested !== undefined &&
      leg.selectionId === requested.selectionId.toLowerCase() &&
      leg.requestedOddsMilli === requested.oddsMilli
    );
  });
}

/** Collects the legs that cannot be bet on at `now`. */
function unavailableLegs(
  legs: readonly SlipLegInput[],
  snapshots: ReadonlyMap<string, SelectionSnapshot>,
  now: Date,
): UnavailableSelection[] {
  const out: UnavailableSelection[] = [];
  for (const leg of legs) {
    const reason = unavailableReason(snapshotOf(snapshots, leg.selectionId), now);
    if (reason !== null) out.push({ selectionId: leg.selectionId, reason });
  }
  return out;
}

/** Inserts the bet under a fresh short id and returns the row as stored (defaults included). */
async function insertBetRow(
  tx: DbTransaction,
  values: Omit<typeof bets.$inferInsert, 'shortId'>,
  randomBytes: (size: number) => Uint8Array,
): Promise<BetRow> {
  for (let attempt = 0; attempt < MAX_SHORT_ID_ATTEMPTS; attempt += 1) {
    const shortId = encodeCode(randomBytes(BET_SHORT_ID_LENGTH), BET_SHORT_ID_LENGTH);
    const [row] = await tx
      .insert(bets)
      .values({ ...values, shortId })
      .onConflictDoNothing({ target: bets.shortId })
      .returning();
    if (row !== undefined) return row;
  }
  throw new Error(`no free bet short id after ${MAX_SHORT_ID_ATTEMPTS} attempts`);
}

/**
 * Places a bet in the caller's transaction, in this order:
 * 1. lockUser (serialises the player's bets, RG changes and replays);
 * 2. a bet with the same idempotency key is returned as a replay (422
 *    `idempotency_key_reused` when the request differs), writing nothing;
 * 3. assertStakeAllowed (403 account / exclusion, 422 stake or loss limit);
 * 4. the selections are loaded and locked FOR SHARE, and each must be
 *    bettable with an active sport and competition (409 `selection_unavailable`);
 * 5. the odds-change policy compares the current odds with the client's
 *    (409 `odds_changed`); an accepted bet is priced at the current odds;
 * 6. core validateSlip / quoteBet with the given settings (422 `slip_invalid`);
 * 7. the house liability caps (assertWithinRiskLimits, 422 `liability_limit`);
 *    only when a cap is set, under a lock per match so that bets at the same
 *    moment cannot both fit in room that only one of them fits in;
 * 8. the bet and its legs are inserted: `pending_acceptance` until
 *    now + liveBetDelayMs when any leg's event is live, else `open`;
 * 9. the `bet.placed` outbox event and the audit record;
 * 10. postTransaction(bet_stake) (422 `insufficient_funds`, which rolls back
 *    8 and 9 with the caller's transaction). It is last because it holds the
 *    shared house_stakes row lock until commit.
 * Request-level slip errors (no legs, duplicates, invalid odds or stake) are
 * refused before anything is locked; too many legs (which depends on the
 * current bet rules) only after the replay check, so a replay always returns
 * the bet already placed, whatever the rules say now.
 */
export async function placeBet(tx: DbTransaction, input: PlaceBetInput): Promise<PlaceBetResult> {
  const { userId, stake, policy, now, settings } = input;
  const retail = input.funding?.kind === 'retail' ? input.funding : null;
  const channel: BetChannel = retail !== null ? 'shop' : (input.channel ?? 'web');
  const early = requestErrors(input);
  if (early.some((error) => RULE_FREE_SLIP_ERRORS.has(error.code))) {
    throw slipInvalidError(early);
  }

  await lockUser(tx, userId);

  const [existing] = await tx
    .select()
    .from(bets)
    .where(and(eq(bets.userId, userId), eq(bets.idempotencyKey, input.idempotencyKey)))
    .limit(1);
  if (existing !== undefined) {
    const legs = await tx
      .select()
      .from(betLegs)
      .where(eq(betLegs.betId, existing.id))
      .orderBy(asc(betLegs.position));
    if (!sameRequest(input, channel, existing, legs)) {
      throw domainUnprocessable(
        'idempotency_key_reused',
        'This Idempotency-Key was already used for a different bet.',
      );
    }
    // The rows just read are the bet's rows (as getBetById would read them again); only the
    // selections are still needed for the view.
    const snapshots = await loadSelectionSnapshots(
      tx,
      legs.map((leg) => leg.selectionId),
    );
    const [bet] = assembleUserBets([existing], legs, snapshots);
    if (bet === undefined) throw new Error(`bet ${existing.id} vanished`);
    return { bet, replayed: true };
  }
  // Checked against the current rules only now: a replay returns the bet
  // placed under the rules of the day even if they were tightened since.
  if (early.length > 0) throw slipInvalidError(early);

  await assertStakeAllowed(tx, userId, stake, now);

  const snapshots = await loadSelectionSnapshots(
    tx,
    input.legs.map((leg) => leg.selectionId),
    { lock: 'share' },
  );
  const unavailable = unavailableLegs(input.legs, snapshots, now);
  if (retail !== null) {
    // A shop sells prematch only: a match that is live or past its kick-off is refused even when
    // it still takes live bets online.
    for (const leg of input.legs) {
      const snapshot = snapshotOf(snapshots, leg.selectionId);
      if (
        snapshot !== undefined &&
        !unavailable.some((u) => u.selectionId === leg.selectionId) &&
        (snapshot.eventStatus === 'live' || snapshot.startTime.getTime() <= now.getTime())
      ) {
        unavailable.push({ selectionId: leg.selectionId, reason: 'event_started' });
      }
    }
  }
  if (unavailable.length > 0) throw selectionUnavailableError(unavailable);
  const resolved = input.legs.map((leg) => {
    const snapshot = snapshotOf(snapshots, leg.selectionId);
    if (snapshot === undefined) throw new Error('unreachable: selection checked above');
    return { leg, snapshot };
  });

  const odds = applyOddsChangePolicy(
    policy,
    resolved.map(({ leg, snapshot }) => ({
      selectionId: snapshot.selectionId,
      requestedOddsMilli: leg.oddsMilli,
      currentOddsMilli: snapshot.oddsMilli,
    })),
  );
  if (!odds.accepted) throw oddsChangedError(policy, odds.changes);

  const slipLegs: SlipLeg[] = resolved.map(({ snapshot }, i) => ({
    selectionId: snapshot.selectionId,
    eventId: snapshot.eventId,
    oddsMilli: odds.oddsMilli[i] ?? snapshot.oddsMilli,
  }));
  const quote = quoteBet({
    stake,
    legs: slipLegs,
    rules: settings.betRules,
    multiBonus: settings.multiBonus,
    tax: settings.tax,
  });
  if (quote.errors.length > 0) throw slipInvalidError(quote.errors);

  await assertWithinRiskLimits(tx, {
    legs: slipLegs,
    stake,
    quote,
    settings,
    // Plan task 2.5: the market factory's selections start at a lower liability cap.
    factorySelections: new Set(
      resolved
        .filter(({ snapshot }) => isFactoryOnlyMarketType(snapshot.marketType))
        .map(({ snapshot }) => snapshot.selectionId),
    ),
  });

  const betId = randomUUID();
  const live = resolved.some(({ snapshot }) => snapshot.eventStatus === 'live');
  const acceptAfter = live ? new Date(now.getTime() + settings.liveBetDelayMs) : null;
  const status = live ? 'pending_acceptance' : 'open';
  const betRow = await insertBetRow(
    tx,
    {
      id: betId,
      userId,
      betType: quote.betType,
      stake,
      totalOddsMilli: quote.totalOddsMilli,
      ...potentialOf(quote),
      status,
      oddsChangePolicy: policy,
      channel,
      idempotencyKey: input.idempotencyKey,
      terms: serializeTerms({
        betRules: settings.betRules,
        multiBonus: settings.multiBonus,
        tax: settings.tax,
      }),
      placedAt: now,
      acceptAfter,
      acceptedAt: live ? null : now,
      updatedAt: now,
    },
    input.randomBytes,
  );
  const { shortId } = betRow;
  const legRows = await tx
    .insert(betLegs)
    .values(
      resolved.map(({ leg, snapshot }, position) => ({
        betId,
        position,
        eventId: snapshot.eventId,
        marketId: snapshot.marketId,
        selectionId: snapshot.selectionId,
        oddsMilli: slipLegs[position]?.oddsMilli ?? snapshot.oddsMilli,
        requestedOddsMilli: leg.oddsMilli,
        isLive: snapshot.eventStatus === 'live',
        updatedAt: now,
      })),
    )
    .returning();

  await enqueueOutbox(tx, {
    type: BET_PLACED,
    aggregateType: 'bet',
    aggregateId: betId,
    payload: {
      betId,
      userId,
      shortId,
      status,
      channel,
      stake,
      totalOddsMilli: quote.totalOddsMilli,
      potentialNetPayout: quote.netPayout,
      acceptAfter,
      legs: slipLegs.map((leg, i) => ({
        selectionId: leg.selectionId,
        eventId: leg.eventId,
        oddsMilli: leg.oddsMilli,
        isLive: resolved[i]?.snapshot.eventStatus === 'live',
      })),
    },
  });
  await writeAudit(tx, {
    // A shop ticket's actor is the cashier who sold it.
    actorType: retail !== null ? 'admin' : 'user',
    actorId: retail !== null ? retail.staffId : userId,
    action: BET_PLACED,
    targetType: 'bet',
    targetId: betId,
    metadata: {
      shortId,
      stake,
      legs: slipLegs.length,
      status,
      channel,
      policy,
      oddsChanged: odds.changes.length,
    },
    ip: input.ip ?? null,
  });

  // The view is built from the rows as inserted (RETURNING gives the column defaults) and the
  // snapshots loaded above, instead of reading the bet back (3 statements). The selection rows
  // are locked FOR SHARE, so their odds and status are still those snapshots.
  const [bet] = assembleUserBets(
    [betRow],
    [...legRows].sort((a, b) => a.position - b.position),
    snapshots,
  );
  if (bet === undefined) throw new Error(`bet ${betId} was not inserted`);

  // The stake posting comes last: it locks the shared house_stakes account
  // row until commit, so every bet in the system queues on that lock. Writing
  // it after everything else keeps the lock to the posting and the commit.
  // A refusal (insufficient funds) still rolls back the whole transaction.
  try {
    const posting = await postTransaction(tx, {
      type: 'bet_stake',
      idempotencyKey: stakeLedgerKey(userId, input.idempotencyKey),
      refType: 'bet',
      refId: betId,
      description:
        retail !== null ? `Shop ticket stake (${quote.betType})` : `Bet stake (${quote.betType})`,
      actor: retail !== null ? { type: 'admin', id: retail.staffId } : { type: 'user', id: userId },
      entries:
        retail !== null
          ? [
              { account: retail.account, amount: -stake },
              { account: { kind: 'house_stakes' }, amount: stake },
            ]
          : stakeEntries(userId, stake),
    });
    if (!posting.created) {
      // Bets and their stake postings commit together, so this key cannot exist without the bet.
      throw new Error(`stake posting ${posting.transactionId} exists without its bet`);
    }
  } catch (error) {
    if (error instanceof InsufficientFundsError) {
      if (retail !== null) {
        throw domainConflict(
          'agent_balance_low',
          "The agent's balance is too low for this ticket. The agent tops up at Nahubet first.",
          { balance: toWire(error.available), stake: toWire(stake) },
        );
      }
      throw domainUnprocessable('insufficient_funds', 'Your balance is too low for this stake.', {
        balance: toWire(error.available),
        stake: toWire(stake),
      });
    }
    throw error;
  }

  return { bet, replayed: false };
}

/**
 * Rule L1: the new bet's potential gross payout, added to the open liability of each of its
 * selections and matches, must stay within the caps (`settings.riskLimits`; null = no cap).
 * Does nothing, and takes no lock, when no cap is set. Otherwise it locks the matches of the bet
 * (lockEventsForRisk) and sums the open bets under that lock (openLiabilities), so the answer
 * holds when this transaction commits. Over a cap: 422 `liability_limit` with the largest stake
 * that fits. The lock is held until the caller's transaction ends.
 */
async function assertWithinRiskLimits(
  tx: DbTransaction,
  input: {
    legs: readonly SlipLeg[];
    stake: bigint;
    quote: BetQuote;
    settings: Pick<
      GameSettingsForBets,
      'betRules' | 'multiBonus' | 'tax' | 'riskLimits' | 'marketFamilies'
    >;
    /** Selections of factory markets, capped lower (selectionLiabilityCap). */
    factorySelections: ReadonlySet<string>;
  },
): Promise<void> {
  const { legs, stake, quote, settings, factorySelections } = input;
  const limits = settings.riskLimits;
  if (!hasRiskLimits(limits)) return;
  const eventIds = legs.map((leg) => leg.eventId);
  await lockEventsForRisk(tx, eventIds);
  const open = await openLiabilities(tx, {
    selectionIds: legs.map((leg) => leg.selectionId),
    eventIds,
  });
  const breach = liabilityBreach({
    payout: quote.grossPayout,
    ...open,
    limits,
    factorySelections,
    // Plan task 2.5: the factory share of the selection cap is a setting (default a quarter).
    factoryShareBps: settings.marketFamilies.factoryLiabilityShareBps,
  });
  if (breach === null) return;
  const { betRules, multiBonus, tax } = settings;
  const maxStake = largestStakeWithin({
    headroom: breach.headroom,
    minStake: betRules.minStake,
    // The stake asked for already pays too much, so the answer is below it.
    maxStake: stake - 1n,
    payoutOf: (s) => quoteBet({ stake: s, legs, rules: betRules, multiBonus, tax }).grossPayout,
  });
  throw liabilityLimitError(maxStake);
}

/** The potential_* columns of a quote. */
export function potentialOf(quote: BetQuote) {
  return {
    potentialGrossPayout: quote.grossPayout,
    potentialBonus: quote.bonusAmount,
    potentialTax: quote.taxAmount,
    potentialNetPayout: quote.netPayout,
    bonusPercentBps: quote.bonusPercentBps,
  };
}

export interface QuoteSlipInput {
  /** `oddsMilli`, when given, is compared with the current odds (`oddsChanged`). */
  legs: ReadonlyArray<{ selectionId: string; oddsMilli?: number }>;
  stake: bigint;
  settings: Pick<GameSettings, 'betRules' | 'multiBonus' | 'tax'>;
  now: Date;
}

export interface QuotedLeg {
  selectionId: string;
  available: boolean;
  reason: UnavailableReason | null;
  /** null when the selection does not exist. */
  currentOddsMilli: number | null;
  requestedOddsMilli: number | null;
  /** The client sent odds and they differ from the current odds. */
  oddsChanged: boolean;
  /** The event is live: a bet would wait for delayed acceptance. */
  isLive: boolean;
  selection: SelectionSnapshot | null;
}

export interface SlipQuote {
  /** One entry per requested leg, in request order. */
  legs: QuotedLeg[];
  /** quoteBet over the available legs at their current odds (unavailable legs left out). */
  quote: BetQuote;
}

/**
 * The public betslip quote: current odds and availability of every leg, and
 * the quote (with slip errors) of the legs that can be bet on now. Reads
 * only; locks nothing.
 */
export async function quoteSlip(exec: DbExecutor, input: QuoteSlipInput): Promise<SlipQuote> {
  const snapshots = await loadSelectionSnapshots(
    exec,
    input.legs.map((leg) => leg.selectionId),
  );
  const legs = input.legs.map((leg): QuotedLeg => {
    const snapshot = snapshotOf(snapshots, leg.selectionId);
    const reason = unavailableReason(snapshot, input.now);
    return {
      selectionId: snapshot?.selectionId ?? leg.selectionId,
      available: reason === null,
      reason,
      currentOddsMilli: snapshot?.oddsMilli ?? null,
      requestedOddsMilli: leg.oddsMilli ?? null,
      oddsChanged:
        snapshot !== undefined &&
        leg.oddsMilli !== undefined &&
        leg.oddsMilli !== snapshot.oddsMilli,
      isLive: snapshot?.eventStatus === 'live',
      selection: snapshot ?? null,
    };
  });
  const quote = quoteBet({
    stake: input.stake,
    legs: legs.flatMap((leg) =>
      leg.available && leg.selection !== null
        ? [
            {
              selectionId: leg.selection.selectionId,
              eventId: leg.selection.eventId,
              oddsMilli: leg.selection.oddsMilli,
            },
          ]
        : [],
    ),
    rules: input.settings.betRules,
    multiBonus: input.settings.multiBonus,
    tax: input.settings.tax,
  });
  return { legs, quote };
}
