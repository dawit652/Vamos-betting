import { createHash } from 'node:crypto';
import type {
  BetRules,
  ChannelRefusal,
  LossLimitPeriod,
  PickCode,
  PlacedBetSummary,
  UnavailablePickReason,
} from '@vamos/core';
import { placeBet, type GameSettingsForBets } from '../betting/place';
import type { UserBet } from '../betting/types';
import { DomainError } from '../errors';
import type { DbTransaction } from '../ledger/types';

/** The channels a bet can arrive by other than the web. */
export type ChannelKind = 'sms' | 'ussd';

/** One leg of a channel bet: the selection and the price it is placed at. */
export interface ChannelBetLeg {
  gameId: number;
  pick: PickCode;
  selectionId: string;
  /**
   * The odds the bet is placed at (policy 'none'): for SMS the price read
   * when the text was handled (the player cannot see odds), for USSD the
   * price the confirm screen showed.
   */
  oddsMilli: number;
}

export interface PlaceChannelBetInput {
  userId: string;
  channel: ChannelKind;
  legs: readonly ChannelBetLeg[];
  /** Santim. */
  stake: bigint;
  /** smsBetKey / ussdBetKey. */
  idempotencyKey: string;
  now: Date;
  /** loadGameSettings() in the same transaction; the bet keeps these terms. */
  settings: GameSettingsForBets;
  randomBytes: (size: number) => Uint8Array;
  ip?: string | null;
}

export type PlaceChannelBetResult =
  | { ok: true; bet: UserBet; replayed: boolean }
  | { ok: false; refusal: ChannelRefusal; error: DomainError };

/**
 * Places a bet received by SMS or USSD with placeBet, exactly as the web
 * does (player lock, idempotency, account status, exclusions, stake and loss
 * limits, bettability, bet rules, max payout, the bet_stake posting, live
 * acceptance delay, outbox and audit), with the odds-change policy 'none'
 * against each leg's oddsMilli and the given channel.
 *
 * It runs in a savepoint of the caller's transaction: a refusal (any
 * DomainError, e.g. insufficient funds or self-exclusion) rolls the
 * savepoint back and is returned as a ChannelRefusal with nothing written,
 * leaving the caller's transaction usable to record it. Anything else is
 * thrown, and the caller's transaction must roll back.
 */
export async function placeChannelBet(
  tx: DbTransaction,
  input: PlaceChannelBetInput,
): Promise<PlaceChannelBetResult> {
  try {
    const result = await tx.transaction((sp) =>
      placeBet(sp, {
        userId: input.userId,
        legs: input.legs.map((leg) => ({ selectionId: leg.selectionId, oddsMilli: leg.oddsMilli })),
        stake: input.stake,
        policy: 'none',
        channel: input.channel,
        idempotencyKey: input.idempotencyKey,
        now: input.now,
        settings: input.settings,
        randomBytes: input.randomBytes,
        ip: input.ip ?? null,
      }),
    );
    return { ok: true, bet: result.bet, replayed: result.replayed };
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return {
      ok: false,
      refusal: channelRefusalOf(error, input.legs, input.settings.betRules),
      error,
    };
  }
}

/** What the reply of a placed bet shows. */
export function placedBetSummary(bet: UserBet): PlacedBetSummary {
  return {
    shortId: bet.shortId,
    legs: bet.legs.length,
    totalOddsMilli: bet.totalOddsMilli,
    stake: bet.stake,
    potentialNetPayout: bet.potentialNetPayout,
    pendingAcceptance: bet.status === 'pending_acceptance',
  };
}

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

/** Idempotency key of the bet an inbound SMS places (68 characters). */
export function smsBetKey(aggregator: string, messageId: string): string {
  return `sms:${sha256(`${aggregator}\n${messageId}`)}`;
}

/** Idempotency key of the bet placed at callback number `callback` of a USSD session. */
export function ussdBetKey(aggregator: string, sessionId: string, callback: number): string {
  if (!Number.isSafeInteger(callback) || callback < 1) {
    throw new RangeError(`callback must be a positive integer, got ${callback}`);
  }
  return `ussd:${sha256(`${aggregator}\n${sessionId}`)}:${callback}`;
}

// ---------------------------------------------------------------- refusals

type Details = Record<string, unknown>;

function detailsOf(error: DomainError): Details {
  return typeof error.details === 'object' && error.details !== null
    ? (error.details as Details)
    : {};
}

function santimOf(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^-?\d{1,20}$/.test(value)) return BigInt(value);
  return null;
}

function dateOf(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function firstOf(value: unknown): Details | null {
  if (!Array.isArray(value)) return null;
  const first: unknown = value[0];
  return typeof first === 'object' && first !== null ? (first as Details) : null;
}

function legOf(legs: readonly ChannelBetLeg[], selectionId: unknown): ChannelBetLeg | undefined {
  if (typeof selectionId !== 'string') return undefined;
  const id = selectionId.toLowerCase();
  return legs.find((leg) => leg.selectionId.toLowerCase() === id);
}

const UNAVAILABLE_REASONS: ReadonlySet<string> = new Set<UnavailablePickReason>([
  'event_started',
  'event_closed',
  'suspended',
  'market_closed',
]);
const LOSS_PERIODS: ReadonlySet<string> = new Set<LossLimitPeriod>(['day', 'week', 'month']);

function selectionRefusal(details: Details, legs: readonly ChannelBetLeg[]): ChannelRefusal {
  const first = firstOf(details.selections);
  const leg = legOf(legs, first?.selectionId) ?? legs[0];
  if (leg === undefined) return { code: 'bet_failed' };
  const reason = first?.reason;
  if (reason === 'inactive') {
    return { code: 'pick_unavailable', gameId: leg.gameId, pick: leg.pick, reason: 'event_closed' };
  }
  if (typeof reason === 'string' && UNAVAILABLE_REASONS.has(reason)) {
    return {
      code: 'pick_unavailable',
      gameId: leg.gameId,
      pick: leg.pick,
      reason: reason as UnavailablePickReason,
    };
  }
  return { code: 'pick_not_offered', gameId: leg.gameId, pick: leg.pick };
}

function slipRefusal(
  details: Details,
  legs: readonly ChannelBetLeg[],
  rules: BetRules,
): ChannelRefusal {
  const first = firstOf(details.errors);
  switch (first?.code) {
    case 'stake_below_minimum':
      return { code: 'stake_below_minimum', min: rules.minStake };
    case 'stake_above_maximum':
      return { code: 'stake_above_maximum', max: rules.maxStake };
    case 'too_many_legs':
      return { code: 'too_many_legs', max: rules.maxLegs };
    case 'odds_below_minimum':
      return { code: 'odds_below_minimum', minOddsMilli: rules.minLegOddsMilli };
    case 'total_odds_above_maximum':
      return { code: 'total_odds_above_maximum' };
    case 'duplicate_event':
    case 'duplicate_selection': {
      const leg = legOf(legs, first.selectionId) ?? legs[0];
      return leg === undefined
        ? { code: 'bet_failed' }
        : { code: 'duplicate_game', gameId: leg.gameId };
    }
    default:
      return { code: 'bet_failed' };
  }
}

/**
 * The ChannelRefusal a placeBet DomainError stands for; `bet_failed` for
 * anything unexpected (the reply then asks the player to try again later).
 */
export function channelRefusalOf(
  error: DomainError,
  legs: readonly ChannelBetLeg[],
  rules: BetRules,
): ChannelRefusal {
  const details = detailsOf(error);
  switch (error.code) {
    case 'selection_unavailable':
      return selectionRefusal(details, legs);
    case 'odds_changed': {
      const odds = firstOf(details.changes)?.currentOddsMilli;
      return { code: 'odds_changed', oddsMilli: typeof odds === 'number' ? odds : null };
    }
    case 'slip_invalid':
      return slipRefusal(details, legs, rules);
    case 'insufficient_funds': {
      const balance = santimOf(details.balance);
      const stake = santimOf(details.stake);
      if (balance === null || stake === null) return { code: 'bet_failed' };
      return { code: 'insufficient_funds', balance: balance < 0n ? 0n : balance, stake };
    }
    case 'self_excluded':
      return { code: 'self_excluded', until: dateOf(details.endsAt) };
    case 'cooling_off':
      return { code: 'cooling_off', until: dateOf(details.endsAt) };
    case 'account_disabled':
      return { code: 'account_disabled' };
    case 'liability_limit':
      // `maxStake` is null when even the minimum stake does not fit.
      return { code: 'liability_limit', max: santimOf(details.maxStake) };
    case 'stake_limit_exceeded': {
      const limit = santimOf(details.limit);
      return limit === null ? { code: 'bet_failed' } : { code: 'stake_limit_exceeded', limit };
    }
    case 'loss_limit_exceeded': {
      const limit = santimOf(details.limit);
      const period = details.period;
      if (limit === null || typeof period !== 'string' || !LOSS_PERIODS.has(period)) {
        return { code: 'bet_failed' };
      }
      return { code: 'loss_limit_exceeded', period: period as LossLimitPeriod, limit };
    }
    default:
      return { code: 'bet_failed' };
  }
}
