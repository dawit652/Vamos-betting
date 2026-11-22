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

/** A new withdrawal code (G4): six digits, no leading zero, read out at any shop's desk. */
export function newWithdrawalCode(): string {
  return randomInt(100_000, 1_000_000).toString();
}

/** Only this keyed hash of a withdrawal code is stored; the desk finds the code by it alone. */
export function withdrawalCodeHash(secret: string, code: string): string {
  return hmacSha256Hex(secret, `withdraw:${code.trim()}`);
}
