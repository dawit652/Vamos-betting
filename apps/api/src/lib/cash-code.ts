import { randomInt } from 'node:crypto';
import { hmacSha256Hex } from './crypto';

/** A new six-digit shop code (docs/plans/cashier-dashboard.md, cash withdrawals). */
export function newCashCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/** Only this keyed hash of a shop code is stored (cash_withdrawal_codes). */
export function cashCodeHash(secret: string, userId: string, code: string): string {
  return hmacSha256Hex(secret, `cash:${userId}:${code.trim()}`);
}
