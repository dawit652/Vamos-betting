import type { OwnerReportResponse } from '@vamos/contracts';
import { describe, expect, it } from 'vitest';
import { balanceLabel, reportCsv, shiftReportDate } from './reports';

describe('report helpers', () => {
  it('moves to the previous and next period of the same kind', () => {
    expect(shiftReportDate('day', '2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftReportDate('week', '2026-11-22', 1)).toBe('2026-11-23');
    expect(shiftReportDate('week', '2026-11-22', -1)).toBe('2026-11-15');
    expect(shiftReportDate('month', '2026-12-15', 1)).toBe('2027-01-01');
    expect(shiftReportDate('month', '2026-01-15', -1)).toBe('2025-12-31');
    expect(shiftReportDate('year', '2026-06-01', 1)).toBe('2027-01-01');
  });

  it('names balances readably', () => {
    expect(balanceLabel('player_cash')).toBe("Players' cash");
    expect(balanceLabel('house_psp_clearing:chapa')).toBe('Payments through chapa');
    expect(balanceLabel('something_new')).toBe('something_new');
  });

  it('writes the figures, checks, balances and movements as CSV in ETB', () => {
    const channel = {
      bets: 2,
      stakes: '10000',
      wonPayouts: '15000',
      cashOuts: '0',
      refunds: '0',
      payouts: '15000',
      ggr: '-5000',
      taxWithheld: '0',
    };
    const report: OwnerReportResponse = {
      period: 'day',
      firstDay: '2026-03-10',
      lastDay: '2026-03-10',
      start: '2026-03-09T21:00:00.000Z',
      end: '2026-03-10T21:00:00.000Z',
      open: false,
      asOf: '2026-03-10T21:00:00.000Z',
      figures: {
        online: channel,
        shop: {
          ...channel,
          ticketsPaid: '0',
          ticketsPaidCount: 0,
          unclaimed: '0',
          unclaimedCount: 0,
          agentTopups: '0',
          agentTopupCount: 0,
          agentTakeBacks: '0',
          agentTakeBackCount: 0,
        },
        jackpot: {
          entries: 0,
          stakes: '0',
          refunds: '0',
          prizes: '0',
          result: '0',
          taxWithheld: '0',
        },
        totalGgr: '-10000',
        taxWithheld: '0',
        deposits: {
          total: '25000',
          count: 1,
          byProvider: [{ provider: 'chapa', amount: '25000', count: 1 }],
        },
        withdrawals: {
          requested: '0',
          requestedCount: 0,
          paid: '0',
          paidCount: 0,
          returned: '0',
          returnedCount: 0,
          paidByProvider: [],
        },
        bonuses: '0',
      },
      balances: [{ key: 'player_cash', opening: '0', closing: '25000' }],
      checks: [{ id: 'balanced', ok: true, detail: null }],
      days: [{ date: '2026-03-10', closed: true, changed: false }],
      movements: [
        {
          category: 'deposit',
          channel: 'online',
          kind: 'player_cash',
          provider: null,
          type: null,
          amount: '25000',
          transactions: 1,
        },
      ],
    };
    const csv = reportCsv(report);
    expect(csv).toContain('Online,GGR,,-50.00');
    expect(csv).toContain('Total,GGR,,-100.00');
    expect(csv).toContain('Deposits,chapa,1,250.00');
    expect(csv).toContain('All postings of the period add up to zero,OK');
    expect(csv).toContain("Players' cash,0.00,250.00");
    expect(csv).toContain('deposit,online,player_cash,,,1,250.00');
  });
});
