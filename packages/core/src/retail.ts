/**
 * Agent shops (docs/plans/agent-shops.md): numbers printed on tickets, receipts and reports.
 * Agent 1000 is Nahubet HQ; agents count up from 1001; each agent's shops count from 1, printed
 * with at least two digits after the agent number: agent 1001, shop 1 → `1001-01`.
 */

/** Nahubet HQ's agent number. */
export const HOUSE_AGENT_NUMBER = 1000;
/** The first number given to an independent agent. */
export const FIRST_AGENT_NUMBER = 1001;
export const MAX_AGENT_NUMBER = 999_999;
/** Shops per agent are numbered 1 to MAX_SHOP_NUMBER. */
export const MAX_SHOP_NUMBER = 999;

const SHOP_LABEL = /^([0-9]{4,6})-([0-9]{2,3})$/;

function isAgentNumber(n: number): boolean {
  return Number.isInteger(n) && n >= HOUSE_AGENT_NUMBER && n <= MAX_AGENT_NUMBER;
}

function isShopNumber(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= MAX_SHOP_NUMBER;
}

/** `1001-01` for agent 1001's first shop. Throws on numbers outside the ranges. */
export function formatShopLabel(agentNumber: number, shopNumber: number): string {
  if (!isAgentNumber(agentNumber)) throw new RangeError(`bad agent number ${agentNumber}`);
  if (!isShopNumber(shopNumber)) throw new RangeError(`bad shop number ${shopNumber}`);
  return `${agentNumber}-${String(shopNumber).padStart(2, '0')}`;
}

/**
 * Reads a shop label typed by staff (`1001-01`, `1001-7` is refused: two or three digits after the
 * dash, as printed). Null for anything else, including numbers out of range and leading zeros on
 * the agent number.
 */
export function parseShopLabel(label: string): { agentNumber: number; shopNumber: number } | null {
  const match = SHOP_LABEL.exec(label.trim());
  if (!match) return null;
  const [, agentPart, shopPart] = match;
  if (agentPart === undefined || shopPart === undefined || agentPart.startsWith('0')) return null;
  const agentNumber = Number(agentPart);
  const shopNumber = Number(shopPart);
  if (!isAgentNumber(agentNumber) || !isShopNumber(shopNumber)) return null;
  // One spelling per shop: `1001-01`, never `1001-001`.
  if (formatShopLabel(agentNumber, shopNumber) !== label.trim()) return null;
  return { agentNumber, shopNumber };
}

/** The next free number after the highest in use (`null` when none is in use yet). */
export function nextAgentNumber(highest: number | null): number {
  if (highest === null || highest < FIRST_AGENT_NUMBER) return FIRST_AGENT_NUMBER;
  if (highest >= MAX_AGENT_NUMBER) throw new RangeError('no agent number left');
  return highest + 1;
}

/** Commission percent typed by staff (`10`, `12.5`, `7.25`) in basis points; null when invalid. */
export function parsePercentBps(input: string): number | null {
  const match = /^([0-9]{1,3})(?:\.([0-9]{1,2}))?$/.exec(input.trim());
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? '').padEnd(2, '0'));
  const bps = whole * 100 + fraction;
  return bps <= 10_000 ? bps : null;
}

/** Basis points as a percent for display: 1250 → `12.5`, 1000 → `10`, 725 → `7.25`. */
export function formatBpsPercent(bps: number): string {
  if (!Number.isInteger(bps) || bps < 0) throw new RangeError(`bad basis points ${bps}`);
  const whole = Math.floor(bps / 100);
  const fraction = bps % 100;
  if (fraction === 0) return String(whole);
  return `${whole}.${String(fraction).padStart(2, '0').replace(/0$/, '')}`;
}

/** How an agent's commission is counted (the admin sets it per agent). */
export type AgentCommissionKind = 'stake' | 'ggr';

/**
 * An agent's commission for one week (docs/plans/agent-shops.md, phase 5): `stake` = the stakes
 * sold minus the stakes cancelled, `ggr` = the week's GGR (settled stakes minus settled gross
 * payouts), nothing for a week below zero; times `bps` / 10000, rounded down. Never negative.
 */
export function agentCommission(input: {
  kind: AgentCommissionKind;
  bps: number;
  soldStakes: bigint;
  cancelledStakes: bigint;
  ggr: bigint;
}): bigint {
  if (!Number.isInteger(input.bps) || input.bps < 0 || input.bps > 10_000) {
    throw new RangeError(`bad commission basis points ${input.bps}`);
  }
  const base = input.kind === 'stake' ? input.soldStakes - input.cancelledStakes : input.ggr;
  if (base <= 0n) return 0n;
  return (base * BigInt(input.bps)) / 10_000n;
}
