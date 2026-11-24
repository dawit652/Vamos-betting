import type { TicketPayState } from '@vamos/contracts';

/** Pure helpers of the pay screen and the payout slip (the pages are covered by e2e). */

/**
 * What the scanner or the cashier typed, as a ticket number: spaces dropped, upper case. A barcode
 * scanner may add spaces or a line end, and numbers are printed in capitals.
 */
export function normalizeTicketNumber(input: string): string {
  return input.replace(/\s+/g, '').toUpperCase();
}

/** The idempotency key of one payout: made once and kept until the payout succeeded. */
export function newPayoutKey(random: () => string = () => crypto.randomUUID()): string {
  return `payout-${random()}`;
}

/** The path of the payout slip; it loads the ticket by number, so the number travels along. */
export function payoutSlipPath(id: string, number: string, print = false): string {
  const query = `number=${encodeURIComponent(number)}`;
  return `/payout/${id}?${query}${print ? '&print=1' : ''}`;
}

export type PayTone = 'good' | 'warn' | 'bad' | 'muted';

const STATE_LABELS: Readonly<Record<TicketPayState, string>> = {
  open: 'Not settled yet',
  lost: 'Lost',
  payable: 'Payable',
  paid: 'Paid',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

/** The banner words of a ticket's state. */
export function payStateLabel(state: TicketPayState): string {
  return STATE_LABELS[state];
}

/** The banner colour: green for money to hand over, amber while not settled, red for no money. */
export function payStateTone(state: TicketPayState): PayTone {
  switch (state) {
    case 'payable':
      return 'good';
    case 'open':
      return 'warn';
    case 'lost':
    case 'expired':
    case 'cancelled':
      return 'bad';
    case 'paid':
      return 'muted';
  }
}

/** Why a ticket cannot be paid now, from the state the API reports with `ticket_not_payable`. */
export function notPayableText(state: unknown): string {
  switch (state) {
    case 'open':
      return 'The ticket is not settled yet. Its matches are not all finished.';
    case 'lost':
      return 'This ticket lost. Nothing to pay.';
    case 'paid':
      return 'This ticket was already paid.';
    case 'expired':
      return 'This ticket expired unpaid.';
    case 'cancelled':
      return 'This ticket was cancelled.';
    default:
      return 'This ticket cannot be paid now.';
  }
}
