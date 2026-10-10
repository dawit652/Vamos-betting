import type { BetStatus, BetView, LegState } from '@vamos/contracts';
import type { MessageKey } from '@vamos/i18n/translate';

/** Display rules for My Bets (pure). */

export type Tone = 'neutral' | 'pending' | 'positive' | 'negative' | 'muted';

export const BET_STATUS_LABEL: Readonly<Record<BetStatus, MessageKey>> = {
  pending_acceptance: 'account.myBets.status.pending_acceptance',
  open: 'account.myBets.status.open',
  won: 'account.myBets.status.won',
  lost: 'account.myBets.status.lost',
  void: 'account.myBets.status.void',
  cashed_out: 'account.myBets.status.cashed_out',
  rejected: 'account.myBets.status.rejected',
};

export const LEG_STATE_LABEL: Readonly<Record<LegState, MessageKey>> = {
  open: 'account.myBets.leg.open',
  won: 'account.myBets.leg.won',
  lost: 'account.myBets.leg.lost',
  void: 'account.myBets.leg.void',
};

const STATUS_TONE: Readonly<Record<BetStatus, Tone>> = {
  pending_acceptance: 'pending',
  open: 'neutral',
  won: 'positive',
  cashed_out: 'positive',
  lost: 'negative',
  void: 'muted',
  rejected: 'muted',
};

const LEG_TONE: Readonly<Record<LegState, Tone>> = {
  open: 'neutral',
  won: 'positive',
  lost: 'negative',
  void: 'muted',
};

export function betStatusTone(status: BetStatus): Tone {
  return STATUS_TONE[status];
}

export function legStateTone(state: LegState): Tone {
  return LEG_TONE[state];
}

/** Tailwind classes of a status chip. */
export const TONE_CLASS: Readonly<Record<Tone, string>> = {
  neutral: 'bg-brand-soft text-brand',
  pending: 'bg-demo-bg text-demo-ink',
  positive: 'bg-up text-white',
  negative: 'bg-down text-white',
  muted: 'bg-line text-muted',
};

export function isSettledStatus(status: BetStatus): boolean {
  return status !== 'open' && status !== 'pending_acceptance';
}

/**
 * The money line of a bet card: while open, the possible net win; once settled,
 * what was paid (0 for a lost bet, the refund for a void or rejected one).
 * Amounts stay santim wire strings.
 */
export function betPayout(bet: Pick<BetView, 'status' | 'stake' | 'potentialNet' | 'settledNet'>): {
  label: MessageKey;
  amount: string;
} {
  switch (bet.status) {
    case 'open':
    case 'pending_acceptance':
      return { label: 'account.myBets.potentialWin', amount: bet.potentialNet };
    case 'won':
      return { label: 'account.myBets.paidOut', amount: bet.settledNet ?? bet.potentialNet };
    case 'cashed_out':
      return { label: 'account.myBets.cashedOut', amount: bet.settledNet ?? '0' };
    case 'lost':
      return { label: 'account.myBets.paidOut', amount: bet.settledNet ?? '0' };
    case 'void':
    case 'rejected':
      return { label: 'account.myBets.refunded', amount: bet.settledNet ?? bet.stake };
  }
}

/** "3.5%" from basis points (350); "" when there is no bonus. */
export function bonusPercent(bps: number): string {
  if (!Number.isInteger(bps) || bps <= 0) return '';
  const whole = Math.trunc(bps / 100);
  const rest = bps % 100;
  if (rest === 0) return `${whole}%`;
  return `${whole}.${String(rest).padStart(2, '0').replace(/0$/, '')}%`;
}

/** True when a santim wire string is above zero. */
export function isPositiveAmount(wire: string | null | undefined): boolean {
  return typeof wire === 'string' && /^\d+$/.test(wire) && /[1-9]/.test(wire);
}

/** `?tab=` of My Bets: "settled" or the default "open". */
export function betTab(raw: string | undefined): 'open' | 'settled' {
  return raw === 'settled' ? 'settled' : 'open';
}
