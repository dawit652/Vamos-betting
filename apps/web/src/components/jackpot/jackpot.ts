import { combinationCount } from '@vamos/core';
import type {
  JackpotClosedDetails,
  JackpotEntryRequest,
  JackpotEntryStatus,
  JackpotGameResult,
  JackpotOutcome,
  JackpotRoundStatus,
  JackpotTemplateCode,
} from '@vamos/contracts';
import type { MessageKey } from '@vamos/i18n/translate';
import type { Tone } from '../account/bets';

/** Display and pick rules of the jackpot screens (pure; the components only render). */

export const OUTCOMES: readonly JackpotOutcome[] = ['1', 'X', '2'];

export const TEMPLATE_CODES: readonly JackpotTemplateCode[] = ['daily9', 'weekly13'];

/** The picks of one entry in progress: for each game the chosen outcomes, in 1, X, 2 order. */
export type Picks = readonly (readonly JackpotOutcome[])[];

export function emptyPicks(games: number): JackpotOutcome[][] {
  return Array.from({ length: games }, () => []);
}

/** `?tab=` of the jackpot page: a known template code, else the first. */
export function templateTab(raw: string | undefined): JackpotTemplateCode {
  return TEMPLATE_CODES.find((code) => code === raw) ?? 'daily9';
}

/** Adds the outcome to a game's picks, or removes it when already picked. Returns new arrays. */
export function togglePick(
  picks: Picks,
  game: number,
  outcome: JackpotOutcome,
): JackpotOutcome[][] {
  return picks.map((current, index) => {
    if (index !== game) return [...current];
    const has = current.includes(outcome);
    const next = has ? current.filter((o) => o !== outcome) : [...current, outcome];
    return OUTCOMES.filter((o) => next.includes(o));
  });
}

export interface PicksSummary {
  /** Games with at least one pick. */
  picked: number;
  total: number;
  /** Every game has a pick. */
  complete: boolean;
  /** Ways to choose one pick per game; 0 while a game has no pick. */
  combinations: number;
  /** combinations × cost per combination, a santim wire string. */
  cost: string;
  /** More combinations than the round allows. */
  overMax: boolean;
  /** Complete and within the limit: the entry can be placed. */
  valid: boolean;
}

export function summarizePicks(
  picks: Picks,
  terms: { costPerCombination: string; maxCombinations: number },
): PicksSummary {
  const picked = picks.filter((game) => game.length > 0).length;
  const complete = picks.length > 0 && picked === picks.length;
  let combinations: number;
  try {
    combinations = combinationCount(picks);
  } catch {
    combinations = Number.MAX_SAFE_INTEGER;
  }
  const cost = (BigInt(combinations) * BigInt(terms.costPerCombination)).toString();
  const overMax = combinations > terms.maxCombinations;
  return {
    picked,
    total: picks.length,
    complete,
    combinations,
    cost,
    overMax,
    valid: complete && !overMax,
  };
}

/** The POST /jackpots/:id/entries body. */
export function entryRequest(picks: Picks): JackpotEntryRequest {
  return { picks: picks.map((game) => OUTCOMES.filter((o) => game.includes(o))) };
}

/** Identifies one intent (round and picks): the idempotency key is reused only for the same one. */
export function entryFingerprint(roundId: string, picks: Picks): string {
  return `${roundId}:${picks.map((game) => game.join('')).join('|')}`;
}

// ---------------------------------------------------------------- statuses

export const ENTRY_STATUS_LABEL: Readonly<Record<JackpotEntryStatus, MessageKey>> = {
  open: 'account.jackpot.status.open',
  won: 'account.jackpot.status.won',
  lost: 'account.jackpot.status.lost',
  void: 'account.jackpot.status.void',
};

const ENTRY_TONE: Readonly<Record<JackpotEntryStatus, Tone>> = {
  open: 'neutral',
  won: 'positive',
  lost: 'negative',
  void: 'muted',
};

export function entryStatusTone(status: JackpotEntryStatus): Tone {
  return ENTRY_TONE[status];
}

export const ROUND_STATUS_LABEL: Readonly<Record<JackpotRoundStatus, MessageKey>> = {
  scheduled: 'account.jackpot.roundStatus.scheduled',
  open: 'account.jackpot.roundStatus.open',
  closed: 'account.jackpot.roundStatus.closed',
  settled: 'account.jackpot.roundStatus.settled',
  cancelled: 'account.jackpot.roundStatus.cancelled',
};

const ROUND_TONE: Readonly<Record<JackpotRoundStatus, Tone>> = {
  scheduled: 'pending',
  open: 'positive',
  closed: 'neutral',
  settled: 'muted',
  cancelled: 'muted',
};

export function roundStatusTone(status: JackpotRoundStatus): Tone {
  return ROUND_TONE[status];
}

/** How one pick stands against its game's result. */
export type PickState = 'open' | 'hit' | 'miss' | 'cancelled';

export function pickState(pick: JackpotOutcome, result: JackpotGameResult | null): PickState {
  if (result === null) return 'open';
  if (result === 'cancelled') return 'cancelled';
  return pick === result ? 'hit' : 'miss';
}

export const PICK_STATE_CLASS: Readonly<Record<PickState, string>> = {
  open: 'bg-line text-ink',
  hit: 'bg-up text-white',
  miss: 'bg-line text-muted line-through',
  cancelled: 'bg-line text-muted',
};

/** Whether the round still takes entries by the clock (the server decides; this hides dead forms). */
export function takesEntries(
  round: { status: JackpotRoundStatus; closesAt: string },
  nowMs: number,
): boolean {
  return round.status === 'open' && Date.parse(round.closesAt) > nowMs;
}

// ------------------------------------------------------------------ errors

/** Placement error codes the jackpot form explains itself (for errorMessageKey). */
export const ENTRY_ERROR_KEYS: Readonly<Record<string, MessageKey>> = {
  jackpot_closed: 'account.jackpot.errors.closed',
  jackpot_entry_invalid: 'account.jackpot.errors.invalid',
  insufficient_funds: 'sportsbook.betslip.insufficientFunds',
  stake_limit_exceeded: 'sportsbook.betslip.errors.stakeLimit',
  loss_limit_exceeded: 'sportsbook.betslip.errors.lossLimit',
  self_excluded: 'sportsbook.betslip.errors.excluded',
  cooling_off: 'sportsbook.betslip.errors.excluded',
  account_disabled: 'sportsbook.betslip.errors.excluded',
};

/** The message of a 409 `jackpot_closed`, by its reason (the generic one when unreadable). */
export function closedMessageKey(details: unknown): MessageKey {
  const reason = (details as Partial<JackpotClosedDetails> | null | undefined)?.reason;
  if (reason === 'game_started') return 'account.jackpot.errors.gameStarted';
  if (reason === 'not_open') return 'account.jackpot.errors.notOpen';
  return 'account.jackpot.errors.closed';
}
