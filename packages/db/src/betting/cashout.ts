import {
  cashOutOffer,
  cashOutPayout,
  toWire,
  type CashOutConfig,
  type CashOutUnavailableReason,
  type LegState,
} from '@vamos/core';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { domainConflict, domainNotFound, domainUnprocessable, type DomainError } from '../errors';
import { postTransaction } from '../ledger/post';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { writeAudit } from '../platform/audit';
import { enqueueOutbox } from '../platform/outbox';
import { lockUser } from '../rg/limits';
import { betCashouts, betLegs, bets, type CashOutLegJson } from '../schema/betting';
import { events, markets, selections } from '../schema/catalog';
import { BET_CASHED_OUT } from './events';
import { cashOutEntries, cashOutLedgerKey } from './postings';
import { getUserBet, toUserBets } from './queries';
import { isUuid, loadSelectionSnapshots, unavailableReason } from './selections';
import { legStateOf } from './settle';
import {
  parseTerms,
  type BetStatus,
  type BetTerms,
  type CashOutRecord,
  type UserBet,
} from './types';

/**
 * Cash-out (Phase 7): the player closes an open bet early for the offer the
 * house makes now.
 *
 * Pricing (priceCashOut, pure): core `cashOutOffer` with the bet's own terms
 * (the max payout of the bet rules it was placed under, not today's) and the
 * cash-out settings in force. Each leg counts as its selection decides it
 * NOW, the same rule as settlement (legStateOf): a resulted selection counts
 * as won / lost / void even before its settlement job has run, a void market
 * as void. An open leg is priced at its selection's live odds only while it
 * can be bet on (unavailableReason: selection, market and event open, betting
 * on, sport and competition active); otherwise its odds are unknown and no
 * offer is made (`leg_suspended`). Only bets in status `open` can cash out.
 * The offer is the cash-out's gross; cashOutPayout (core) takes the winnings
 * tax of the bet's terms off the part above the stake, exactly as settlement
 * taxes a payout, leaving the net paid to the player. An offer of zero is
 * never made (`below_minimum`).
 */

/** Why no cash-out can be offered now: core's reasons, or the bet is not `open`. */
export type CashOutUnavailable = CashOutUnavailableReason | 'bet_not_open';

/** Most bets getCashOutOffers prices in one call. */
export const MAX_CASH_OUT_BATCH = 50;

/** One leg as a cash-out prices it (also stored in bet_cashouts.legs). */
export type CashOutQuoteLeg = CashOutLegJson;

/** The cash-out offer of a bet at `quotedAt`. */
export interface CashOutQuote {
  betId: string;
  userId: string;
  status: BetStatus;
  stake: bigint;
  available: boolean;
  /** Why not (null when available). */
  reason: CashOutUnavailable | null;
  /** The cash-out value (the offer); 0n when unavailable. */
  gross: bigint;
  /** Winnings tax on the part of `gross` above the stake (the bet's tax terms). */
  tax: bigint;
  /** gross − tax: what the player is paid. */
  net: bigint;
  /** What the bet returns if every open leg wins, capped, before bonus and tax (0n once lost). */
  potentialReturn: bigint;
  /** The margin of the cash-out settings used. */
  marginBps: number;
  legs: CashOutQuoteLeg[];
  quotedAt: Date;
}

/** What priceCashOut needs of a bet: a UserBet (legs with their selection snapshots) fits. */
export type CashOutPricingInput = Pick<UserBet, 'id' | 'userId' | 'status' | 'stake' | 'terms'> & {
  legs: ReadonlyArray<
    Pick<UserBet['legs'][number], 'id' | 'selectionId' | 'oddsMilli' | 'selection'>
  >;
};

/**
 * The cash-out offer of a bet at `now` (pure; see the module notes). Use it
 * for My Bets views as well: a UserBet carries everything it needs.
 */
export function priceCashOut(
  bet: CashOutPricingInput,
  config: CashOutConfig,
  now: Date,
): CashOutQuote {
  const legs = bet.legs.map((leg): CashOutQuoteLeg => {
    const { selection } = leg;
    const state: LegState = legStateOf(selection.marketStatus, selection.result);
    const bettable = unavailableReason(selection, now) === null;
    return {
      legId: leg.id,
      selectionId: leg.selectionId,
      state,
      placedOddsMilli: leg.oddsMilli,
      currentOddsMilli: state === 'open' && bettable ? selection.oddsMilli : null,
    };
  });
  const offer = cashOutOffer({
    stake: bet.stake,
    legs: legs.map((leg) => ({
      placedOddsMilli: leg.placedOddsMilli,
      state: leg.state,
      currentOddsMilli: leg.currentOddsMilli,
    })),
    config,
    maxPayout: bet.terms.betRules.maxPayout,
  });
  const base = {
    betId: bet.id,
    userId: bet.userId,
    status: bet.status,
    stake: bet.stake,
    potentialReturn: offer.potentialReturn,
    marginBps: config.marginBps,
    legs,
    quotedAt: now,
  };
  let reason: CashOutUnavailable | null = null;
  if (bet.status !== 'open') reason = 'bet_not_open';
  else if (!offer.available) reason = offer.reason ?? 'disabled';
  // Never offer to take a bet off the player for nothing.
  else if (offer.amount <= 0n) reason = 'below_minimum';
  if (reason !== null) {
    return { ...base, available: false, reason, gross: 0n, tax: 0n, net: 0n };
  }
  const payout = cashOutPayout({ stake: bet.stake, gross: offer.amount, tax: bet.terms.tax });
  return { ...base, available: true, reason: null, ...payout };
}

/**
 * The wire view of an offer (CashOutOfferView in @vamos/contracts, which
 * @vamos/db does not depend on): santim as decimal strings, time as ISO.
 */
export function cashOutOfferView(quote: CashOutQuote): {
  betId: string;
  available: boolean;
  reason: CashOutUnavailable | null;
  gross: string;
  tax: string;
  net: string;
  potentialReturn: string;
  quotedAt: string;
} {
  return {
    betId: quote.betId,
    available: quote.available,
    reason: quote.reason,
    gross: toWire(quote.gross),
    tax: toWire(quote.tax),
    net: toWire(quote.net),
    potentialReturn: toWire(quote.potentialReturn),
    quotedAt: quote.quotedAt.toISOString(),
  };
}

/**
 * The wire view of what a cash-out paid (CashedOutView in @vamos/contracts:
 * BetView.cashedOut and CashOutResponse.cashOut): santim as decimal
 * strings, time as ISO.
 */
export function cashedOutView(record: CashOutRecord): {
  gross: string;
  tax: string;
  net: string;
  cashedOutAt: string;
} {
  return {
    gross: toWire(record.gross),
    tax: toWire(record.tax),
    net: toWire(record.net),
    cashedOutAt: record.cashedOutAt.toISOString(),
  };
}

/** 409 `cashout_unavailable`, details `{ reason }`. */
export function cashOutUnavailableError(reason: CashOutUnavailable): DomainError {
  return domainConflict(
    'cashout_unavailable',
    reason === 'bet_not_open'
      ? 'This bet can no longer be cashed out.'
      : 'Cash out is not available for this bet right now.',
    { reason },
  );
}

/** 409 `cashout_offer_changed`, details `{ offer }` (the fresh offer, wire view). */
export function cashOutOfferChangedError(quote: CashOutQuote): DomainError {
  return domainConflict(
    'cashout_offer_changed',
    'The cash-out offer has changed. Please check the new amount.',
    { offer: cashOutOfferView(quote) },
  );
}

/** The cash-out offer of one of the player's bets; null when it is unknown or someone else's. */
export async function getCashOutOffer(
  exec: DbExecutor,
  input: { userId: string; betId: string; config: CashOutConfig; now: Date },
): Promise<CashOutQuote | null> {
  const bet = await getUserBet(exec, input.userId, input.betId);
  return bet === null ? null : priceCashOut(bet, input.config, input.now);
}

/**
 * The cash-out offers of up to MAX_CASH_OUT_BATCH of the player's bets, in
 * the order asked (duplicates once). Ids that are not the player's bets are
 * left out. Reads only; locks nothing.
 */
export async function getCashOutOffers(
  exec: DbExecutor,
  input: { userId: string; betIds: readonly string[]; config: CashOutConfig; now: Date },
): Promise<CashOutQuote[]> {
  if (input.betIds.length > MAX_CASH_OUT_BATCH) {
    throw new RangeError(`at most ${MAX_CASH_OUT_BATCH} bets per call`);
  }
  const ids = [...new Set(input.betIds.filter(isUuid).map((id) => id.toLowerCase()))];
  if (ids.length === 0 || !isUuid(input.userId)) return [];
  const rows = await exec
    .select()
    .from(bets)
    .where(and(eq(bets.userId, input.userId), inArray(bets.id, ids)));
  const found = new Map((await toUserBets(exec, rows)).map((bet) => [bet.id, bet]));
  return ids.flatMap((id) => {
    const bet = found.get(id);
    return bet === undefined ? [] : [priceCashOut(bet, input.config, input.now)];
  });
}

export interface CashOutBetInput {
  userId: string;
  betId: string;
  /** The gross offer the player accepted (santim, positive). */
  quotedGross: bigint;
  /** The client's Idempotency-Key (already validated: 8–100 printable characters). */
  idempotencyKey: string;
  now: Date;
  /** The cash-out settings in force, loaded in this transaction (loadGameSettings(tx).cashOut). */
  config: CashOutConfig;
  /** Client address for the audit log. */
  ip?: string | null;
}

export interface CashOutBetResult {
  /** The bet, now `cashed_out`. */
  bet: UserBet;
  cashOut: CashOutRecord;
  /** true when the idempotency key had been used for this cash-out already: nothing was written. */
  replayed: boolean;
}

/**
 * Cashes out one of the player's bets in the caller's transaction, in this
 * order:
 * 1. the bet row is locked FOR UPDATE (the lock settlement and acceptance
 *    take, so a cash-out and a settlement of the same bet serialise: the
 *    second finds the bet closed); not the player's bet → 404 `not_found`;
 * 2. lockUser (serialises the player's money operations and replays);
 * 3. a cash-out recorded under the same Idempotency-Key is returned as a
 *    replay (nothing written); the key used for another bet or another
 *    amount → 422 `idempotency_key_reused`;
 * 4. only an `open` bet can cash out → else 409 `cashout_unavailable`
 *    (reason `bet_not_open`), which is also the answer to a second cash-out
 *    of a bet under a different key;
 * 5. the events of its legs are locked FOR SHARE, then their markets, then
 *    their selections (the catalogue's event → market → selection lock
 *    order): the live simulator, the feed and resulting take the event FOR
 *    UPDATE before they change prices, statuses or results, a trader's
 *    market status change locks the market and repricing the selection, so
 *    the offer is never priced from a state they are about to replace, and
 *    the results, statuses and odds read stay as they are until COMMIT; the
 *    snapshots are then read afresh. (Whatever changes a result or voids a
 *    market in future must lock the same way, event first.)
 * 6. the offer is priced again (priceCashOut): unavailable → 409
 *    `cashout_unavailable` with the reason; a fresh gross below the quoted
 *    one, or a fresh net below the net of the quoted gross (the tax
 *    exemption can make a higher gross pay less), → 409
 *    `cashout_offer_changed` with the fresh offer; otherwise the FRESH offer
 *    is paid (at least what the player accepted);
 * 7. postTransaction(bet_cashout) under `cashout:<betId>` (cashOutEntries:
 *    stakes, player cash, tax payable, revenue), the bet_cashouts record,
 *    the leg states as priced, and the bet → `cashed_out` with the gross,
 *    tax and net in settled_* and settled_at;
 * 8. the `bet.cashed_out` outbox event and the audit record.
 * Responsible-gambling limits and self-exclusion are not checked: a cash-out
 * is not a stake and only reduces the player's exposure.
 */
export async function cashOutBet(
  tx: DbTransaction,
  input: CashOutBetInput,
): Promise<CashOutBetResult> {
  const { userId, betId, quotedGross, now, config } = input;
  if (typeof quotedGross !== 'bigint' || quotedGross <= 0n) {
    throw domainUnprocessable('invalid_amount', 'The cash-out amount must be positive.');
  }
  if (!isUuid(betId) || !isUuid(userId)) throw domainNotFound('Bet');
  const [bet] = await tx
    .select()
    .from(bets)
    .where(and(eq(bets.id, betId), eq(bets.userId, userId)))
    .for('update');
  if (bet === undefined) throw domainNotFound('Bet');

  await lockUser(tx, userId);

  const [previous] = await tx
    .select()
    .from(betCashouts)
    .where(
      and(eq(betCashouts.userId, userId), eq(betCashouts.idempotencyKey, input.idempotencyKey)),
    )
    .limit(1);
  if (previous !== undefined) {
    if (previous.betId !== bet.id || previous.quotedGross !== quotedGross) {
      throw domainUnprocessable(
        'idempotency_key_reused',
        'This Idempotency-Key was already used for a different cash-out.',
      );
    }
    const view = await getUserBet(tx, userId, bet.id);
    if (view === null) throw new Error(`bet ${bet.id} vanished`);
    return {
      bet: view,
      cashOut: {
        gross: previous.gross,
        tax: previous.tax,
        net: previous.net,
        cashedOutAt: previous.createdAt,
      },
      replayed: true,
    };
  }
  if (bet.status !== 'open') throw cashOutUnavailableError('bet_not_open');

  const legRows = await tx
    .select()
    .from(betLegs)
    .where(eq(betLegs.betId, bet.id))
    .orderBy(asc(betLegs.position));
  const eventIds = [...new Set(legRows.map((leg) => leg.eventId))].sort();
  const marketIds = [...new Set(legRows.map((leg) => leg.marketId))].sort();
  const selectionIds = [...new Set(legRows.map((leg) => leg.selectionId))].sort();
  if (eventIds.length > 0) {
    await tx
      .select({ id: events.id })
      .from(events)
      .where(inArray(events.id, eventIds))
      .orderBy(asc(events.id))
      .for('share');
  }
  if (marketIds.length > 0) {
    await tx
      .select({ id: markets.id })
      .from(markets)
      .where(inArray(markets.id, marketIds))
      .orderBy(asc(markets.id))
      .for('share');
  }
  if (selectionIds.length > 0) {
    await tx
      .select({ id: selections.id })
      .from(selections)
      .where(inArray(selections.id, selectionIds))
      .orderBy(asc(selections.id))
      .for('share');
  }
  // A fresh statement after the locks: it sees every change committed before them.
  const snapshots = await loadSelectionSnapshots(tx, selectionIds);
  const terms: BetTerms = parseTerms(bet.terms);
  const quote = priceCashOut(
    {
      id: bet.id,
      userId: bet.userId,
      status: bet.status,
      stake: bet.stake,
      terms,
      legs: legRows.map((leg) => {
        const selection = snapshots.get(leg.selectionId);
        if (selection === undefined) {
          throw new Error(`bet leg ${leg.id} references missing selection ${leg.selectionId}`);
        }
        return { id: leg.id, selectionId: leg.selectionId, oddsMilli: leg.oddsMilli, selection };
      }),
    },
    config,
    now,
  );
  if (!quote.available) throw cashOutUnavailableError(quote.reason ?? 'disabled');
  const accepted = cashOutPayout({ stake: bet.stake, gross: quotedGross, tax: terms.tax });
  if (quote.gross < accepted.gross || quote.net < accepted.net) {
    throw cashOutOfferChangedError(quote);
  }

  const amounts = { gross: quote.gross, tax: quote.tax, net: quote.net };
  const posting = await postTransaction(tx, {
    type: 'bet_cashout',
    idempotencyKey: cashOutLedgerKey(bet.id),
    refType: 'bet',
    refId: bet.id,
    description: 'Bet cashed out',
    actor: { type: 'user', id: userId },
    entries: cashOutEntries(userId, bet.stake, amounts),
  });
  if (!posting.created) {
    // The posting, the record and the status commit together, and only an open bet gets here.
    throw new Error(`cash-out posting ${posting.transactionId} exists for open bet ${bet.id}`);
  }
  await tx.insert(betCashouts).values({
    betId: bet.id,
    userId,
    idempotencyKey: input.idempotencyKey,
    quotedGross,
    ...amounts,
    marginBps: quote.marginBps,
    legs: quote.legs,
    createdAt: now,
  });
  const states = new Map(quote.legs.map((leg) => [leg.legId, leg.state]));
  const changed = new Map<LegState, string[]>();
  for (const leg of legRows) {
    const state = states.get(leg.id);
    if (state === undefined || state === leg.state) continue;
    changed.set(state, [...(changed.get(state) ?? []), leg.id]);
  }
  for (const [state, ids] of changed) {
    await tx.update(betLegs).set({ state, updatedAt: now }).where(inArray(betLegs.id, ids));
  }
  await tx
    .update(bets)
    .set({
      status: 'cashed_out',
      settledGrossPayout: amounts.gross,
      settledTax: amounts.tax,
      settledNetPayout: amounts.net,
      settledAt: now,
      settlementRetryAt: null,
      updatedAt: now,
    })
    .where(eq(bets.id, bet.id));

  await enqueueOutbox(tx, {
    type: BET_CASHED_OUT,
    aggregateType: 'bet',
    aggregateId: bet.id,
    payload: {
      betId: bet.id,
      userId,
      shortId: bet.shortId,
      stake: bet.stake,
      quotedGross,
      ...amounts,
      cashedOutAt: now,
    },
  });
  await writeAudit(tx, {
    actorType: 'user',
    actorId: userId,
    action: BET_CASHED_OUT,
    targetType: 'bet',
    targetId: bet.id,
    metadata: {
      shortId: bet.shortId,
      stake: bet.stake,
      quotedGross,
      ...amounts,
      marginBps: quote.marginBps,
      ledgerTransactionId: posting.transactionId,
    },
    ip: input.ip ?? null,
  });

  const view = await getUserBet(tx, userId, bet.id);
  if (view === null) throw new Error(`bet ${bet.id} vanished`);
  return { bet: view, cashOut: { ...amounts, cashedOutAt: now }, replayed: false };
}
