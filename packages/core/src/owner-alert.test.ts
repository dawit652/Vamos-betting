import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildOwnerAlert, OWNER_ALERT_MAX_LENGTH, type OwnerAlertInput } from './owner-alert';

/** One input per alarm (with both reasons or directions where the wording differs). */
const SAMPLES: readonly OwnerAlertInput[] = [
  { alarm: 'ladder_shadow_failed' },
  { alarm: 'source_broken', sourceId: 'src-a', sourceName: 'Football Data', reason: 'shape' },
  {
    alarm: 'source_broken',
    sourceId: 'src-a',
    sourceName: 'Football Data',
    reason: 'invalid_config',
  },
  { alarm: 'source_stale', sourceId: 'src-b', sourceName: 'OpenLigaDB', daysUnchanged: 2 },
  { alarm: 'budget_low', creditKey: 'theoddsapi' },
  { alarm: 'budget_exhausted', creditKey: 'theoddsapi' },
  { alarm: 'budget_projection', creditKey: 'theoddsapi', daysUntilEmpty: 3.4 },
  { alarm: 'unauthorized', creditKey: 'theoddsapi' },
  { alarm: 'unexpected_cost', creditKey: 'theoddsapi', cost: 30, expected: 10 },
  {
    alarm: 'rate_limit_low',
    creditKey: 'SCRAPER_SECRET_API_FOOTBALL',
    remaining: 600,
    limit: 7500,
  },
  { alarm: 'sms_receipt_rejected', smsId: '0b0c7f5e-3c55-4a8e-9d36-3f1b6a5a8e11' },
  { alarm: 'sms_balance_drift', institution: 'telebirr', direction: 'credited_more_than_arrived' },
  { alarm: 'sms_balance_drift', institution: 'cbe', direction: 'missed_incoming' },
  { alarm: 'sms_gateway_silent' },
  { alarm: 'sms_review_backlog' },
  { alarm: 'manual_payout_waiting' },
  { alarm: 'market_family_moved', family: 'htft_ou', move: 'suspend', week: '2026-W45' },
  { alarm: 'market_family_moved', family: 'htft_ou', move: 'return', week: '2026-W48' },
  { alarm: 'market_family_moved', family: 'htft_ou', move: 'off', week: '2026-W52' },
];

/** Words of a request or an obligation, wherever they stand. */
const REQUEST_WORDS =
  /\b(please|should|must|need|needs|needed|action|urgent|asap|make sure|todo)\b/i;

/** Verbs that open an instruction ("Check the key", "Top up the credits"). */
const IMPERATIVE_STARTS = new Set([
  'check',
  'fix',
  'restart',
  'investigate',
  'contact',
  'call',
  'ensure',
  'verify',
  'try',
  'retry',
  'click',
  'open',
  'log',
  'go',
  'consider',
  'run',
  'update',
  'replace',
  'rotate',
  'top',
  'review',
  'approve',
  'reply',
  'wait',
]);

/** The first word of every sentence of a message. */
const sentenceStarts = (message: string): string[] =>
  message.split(/(?<=[.:;])\s+/).map((sentence) => sentence.split(/\s+/)[0]?.toLowerCase() ?? '');

// eslint-disable-next-line no-control-regex
const abnormal = (text: string): boolean => /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(text);

describe('buildOwnerAlert', () => {
  it('keeps every message to one plain line of at most 160 characters', () => {
    expect(OWNER_ALERT_MAX_LENGTH).toBe(160);
    for (const input of SAMPLES) {
      const { message } = buildOwnerAlert(input);
      expect(message.length, message).toBeLessThanOrEqual(OWNER_ALERT_MAX_LENGTH);
      expect(message.length, message).toBeGreaterThan(20);
      expect(abnormal(message), message).toBe(false);
      expect(message, message).toBe(message.trim());
    }
  });

  it('says what was done and never what to do', () => {
    for (const input of SAMPLES) {
      const { message } = buildOwnerAlert(input);
      expect(message, message).not.toMatch(REQUEST_WORDS);
      for (const start of sentenceStarts(message)) {
        expect(IMPERATIVE_STARTS.has(start), `${start}: ${message}`).toBe(false);
      }
      expect(message, message).not.toContain('?');
      expect(message, message).not.toContain('!');
    }
  });

  it('says what was done for the alarms that act', () => {
    const text = (input: OwnerAlertInput) => buildOwnerAlert(input).message;
    expect(text({ alarm: 'budget_exhausted', creditKey: 'k' })).toBe(
      'Bookmaker odds credits are used up: odds reads are stopped until the 1st.',
    );
    expect(text({ alarm: 'budget_low', creditKey: 'k' })).toMatch(/read less often/);
    expect(text({ alarm: 'unauthorized', creditKey: 'k' })).toMatch(
      /reads with that key are stopped/,
    );
    expect(
      text({ alarm: 'source_broken', sourceId: 's', sourceName: 'Football Data', reason: 'shape' }),
    ).toBe(
      'Football Data: its pages no longer read as before. Nothing from them is stored; the league runs on its other sources.',
    );
    expect(text({ alarm: 'sms_receipt_rejected', smsId: 'x' })).toMatch(/stays credited/);
    expect(text({ alarm: 'ladder_shadow_failed' })).toMatch(/nothing was changed/);
  });

  it('gives a stable key of the alarm name and its subject', () => {
    const key = (input: OwnerAlertInput) => buildOwnerAlert(input).key;
    expect(key({ alarm: 'ladder_shadow_failed' })).toBe('ladder_shadow_failed');
    expect(key({ alarm: 'source_broken', sourceId: 'a', sourceName: 'A', reason: 'shape' })).toBe(
      'source_broken|a',
    );
    // The same condition under another name or reason keeps its key; another subject does not.
    expect(
      key({
        alarm: 'source_broken',
        sourceId: 'a',
        sourceName: 'Renamed',
        reason: 'invalid_config',
      }),
    ).toBe('source_broken|a');
    expect(
      key({ alarm: 'source_broken', sourceId: 'b', sourceName: 'A', reason: 'shape' }),
    ).not.toBe('source_broken|a');
    // Low and exhausted are different alarms of one credit key: the worse one is not held back.
    expect(key({ alarm: 'budget_low', creditKey: 'k' })).not.toBe(
      key({ alarm: 'budget_exhausted', creditKey: 'k' }),
    );
    // Day counts and costs are in the message, not the key.
    expect(key({ alarm: 'source_stale', sourceId: 'a', sourceName: 'A', daysUnchanged: 2 })).toBe(
      key({ alarm: 'source_stale', sourceId: 'a', sourceName: 'A', daysUnchanged: 9 }),
    );
    const keys = SAMPLES.map(key);
    expect(new Set(keys).size).toBe(keys.length - 1); // the two source_broken samples share one
  });

  it('carries no personal data: no ids of SMS, phones or amounts', () => {
    const { message, key } = buildOwnerAlert({
      alarm: 'sms_receipt_rejected',
      smsId: '0b0c7f5e-3c55-4a8e-9d36-3f1b6a5a8e11',
    });
    expect(message).not.toMatch(/\d{5,}/);
    expect(message).not.toContain('0b0c7f5e');
    expect(key).toContain('0b0c7f5e');
  });

  it('uses the singular for one day', () => {
    expect(
      buildOwnerAlert({ alarm: 'source_stale', sourceId: 'a', sourceName: 'A', daysUnchanged: 1 })
        .message,
    ).toMatch(/for 1 day\./);
  });

  it('holds the length limit, one line and the key shape for any names', () => {
    const textArb = fc.string({ unit: 'binary', maxLength: 400 });
    const inputArb: fc.Arbitrary<OwnerAlertInput> = fc.oneof(
      fc.record({
        alarm: fc.constant('source_broken' as const),
        sourceId: textArb,
        sourceName: textArb,
        reason: fc.constantFrom('shape' as const, 'invalid_config' as const),
      }),
      fc.record({
        alarm: fc.constant('source_stale' as const),
        sourceId: textArb,
        sourceName: textArb,
        daysUnchanged: fc.oneof(fc.integer({ min: -5, max: 10_000 }), fc.double({ noNaN: false })),
      }),
      fc.record({
        alarm: fc.constant('budget_projection' as const),
        creditKey: textArb,
        daysUntilEmpty: fc.double({ noNaN: false }),
      }),
      fc.record({
        alarm: fc.constant('unexpected_cost' as const),
        creditKey: textArb,
        cost: fc.double({ noNaN: false }),
        expected: fc.integer({ min: 0, max: 1_000_000 }),
      }),
      fc.record({
        alarm: fc.constant('sms_balance_drift' as const),
        institution: textArb,
        direction: fc.constantFrom(
          'credited_more_than_arrived' as const,
          'missed_incoming' as const,
        ),
      }),
      fc.record({ alarm: fc.constant('sms_receipt_rejected' as const), smsId: textArb }),
    );
    fc.assert(
      fc.property(inputArb, (input) => {
        const { key, message } = buildOwnerAlert(input);
        expect(Array.from(message).length).toBeLessThanOrEqual(OWNER_ALERT_MAX_LENGTH);
        expect(abnormal(message)).toBe(false);
        expect(message).toBe(message.trim());
        expect(message.length).toBeGreaterThan(0);
        expect(abnormal(key)).toBe(false);
        expect(key.startsWith(input.alarm)).toBe(true);
        // The same input always gives the same alert.
        expect(buildOwnerAlert(input)).toEqual({ key, message });
      }),
      { numRuns: 300 },
    );
  });
});
