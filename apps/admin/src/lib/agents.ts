import { formatBpsPercent } from '@vamos/core';
import type { AgentCommissionKind, AgentSummaryView, AgentView } from '@vamos/contracts';

/** "10% of GGR", "5% of stake"; a dash for Nahubet HQ, which earns no commission. */
export function commissionText(
  agent: Pick<AgentView, 'isHouse' | 'commissionKind' | 'commissionBps'>,
): string {
  if (agent.isHouse) return '—';
  return `${formatBpsPercent(agent.commissionBps)}% of ${agent.commissionKind === 'ggr' ? 'GGR' : 'stake'}`;
}

export const COMMISSION_KIND_LABELS: Record<AgentCommissionKind, string> = {
  ggr: 'GGR (stake − winnings)',
  stake: 'Stake sold',
};

/**
 * An Ethiopian mobile number the way people dial it: `+251911223344` becomes `0911 22 33 44`.
 * Anything else is returned unchanged, and an empty value shows a dash.
 */
export function localPhone(phone: string | null | undefined): string {
  if (phone === null || phone === undefined || phone === '') return '—';
  const match = /^\+251([79]\d{8})$/.exec(phone);
  if (match === null) return phone;
  const digits = `0${match[1]}`;
  return `${digits.slice(0, 4)} ${digits.slice(4, 6)} ${digits.slice(6, 8)} ${digits.slice(8)}`;
}

/** Agents by number, HQ (1000) first. */
export function sortAgents<T extends Pick<AgentSummaryView, 'number'>>(agents: readonly T[]): T[] {
  return [...agents].sort((a, b) => a.number - b.number);
}

/** Shops by agent number, then shop number. */
export function sortShops<T extends { agentNumber: number; number: number }>(
  shops: readonly T[],
): T[] {
  return [...shops].sort((a, b) => a.agentNumber - b.agentNumber || a.number - b.number);
}

export const PERCENT_HINT = 'Use a percent from 0 to 100, at most 2 decimals';
