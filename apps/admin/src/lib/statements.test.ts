import type { AgentStatementView } from '@vamos/contracts';
import { describe, expect, it } from 'vitest';
import {
  STATEMENT_CSV_HEADER,
  alertDetailLines,
  alertKindLabel,
  bpsToPercentText,
  santimToBirr,
  statementsCsv,
  weekOptions,
} from './statements';

const row: AgentStatementView = {
  id: 's1',
  agentId: 'a1',
  agentNumber: 1001,
  agentName: 'Bole, "Main" Agent',
  weekStart: '2026-11-09',
  ticketsSold: 10,
  soldStakes: '1234500',
  ticketsCancelled: 1,
  cancelledStakes: '5000',
  ticketsSettled: 8,
  settledStakes: '100000',
  settledPayouts: '150050',
  ggr: '-50050',
  ticketsPaid: 2,
  paidAmount: '150050',
  ticketsExpired: 0,
  expiredAmount: '0',
  playerDeposits: 1,
  playerCashIn: '20000',
  playerWithdrawals: 0,
  playerCashOut: '0',
  balanceStart: '1000000',
  balanceEnd: '999950',
  commissionKind: 'ggr',
  commissionBps: 1050,
  commission: '0',
  createdAt: '2026-11-16T01:00:00Z',
  paidAt: null,
  paidReference: null,
};

describe('statements CSV', () => {
  it('writes birr with two decimals and no separators', () => {
    expect(santimToBirr('123456789')).toBe('1234567.89');
    expect(santimToBirr('-50050')).toBe('-500.50');
    expect(santimToBirr('5')).toBe('0.05');
  });

  it('percent text from basis points', () => {
    expect(bpsToPercentText(1000)).toBe('10');
    expect(bpsToPercentText(1050)).toBe('10.5');
    expect(bpsToPercentText(25)).toBe('0.25');
    expect(bpsToPercentText(0)).toBe('0');
  });

  it('has a header and one line per agent, quoting fields that need it', () => {
    const lines = statementsCsv([row]).trimEnd().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(STATEMENT_CSV_HEADER.join(','));
    expect(lines[1]).toContain('1001,"Bole, ""Main"" Agent",2026-11-09,10,12345.00');
    expect(lines[1]).toContain(',-500.50,');
    expect(lines[1]).toContain(',ggr,10.5,0.00,,');
    expect(lines[1]?.split(',').length).toBeGreaterThanOrEqual(STATEMENT_CSV_HEADER.length);
  });

  it('is only the header for no rows', () => {
    expect(statementsCsv([])).toBe(`${STATEMENT_CSV_HEADER.join(',')}\r\n`);
  });
});

describe('weekOptions', () => {
  it('lists Mondays newest first across a month and year end', () => {
    expect(weekOptions('2026-01-05', 3)).toEqual(['2026-01-05', '2025-12-29', '2025-12-22']);
    expect(weekOptions('nope')).toEqual([]);
  });
});

describe('alert text', () => {
  it('names every kind readably', () => {
    expect(alertKindLabel('big_win')).toBe('Big win');
    expect(alertKindLabel('repeated_picks')).toBe('Same picks sold across shops');
    expect(alertKindLabel('late_ticket')).toBe('Ticket sold just before kick-off');
    expect(alertKindLabel('something_new')).toBe('something new');
  });

  it('renders details as key: value with birr amounts', () => {
    expect(
      alertDetailLines({ ticketNumber: 'T-1', possibleWin: '10000000', cashier: 'Abebe', n: 3 }),
    ).toEqual(['ticket number: T-1', 'possible win: ETB 100,000.00', 'cashier: Abebe', 'n: 3']);
  });
});
