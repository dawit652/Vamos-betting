import type { WalletTransaction } from '@vamos/contracts';
import { parseBirr, toWire } from '@vamos/core';
import type { MessageKey } from '@vamos/i18n/translate';
import { formatSantim } from '@/lib/format';

type TransactionType = WalletTransaction['type'];

/** Wallet statement and play-money top-up rules (pure). */

export const TRANSACTION_LABEL: Readonly<Record<TransactionType, MessageKey>> = {
  demo_topup: 'account.wallet.tx.demo_topup',
  deposit: 'account.wallet.tx.deposit',
  withdrawal: 'account.wallet.tx.withdrawal',
  withdrawal_reversal: 'account.wallet.tx.withdrawal_reversal',
  bet_stake: 'account.wallet.tx.bet_stake',
  bet_payout: 'account.wallet.tx.bet_payout',
  bet_refund: 'account.wallet.tx.bet_refund',
  bet_cashout: 'account.wallet.tx.bet_cashout',
  tax_withholding: 'account.wallet.tx.tax_withholding',
  settlement_reversal: 'account.wallet.tx.settlement_reversal',
  bonus: 'account.wallet.tx.bonus',
  adjustment: 'account.wallet.tx.adjustment',
  jackpot_entry: 'account.wallet.tx.jackpot_entry',
  jackpot_prize: 'account.wallet.tx.jackpot_prize',
};

/** The sign of a santim wire string: credit, debit or zero. */
export function amountDirection(wire: string): 'credit' | 'debit' | 'zero' {
  if (!/^-?\d+$/.test(wire)) return 'zero';
  if (!/[1-9]/.test(wire)) return 'zero';
  return wire.startsWith('-') ? 'debit' : 'credit';
}

/** "+1,000.00" / "-25.00" / "0.00" from a signed santim wire string. */
export function formatSignedSantim(wire: string): string {
  const direction = amountDirection(wire);
  if (direction === 'zero') return formatSantim(/^-?\d+$/.test(wire) ? '0' : wire);
  const text = formatSantim(wire.startsWith('-') ? wire.slice(1) : wire);
  return direction === 'debit' ? `-${text}` : `+${text}`;
}

/** Play-money top-up choices in santim (the API accepts 1 to 5,000 ETB). */
export const DEMO_TOPUP_AMOUNTS: readonly string[] = [
  toWire(parseBirr('100')),
  toWire(parseBirr('500')),
  toWire(parseBirr('1000')),
  toWire(parseBirr('5000')),
];
export const DEFAULT_DEMO_TOPUP: string = toWire(parseBirr('1000'));

/** Appends a page to a list, dropping items already shown (a page may overlap after inserts). */
export function appendPage<T extends { id: string }>(
  current: readonly T[],
  page: readonly T[],
): T[] {
  const seen = new Set(current.map((item) => item.id));
  return [...current, ...page.filter((item) => !seen.has(item.id))];
}

/** "1,000" for a whole-birr amount, else the usual "12.50" (chips, short labels). */
export function formatWholeBirr(wire: string): string {
  const text = formatSantim(wire);
  return text.endsWith('.00') ? text.slice(0, -3) : text;
}
