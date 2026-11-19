import { describe, expect, it } from 'vitest';
import { commissionText, localPhone, sortAgents, sortShops } from './agents';

describe('commissionText', () => {
  it('names the percent and the base', () => {
    expect(commissionText({ isHouse: false, commissionKind: 'ggr', commissionBps: 1000 })).toBe(
      '10% of GGR',
    );
    expect(commissionText({ isHouse: false, commissionKind: 'stake', commissionBps: 500 })).toBe(
      '5% of stake',
    );
    expect(commissionText({ isHouse: false, commissionKind: 'ggr', commissionBps: 1250 })).toBe(
      '12.5% of GGR',
    );
  });

  it('is a dash for HQ', () => {
    expect(commissionText({ isHouse: true, commissionKind: 'ggr', commissionBps: 0 })).toBe('—');
  });
});

describe('localPhone', () => {
  it('writes an E.164 mobile number the way it is dialled', () => {
    expect(localPhone('+251911223344')).toBe('0911 22 33 44');
    expect(localPhone('+251711223344')).toBe('0711 22 33 44');
  });

  it('keeps other values and dashes out empty ones', () => {
    expect(localPhone('+44123')).toBe('+44123');
    expect(localPhone('')).toBe('—');
    expect(localPhone(null)).toBe('—');
  });
});

describe('sorting', () => {
  it('sorts agents by number and shops by agent then shop number', () => {
    expect(sortAgents([{ number: 1002 }, { number: 1000 }]).map((a) => a.number)).toEqual([
      1000, 1002,
    ]);
    const shops = [
      { agentNumber: 1002, number: 1 },
      { agentNumber: 1001, number: 2 },
      { agentNumber: 1001, number: 1 },
    ];
    expect(sortShops(shops)).toEqual([
      { agentNumber: 1001, number: 1 },
      { agentNumber: 1001, number: 2 },
      { agentNumber: 1002, number: 1 },
    ]);
  });
});
