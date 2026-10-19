import { describe, expect, it } from 'vitest';
import { channelLabel, flagRows } from './channels';

describe('channels', () => {
  it('names the known channels and passes others through', () => {
    expect(channelLabel('web')).toBe('Web');
    expect(channelLabel('sms')).toBe('SMS');
    expect(channelLabel('ussd')).toBe('USSD');
    expect(channelLabel('other')).toBe('other');
  });

  it('lists both switches with their variables', () => {
    const rows = flagRows({
      sms: { enabled: false, aggregator: 'mock', shortCode: '8123' },
      ussd: { enabled: true, aggregator: 'mock', serviceCode: '*123#' },
      source: 'environment',
    });
    expect(rows.map((r) => [r.key, r.variable, r.enabled, r.code])).toEqual([
      ['sms', 'SMS_BETTING_ENABLED', false, '8123'],
      ['ussd', 'USSD_ENABLED', true, '*123#'],
    ]);
  });
});
