import { describe, expect, it } from 'vitest';
import { SHARED_BETSLIP_KEYS, loadBetslipMessages, withoutDrawerText } from './betslip';
import { LOCALES, MESSAGES } from './index';

describe('betslip message split', () => {
  it('keeps only the shared betslip keys and the rest of the namespace', () => {
    const trimmed = withoutDrawerText(MESSAGES.en.sportsbook);
    expect(Object.keys(trimmed.betslip).sort()).toEqual([...SHARED_BETSLIP_KEYS].sort());
    expect(trimmed.betslip.errors).toBe(MESSAGES.en.sportsbook.betslip.errors);
    expect(trimmed.markets).toBe(MESSAGES.en.sportsbook.markets);
    expect(MESSAGES.en.sportsbook.betslip).toHaveProperty('booking');
  });

  it.each(LOCALES)('loads the full betslip text of %s', async (locale) => {
    expect(await loadBetslipMessages(locale)).toEqual(MESSAGES[locale].sportsbook.betslip);
  });
});
