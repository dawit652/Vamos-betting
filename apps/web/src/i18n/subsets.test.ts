import { messagesFor } from '@vamos/i18n';
import { describe, expect, it } from 'vitest';
import { withoutBetslipMessages } from './subsets';

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
