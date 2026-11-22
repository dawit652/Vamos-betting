import {
  DEFAULT_RETAIL_TICKET_LIMITS,
  parseRetailTicketLimits,
  type CashOutConfig,
} from '@vamos/core';
import { getAgent, getBetById, type DbExecutor, type RetailTicketRow } from '@vamos/db';
import { shopView } from '../admin/cashier';
import { wire } from '../admin/common';
import { betView } from '../betting/views';
import { ShopTicketView } from '@vamos/contracts';

/**
 * A shop ticket as the desk, its printout and the back office show it: the bet (legs, odds,
 * payouts; never a cash-out offer: shops do not cash out), where and by whom it was sold, and
 * until when its cashier may still cancel it.
 */
export async function ticketView(
  exec: DbExecutor,
  row: RetailTicketRow,
  options: { cashOut: CashOutConfig; now: Date },
) {
  const bet = await getBetById(exec, row.betId);
  if (bet === null) throw new Error(`bet ${row.betId} of ticket ${row.id} is missing`);
  const agent = await getAgent(exec, row.agentId);
  const cancelMinutes =
    parseRetailTicketLimits(agent?.ticketLimits ?? {}).cancelMinutes ??
    DEFAULT_RETAIL_TICKET_LIMITS.cancelMinutes;
  let cancellableUntil: Date | null = null;
  if (row.status === 'sold' && bet.status === 'open') {
    const window = row.soldAt.getTime() + cancelMinutes * 60_000;
    const kickoffs = bet.legs.map((leg) => leg.selection.startTime.getTime());
    const until = Math.min(window, ...kickoffs);
    const scheduled = bet.legs.every((leg) => leg.selection.eventStatus === 'scheduled');
    if (until > options.now.getTime() && scheduled) {
      cancellableUntil = new Date(until);
    }
  }
  // The pay screen's state (phase 4).
  const won = bet.status === 'won' || bet.status === 'void';
  const payState =
    row.status === 'cancelled' || row.status === 'paid' || row.status === 'expired'
      ? row.status
      : won
        ? 'payable' // the cashier pays any amount alone (owner, 21 Nov 2026)
        : bet.status === 'lost'
          ? 'lost'
          : 'open';
  const payAmount =
    payState === 'paid' ? row.paidAmount : payState === 'payable' ? bet.settledNetPayout : null;
  return wire(ShopTicketView, {
    payState,
    payAmount,
    paidAt: row.paidAt,
    id: row.id,
    number: bet.shortId,
    status: row.status,
    betStatus: bet.status,
    stake: row.stake,
    soldAt: row.soldAt,
    cancelledAt: row.cancelledAt,
    cancelReason: row.cancelReason,
    cancellableUntil,
    customerPhone: row.customerPhone,
    bookingCode: row.bookingCode,
    originalPrintedAt: row.originalPrintedAt,
    reprints: row.reprints,
    shop: shopView(row.shop),
    cashierName: row.staffName,
    bet: betView(bet, { config: { ...options.cashOut, enabled: false }, now: options.now }),
  });
}
