/**
 * The agent's top-up balance on the desk (owner, 24 Nov 2026): Nahubet HQ tops an agent up, and a
 * ticket's stake and a player's deposit at its shops leave that balance. The server refuses a
 * ticket above it (409 `agent_balance_low`); the desk shows how much is left and tells the
 * cashier to ask the agent owner for a top-up before it runs out.
 */
export type TopUpState = 'ok' | 'low' | 'empty';

/**
 * Empty at zero or less; low at or below `lowAt` (HQ's low-balance threshold); null at Nahubet
 * HQ's own shops, which have no top-up balance. Amounts are santim strings.
 */
export function topUpState(balance: string | null, lowAt: string | null): TopUpState | null {
  const left = santim(balance);
  if (left === null) return null;
  if (left <= 0n) return 'empty';
  const threshold = santim(lowAt);
  if (threshold !== null && left <= threshold) return 'low';
  return 'ok';
}

/** The stake is above what is left of the top-up balance (the sale would be refused). */
export function stakeAboveBalance(stake: string | null, balance: string | null): boolean {
  const amount = santim(stake);
  const left = santim(balance);
  return amount !== null && left !== null && amount > left;
}

function santim(value: string | null): bigint | null {
  if (value === null || !/^-?\d{1,18}$/.test(value)) return null;
  return BigInt(value);
}
