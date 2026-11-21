import { describe, expect, it } from 'vitest';
import {
  newPayoutKey,
  normalizeTicketNumber,
  notPayableText,
  payoutSlipPath,
  payStateLabel,
  payStateTone,
} from './payouts';

describe('normalizeTicketNumber', () => {
  it('drops spaces and line ends and upper-cases', () => {
    expect(normalizeTicketNumber(' ab12 cd34\r\n')).toBe('AB12CD34');
    expect(normalizeTicketNumber('')).toBe('');
  });
});

describe('payout keys and paths', () => {
  it('prefixes the key and builds the slip path', () => {
    expect(newPayoutKey(() => 'abc')).toBe('payout-abc');
    expect(payoutSlipPath('id1', 'AB12CD34')).toBe('/payout/id1?number=AB12CD34');
    expect(payoutSlipPath('id1', 'AB12CD34', true)).toBe('/payout/id1?number=AB12CD34&print=1');
  });
});

describe('state banner', () => {
  it('labels and colours every state', () => {
    expect(payStateLabel('payable')).toBe('Payable');
    expect(payStateLabel('open')).toBe('Not settled yet');
    expect(payStateTone('payable')).toBe('good');
    expect(payStateTone('lost')).toBe('bad');
    expect(payStateTone('open')).toBe('warn');
    expect(payStateTone('paid')).toBe('muted');
  });

  it('explains a refused payout by the ticket state', () => {
    expect(notPayableText('paid')).toMatch(/already paid/);
    expect(notPayableText('lost')).toMatch(/lost/);
    expect(notPayableText(undefined)).toMatch(/cannot be paid/);
  });
});
