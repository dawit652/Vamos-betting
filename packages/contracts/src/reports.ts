import { z } from 'zod';
import { IsoDateTime, Santim } from './common';
import { BusinessDate } from './compliance';

/**
 * Owner reports (docs/plans/owner-reports.md): GET /admin/reports (reports.view: admin, compliance,
 * finance) answers the report of a day, a week (Monday to Sunday), a month or a year in Ethiopian
 * time, recomputed from the ledger, with the checks it ran on itself. Money is santim strings; a
 * GGR can be negative.
 */

export const OWNER_REPORT_PERIODS = ['day', 'week', 'month', 'year'] as const;
export type OwnerReportPeriod = (typeof OWNER_REPORT_PERIODS)[number];

/** The period holding `date` (default: today in Addis Ababa). */
export const OwnerReportQuery = z
  .object({
    period: z.enum(OWNER_REPORT_PERIODS).default('day'),
    date: BusinessDate.optional(),
  })
  .strict();
export type OwnerReportQuery = z.infer<typeof OwnerReportQuery>;

export const OWNER_REPORT_CHECKS = [
  'balanced',
  'every_posting_balanced',
  'unchanged_since_close',
  'closed_days_passed',
  'balances_roll_forward',
] as const;

const Count = z.number().int();

const ChannelFiguresView = z.object({
  bets: Count,
  stakes: Santim,
  wonPayouts: Santim,
  cashOuts: Santim,
  refunds: Santim,
  payouts: Santim,
  ggr: Santim,
  taxWithheld: Santim,
});

const ProviderFigureView = z.object({ provider: z.string(), amount: Santim, count: Count });

export const OwnerReportFiguresView = z.object({
  online: ChannelFiguresView,
  shop: ChannelFiguresView.extend({
    ticketsPaid: Santim,
    ticketsPaidCount: Count,
    unclaimed: Santim,
    unclaimedCount: Count,
    agentTopups: Santim,
    agentTopupCount: Count,
    agentTakeBacks: Santim,
    agentTakeBackCount: Count,
  }),
  jackpot: z.object({
    entries: Count,
    stakes: Santim,
    refunds: Santim,
    prizes: Santim,
    result: Santim,
    taxWithheld: Santim,
  }),
  totalGgr: Santim,
  taxWithheld: Santim,
  deposits: z.object({ total: Santim, count: Count, byProvider: z.array(ProviderFigureView) }),
  withdrawals: z.object({
    requested: Santim,
    requestedCount: Count,
    paid: Santim,
    paidCount: Count,
    returned: Santim,
    returnedCount: Count,
    paidByProvider: z.array(ProviderFigureView),
  }),
  bonuses: Santim,
});

export const OwnerReportResponse = z.object({
  period: z.enum(OWNER_REPORT_PERIODS),
  firstDay: BusinessDate,
  lastDay: BusinessDate,
  start: IsoDateTime,
  end: IsoDateTime,
  /** The period has not ended: the figures run until `asOf`. */
  open: z.boolean(),
  asOf: IsoDateTime,
  figures: OwnerReportFiguresView,
  /** Every balance at the start and the end of the period (kind, and provider for payments). */
  balances: z.array(z.object({ key: z.string(), opening: Santim, closing: Santim })),
  checks: z.array(
    z.object({ id: z.enum(OWNER_REPORT_CHECKS), ok: z.boolean(), detail: z.string().nullable() }),
  ),
  days: z.array(z.object({ date: BusinessDate, closed: z.boolean(), changed: z.boolean() })),
  /** The ledger movements the figures come from (for the CSV and for checking by hand). */
  movements: z.array(
    z.object({
      category: z.string(),
      channel: z.string(),
      kind: z.string(),
      provider: z.string().nullable(),
      type: z.string().nullable(),
      amount: Santim,
      transactions: Count,
    }),
  ),
});
export type OwnerReportResponse = z.infer<typeof OwnerReportResponse>;
