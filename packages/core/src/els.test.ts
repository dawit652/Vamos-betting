import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildElsRecord,
  canonicalJson,
  DAILY_SUMMARY_FINALIZED,
  ELS_RECORD_SCHEMA,
  ELS_REPORTABLE_TYPES,
  elsRecordLine,
  isElsReportable,
} from './els';

const USER = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const AT = new Date('2026-10-18T22:15:00.000Z');

describe('the ELS stream records', () => {
  it('reports the agreed event types only', () => {
    for (const type of [
      'bet.placed',
      'bet.accepted',
      'bet.rejected',
      'bet.settled',
      'bet.cashed_out',
      'bet.reopened',
      'jackpot.entered',
      'jackpot.settled',
      'payment.deposit_succeeded',
      'payment.withdrawal_paid',
      DAILY_SUMMARY_FINALIZED,
    ]) {
      expect(isElsReportable(type), type).toBe(true);
    }
    for (const type of ['payment.withdrawal_requested', 'event.resulted', 'toString', '']) {
      expect(isElsReportable(type), type).toBe(false);
    }
    expect(ELS_REPORTABLE_TYPES).toHaveLength(11);
    expect(
      buildElsRecord({
        outboxId: 1n,
        type: 'event.resulted',
        occurredAt: AT,
        aggregateType: 'event',
        aggregateId: 'e',
        payload: {},
      }),
    ).toBeNull();
  });

  it('keeps the pseudonymous player id and amounts, and drops personal data', () => {
    const record = buildElsRecord({
      outboxId: 42n,
      type: 'payment.deposit_succeeded',
      occurredAt: AT,
      aggregateType: 'payment_intent',
      aggregateId: 'i-1',
      payload: {
        intentId: 'i-1',
        userId: USER.toUpperCase(),
        provider: 'mock',
        amount: '150000',
        providerRef: 'MOCK-1',
        phone: '+251911234567',
        fullName: 'Abebe Kebede',
        ip: '10.0.0.1',
      },
    });
    expect(record).toEqual({
      schema: ELS_RECORD_SCHEMA,
      outboxId: '42',
      type: 'payment.deposit_succeeded',
      occurredAt: '2026-10-18T22:15:00.000Z',
      // 22:15 UTC is 01:15 the next day in Addis Ababa.
      businessDate: '2026-10-19',
      playerRef: USER,
      refType: 'payment_intent',
      refId: 'i-1',
      data: { intentId: 'i-1', provider: 'mock', amount: '150000', providerRef: 'MOCK-1' },
    });
    const line = elsRecordLine(record!);
    expect(line).not.toMatch(/251911234567|Abebe|10\.0\.0\.1/);
    expect(line).not.toContain('\n');
    expect(JSON.parse(line)).toEqual(record);
  });

  it('reports a malformed field as null instead of failing', () => {
    const record = buildElsRecord({
      outboxId: '7',
      type: 'bet.placed',
      occurredAt: AT,
      aggregateType: 'bet',
      aggregateId: 'b',
      payload: {
        betId: 'b',
        userId: 'not-a-uuid',
        stake: 12.5,
        totalOddsMilli: '3700',
        acceptAfter: 'soon',
        legs: [{ eventId: 'e', selectionId: 's', oddsMilli: 1850, isLive: 'yes', phone: 'x' }],
      },
    });
    expect(record?.playerRef).toBeNull();
    expect(record?.data).toMatchObject({
      betId: 'b',
      stake: null,
      totalOddsMilli: '3700',
      acceptAfter: null,
      status: null,
      legs: [{ eventId: 'e', selectionId: 's', oddsMilli: 1850, isLive: null }],
    });
    expect(() =>
      buildElsRecord({
        outboxId: '-1',
        type: 'bet.placed',
        occurredAt: AT,
        aggregateType: 'bet',
        aggregateId: 'b',
        payload: {},
      }),
    ).toThrow(RangeError);
  });

  it('writes canonical JSON: sorted keys, same bytes for equal values (property)', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'], c: { z: 1n, y: undefined } })).toBe(
      '{"a":[true,null,"x"],"b":1,"c":{"z":"1"}}',
    );
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(TypeError);
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const text = canonicalJson(value);
        expect(canonicalJson(JSON.parse(text))).toBe(text);
        // Reordering keys never changes the text.
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          const reversed = Object.fromEntries(Object.entries(value).reverse());
          expect(canonicalJson(reversed)).toBe(text);
        }
      }),
    );
  });
});
