import { randomUUID } from 'node:crypto';
import { toWire, validateJackpotEntry, type Outcome1X2 } from '@vamos/core';
import { and, eq } from 'drizzle-orm';
import { isUuid } from '../betting/selections';
import { type DomainError, domainNotFound, domainUnprocessable } from '../errors';
import { InsufficientFundsError } from '../ledger/errors';
import { postTransaction } from '../ledger/post';
import type { DbTransaction, PostingEntry } from '../ledger/types';
import { writeAudit } from '../platform/audit';
import { enqueueOutbox } from '../platform/outbox';
import { assertCanGamble } from '../rg/exclusions';
import { assertStakeAllowed, lockUser } from '../rg/limits';
import { jackpotEntries, jackpotRounds } from '../schema/jackpots';
import { JACKPOT_ENTERED } from './events';
import { loadRoundGames, lockRoundEvents } from './games';
import { getUserJackpotEntry } from './queries';
import { jackpotClosedError } from './rounds';
import { parseRoundTerms, type JackpotChannel, type UserJackpotEntry } from './types';

/** Ledger idempotency key of an entry's payment (scoped by player, like every client key). */
export const jackpotEntryLedgerKey = (userId: string, idempotencyKey: string) =>
  `jackpot_entry:${userId}:${idempotencyKey}`;
/** Ledger idempotency key of an entry's prize: one per entry, ever. */
export const jackpotPrizeLedgerKey = (entryId: string) => `jackpot_prize:${entryId}`;
/** Ledger idempotency key of the refund of an entry of a void round: one per entry, ever. */
export const jackpotRefundLedgerKey = (entryId: string) => `jackpot_refund:${entryId}`;

const cash = (userId: string) => ({ kind: 'player_cash' as const, userId });

/** An entry's payment: player_cash −cost, house_jackpot +cost (type `jackpot_entry`). */
export function jackpotEntryEntries(userId: string, cost: bigint): PostingEntry[] {
  if (cost <= 0n) throw new RangeError('a jackpot entry costs a positive amount');
  return [
    { account: cash(userId), amount: -cost },
    { account: { kind: 'house_jackpot' }, amount: cost },
  ];
}

/**
 * The refund of an entry of a void round, the exact reversal of its
 * payment: house_jackpot −cost, player_cash +cost (type `jackpot_entry`).
 */
export function jackpotRefundEntries(userId: string, cost: bigint): PostingEntry[] {
  if (cost <= 0n) throw new RangeError('a jackpot refund is a positive amount');
  return [
    { account: { kind: 'house_jackpot' }, amount: -cost },
    { account: cash(userId), amount: cost },
  ];
}

/**
 * An entry's prize (type `jackpot_prize`): house_jackpot −gross, player_cash
 * +net, house_tax_payable +tax. The tax is withheld inside this one
 * transaction (like a bet payout), so the player's betting flows count
 * exactly the net received. Zero entries are left out. Throws RangeError on
 * amounts that do not add up.
 */
export function jackpotPrizeEntries(
  userId: string,
  prize: { gross: bigint; tax: bigint; net: bigint },
): PostingEntry[] {
  const { gross, tax, net } = prize;
  if (gross <= 0n) throw new RangeError('a jackpot prize is a positive amount');
  if (tax < 0n || net <= 0n) throw new RangeError('jackpot prize amounts must not be negative');
  if (gross !== net + tax) throw new RangeError('a jackpot prize must equal net plus tax');
  const entries: PostingEntry[] = [
    { account: { kind: 'house_jackpot' }, amount: -gross },
    { account: cash(userId), amount: net },
    { account: { kind: 'house_tax_payable' }, amount: tax },
  ];
  return entries.filter((entry) => entry.amount !== 0n);
}

/** Most games and picks per game a request may carry (the contract allows less). */
const MAX_REQUEST_GAMES = 64;
const MAX_REQUEST_PICKS = 8;

/** 422 `jackpot_entry_invalid`, details `{ errors, gameCount, combinations, maxCombinations }`. */
export function jackpotEntryInvalidError(
  errors: string[],
  details: {
    gameCount: number | null;
    combinations: number | null;
    maxCombinations: number | null;
  },
): DomainError {
  return domainUnprocessable(
    'jackpot_entry_invalid',
    errors[0] ?? 'This jackpot entry is not valid.',
    { errors, ...details },
  );
}

const ORDER: Record<string, number> = { '1': 0, X: 1, '2': 2 };

/**
 * The picks in canonical order ('1', 'X', '2' within each game; anything
 * else after them, unchanged, for validation to reject), or null when the
 * request is not an array of arrays of strings (or absurdly large).
 */
export function canonicalPicks(picks: unknown): string[][] | null {
  if (!Array.isArray(picks) || picks.length > MAX_REQUEST_GAMES) return null;
  const out: string[][] = [];
  for (const game of picks as unknown[]) {
    if (!Array.isArray(game) || game.length > MAX_REQUEST_PICKS) return null;
    const strings: unknown[] = game;
    if (!strings.every((pick): pick is string => typeof pick === 'string')) return null;
    out.push(
      [...strings].sort(
        (a, b) => (ORDER[a] ?? 3) - (ORDER[b] ?? 3) || (a < b ? -1 : a > b ? 1 : 0),
      ),
    );
  }
  return out;
}

function samePicks(a: readonly (readonly string[])[], b: readonly (readonly string[])[]): boolean {
  return (
    a.length === b.length &&
    a.every((game, i) => {
      const other = b[i];
      return (
        other !== undefined && game.length === other.length && game.every((p, j) => p === other[j])
      );
    })
  );
}

export interface PlaceJackpotEntryInput {
  userId: string;
  roundId: string;
  /** One array of picks per game, in game order ('1', 'X', '2'; any order within a game). */
  picks: readonly (readonly string[])[];
  /** The client's idempotency key (already validated: 8–100 printable characters). */
  idempotencyKey: string;
  now: Date;
  /** Default 'web'. */
  channel?: JackpotChannel;
  /** Client address for the audit log. */
  ip?: string | null;
}

export interface PlaceJackpotEntryResult {
  entry: UserJackpotEntry;
  /** true when the idempotency key had been used already: nothing was written. */
  replayed: boolean;
}

/**
 * Places a jackpot entry in the caller's transaction, in this order:
 * 1. the request's shape (an array of arrays of strings) → else 422
 *    `jackpot_entry_invalid`; an id that is not a UUID → 404 `not_found`;
 * 2. lockUser (serialises the player's money operations and replays);
 * 3. an entry with the same Idempotency-Key is returned as a replay
 *    (nothing written), even if the round has closed since; the key used
 *    for another round or other picks → 422 `idempotency_key_reused`;
 * 4. assertCanGamble (403 account / exclusion);
 * 5. the round is locked FOR SHARE (closing and settlement take it FOR
 *    UPDATE, so they wait for this entry, and see it): unknown → 404; not
 *    open, or `now` at or after closes_at → 409 `jackpot_closed`
 *    (details `{ reason: 'not_open' | 'closed', status }`);
 * 6. core validateJackpotEntry against the round's frozen template (game
 *    count, 1 to 3 distinct picks per game, at most maxCombinations) →
 *    422 `jackpot_entry_invalid` (details `{ errors, gameCount,
 *    combinations, maxCombinations }`); cost = combinations × the round's
 *    cost per combination;
 * 7. the games' events, then their 1X2 markets, are locked FOR SHARE (id
 *    order) and each must still be scheduled and kick off after `now` →
 *    else 409 `jackpot_closed` (reason `game_started`); its 1X2 market and
 *    selections open and events.betting_open → else 409 `jackpot_closed`
 *    (reason `game_suspended`);
 * 8. assertStakeAllowed(cost) (422 stake / loss limit), as for a bet;
 * 9. postTransaction(jackpot_entry) under `jackpot_entry:<userId>:<key>`:
 *    player_cash −cost, house_jackpot +cost (422 `insufficient_funds`,
 *    details `{ balance, cost }`);
 * 10. the entry (canonical picks), `jackpot.entered` and the audit record.
 */
export async function placeJackpotEntry(
  tx: DbTransaction,
  input: PlaceJackpotEntryInput,
): Promise<PlaceJackpotEntryResult> {
  const { now } = input;
  if (!isUuid(input.userId)) throw domainNotFound('User');
  // Lower case, as the database prints it: the ledger key and the guards use it.
  const userId = input.userId.toLowerCase();
  const channel = input.channel ?? 'web';
  const picks = canonicalPicks(input.picks);
  if (picks === null) {
    throw jackpotEntryInvalidError(['Picks must be a list of games, each a list of 1, X or 2.'], {
      gameCount: null,
      combinations: null,
      maxCombinations: null,
    });
  }
  if (!isUuid(input.roundId)) throw domainNotFound('Jackpot round');
  const roundId = input.roundId.toLowerCase();

  await lockUser(tx, userId);

  const [existing] = await tx
    .select()
    .from(jackpotEntries)
    .where(
      and(
        eq(jackpotEntries.userId, userId),
        eq(jackpotEntries.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (existing !== undefined) {
    if (
      existing.roundId !== roundId ||
      existing.channel !== channel ||
      !samePicks(existing.picks, picks)
    ) {
      throw domainUnprocessable(
        'idempotency_key_reused',
        'This Idempotency-Key was already used for a different jackpot entry.',
      );
    }
    const entry = await getUserJackpotEntry(tx, userId, existing.id);
    if (entry === null) throw new Error(`jackpot entry ${existing.id} vanished`);
    return { entry, replayed: true };
  }

  await assertCanGamble(tx, userId, now);

  const [round] = await tx
    .select()
    .from(jackpotRounds)
    .where(eq(jackpotRounds.id, roundId))
    .for('share');
  if (round === undefined) throw domainNotFound('Jackpot round');
  if (round.status === 'scheduled') throw jackpotClosedError('not_open', round.status);
  if (round.status !== 'open' || now.getTime() >= round.closesAt.getTime()) {
    throw jackpotClosedError('closed', round.status);
  }
  const { template } = parseRoundTerms(round.terms);
  const check = validateJackpotEntry(picks as Outcome1X2[][], template);
  if (!check.ok) {
    throw jackpotEntryInvalidError(check.errors, {
      gameCount: template.gameCount,
      combinations: check.combinations,
      maxCombinations: template.maxCombinations,
    });
  }
  const cost = check.cost;
  if (cost !== BigInt(check.combinations) * round.costPerCombination || cost <= 0n) {
    throw new Error(`jackpot round ${round.id}: terms and columns disagree on the price`);
  }

  await lockRoundEvents(tx, round.id, { markets: true });
  const games = await loadRoundGames(tx, round.id);
  if (games.length !== round.gameCount) {
    throw new Error(`jackpot round ${round.id} has ${games.length} of ${round.gameCount} games`);
  }
  const started = games.some(
    (game) => game.eventStatus !== 'scheduled' || game.startTime.getTime() <= now.getTime(),
  );
  if (started) throw jackpotClosedError('game_started', round.status);
  // A trader's (or the feed's) halt on a game stops jackpot entries as it stops bets.
  if (games.some((game) => game.odds === null || !game.bettingOpen)) {
    throw jackpotClosedError('game_suspended', round.status);
  }

  await assertStakeAllowed(tx, userId, cost, now);

  const entryId = randomUUID();
  try {
    const posting = await postTransaction(tx, {
      type: 'jackpot_entry',
      idempotencyKey: jackpotEntryLedgerKey(userId, input.idempotencyKey),
      refType: 'jackpot_entry',
      refId: entryId,
      description: `Jackpot entry (${template.code}, ${check.combinations} combination${check.combinations === 1 ? '' : 's'})`,
      actor: { type: 'user', id: userId },
      entries: jackpotEntryEntries(userId, cost),
    });
    if (!posting.created) {
      // Entries and their payment commit together, so this key cannot exist without the entry.
      throw new Error(`jackpot entry posting ${posting.transactionId} exists without its entry`);
    }
  } catch (error) {
    if (error instanceof InsufficientFundsError) {
      throw domainUnprocessable('insufficient_funds', 'Your balance is too low for this entry.', {
        balance: toWire(error.available),
        cost: toWire(cost),
      });
    }
    throw error;
  }

  await tx.insert(jackpotEntries).values({
    id: entryId,
    roundId: round.id,
    userId,
    picks: picks as Outcome1X2[][],
    combinations: check.combinations,
    cost,
    channel,
    idempotencyKey: input.idempotencyKey,
    status: 'open',
    placedAt: now,
    updatedAt: now,
  });
  const details = {
    entryId,
    roundId: round.id,
    userId,
    templateCode: template.code,
    combinations: check.combinations,
    cost,
    channel,
  };
  await enqueueOutbox(tx, {
    type: JACKPOT_ENTERED,
    aggregateType: 'jackpot_entry',
    aggregateId: entryId,
    payload: details,
  });
  await writeAudit(tx, {
    actorType: 'user',
    actorId: userId,
    action: JACKPOT_ENTERED,
    targetType: 'jackpot_entry',
    targetId: entryId,
    metadata: details,
    ip: input.ip ?? null,
  });

  const entry = await getUserJackpotEntry(tx, userId, entryId);
  if (entry === null) throw new Error(`jackpot entry ${entryId} was not inserted`);
  return { entry, replayed: false };
}
