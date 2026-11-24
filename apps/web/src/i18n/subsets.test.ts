import { messagesFor } from '@vamos/i18n';
import { describe, expect, it } from 'vitest';
import { withoutBetslipMessages, withoutTicketCheckMessages } from './subsets';

describe('withoutBetslipMessages', () => {
  const { common, sportsbook } = messagesFor('en');

  it('drops sportsbook.betslip and keeps everything else', () => {
    const root = withoutBetslipMessages({ common, sportsbook });
    expect(root.common).toBe(common);
    expect(root.sportsbook).not.toHaveProperty('betslip');
    expect(root.sportsbook?.markets).toEqual(sportsbook.markets);
    expect(Object.keys(root.sportsbook ?? {})).toHaveLength(Object.keys(sportsbook).length - 1);
  });

  it('leaves messages without a sportsbook namespace alone', () => {
    const subset = { common };
    expect(withoutBetslipMessages(subset)).toBe(subset);
  });
});

describe('withoutTicketCheckMessages', () => {
  const { common, sportsbook } = messagesFor('en');

  it('drops common.ticketCheck and keeps everything else', () => {
    const root = withoutTicketCheckMessages({ common, sportsbook });
    expect(root.sportsbook).toBe(sportsbook);
    expect(root.common).not.toHaveProperty('ticketCheck');
    expect(root.common?.actions).toEqual(common.actions);
    expect(Object.keys(root.common ?? {})).toHaveLength(Object.keys(common).length - 1);
  });

  it('leaves messages without a common namespace alone', () => {
    const subset = { sportsbook };
    expect(withoutTicketCheckMessages(subset)).toBe(subset);
  });
});
