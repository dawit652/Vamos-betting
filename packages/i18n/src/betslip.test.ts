import { describe, expect, it } from 'vitest';
import { betslipMessages } from './betslip';
import { MESSAGES } from './index';

describe('betslipMessages (the betslip code brings its own texts)', () => {
  it('is the sportsbook.betslip tree of each locale, untranslated keys in English', () => {
    expect(betslipMessages('en')).toEqual(MESSAGES.en.sportsbook.betslip);
    expect(betslipMessages('am')).toEqual(MESSAGES.am.sportsbook.betslip);
    // Afaan Oromo and Tigrinya are prepared but unreviewed: English until translated.
    expect(betslipMessages('om')).toEqual(MESSAGES.om.sportsbook.betslip);
    expect(betslipMessages('ti')).toEqual(MESSAGES.ti.sportsbook.betslip);
    expect(betslipMessages('am').title).not.toBe(betslipMessages('en').title);
  });
});
