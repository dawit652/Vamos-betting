import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fixtureKey } from './fixture-key';

const base = {
  competitionId: 'c1',
  homeTeamId: 'h1',
  awayTeamId: 'a1',
  firstKickoff: new Date('2025-08-16T14:00:00Z'),
};

describe('fixtureKey', () => {
  it('uses the UTC date of the first kickoff', () => {
    expect(fixtureKey(base)).toBe('fx|c1|h1|a1|2025-08-16');
    expect(fixtureKey({ ...base, firstKickoff: new Date('2025-08-16T23:59:59.999Z') })).toBe(
      'fx|c1|h1|a1|2025-08-16',
    );
    expect(fixtureKey({ ...base, firstKickoff: new Date('2025-08-17T00:00:00Z') })).toBe(
      'fx|c1|h1|a1|2025-08-17',
    );
  });

  it('keeps home and away apart', () => {
    expect(fixtureKey({ ...base, homeTeamId: 'a1', awayTeamId: 'h1' })).not.toBe(fixtureKey(base));
  });

  it('rejects empty parts, separators and invalid dates with RangeError', () => {
    expect(() => fixtureKey({ ...base, competitionId: '' })).toThrow(RangeError);
    expect(() => fixtureKey({ ...base, homeTeamId: '' })).toThrow(RangeError);
    expect(() => fixtureKey({ ...base, awayTeamId: '' })).toThrow(RangeError);
    expect(() => fixtureKey({ ...base, awayTeamId: 'a|b' })).toThrow(RangeError);
    expect(() => fixtureKey({ ...base, firstKickoff: new Date(Number.NaN) })).toThrow(RangeError);
    expect(() => fixtureKey({ ...base, firstKickoff: new Date(8.64e15) })).toThrow(RangeError);
  });

  it('property: depends only on the UTC day', () => {
    fc.assert(
      fc.property(
        fc.date({
          min: new Date('2000-01-01T00:00:00Z'),
          max: new Date('2100-01-01T00:00:00Z'),
          noInvalidDate: true,
        }),
        fc.integer({ min: 0, max: 3_600_000 }),
        (date, shift) => {
          const key = fixtureKey({ ...base, firstKickoff: date });
          expect(key.endsWith(`|${date.toISOString().slice(0, 10)}`)).toBe(true);
          const sameDay = new Date(
            Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) + shift,
          );
          expect(fixtureKey({ ...base, firstKickoff: sameDay })).toBe(key);
        },
      ),
    );
  });
});
