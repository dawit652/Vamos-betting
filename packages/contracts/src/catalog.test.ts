import { describe, expect, it } from 'vitest';
import {
  addisAbabaDate,
  EventListQuery,
  eventListQueryAt,
  isEventDayInRange,
  SearchQuery,
} from './catalog';

// 23:30 UTC on 2026-10-08 is already 02:30 on the 9th in Addis Ababa.
const NOW = new Date('2026-10-08T23:30:00.000Z');

describe('addisAbabaDate', () => {
  it('uses the Addis Ababa calendar (UTC+3), not UTC', () => {
    expect(addisAbabaDate(NOW)).toBe('2026-10-09');
    expect(addisAbabaDate(new Date('2026-10-08T20:59:59.999Z'))).toBe('2026-10-08');
    expect(addisAbabaDate(new Date('2026-10-08T21:00:00.000Z'))).toBe('2026-10-09');
    expect(addisAbabaDate(NOW, 14)).toBe('2026-10-23');
  });
});

describe('EventListQuery new parameters', () => {
  it('defaults market to 1x2 and leaves day and country unset', () => {
    const query = EventListQuery.parse({});
    expect(query.market).toBe('1x2');
    expect(query.day).toBeUndefined();
    expect(query.country).toBeUndefined();
  });

  it('accepts a day, a country and the dc market', () => {
    expect(
      EventListQuery.parse({ day: '2026-10-09', country: 'england', market: 'dc' }),
    ).toMatchObject({
      day: '2026-10-09',
      country: 'england',
      market: 'dc',
    });
  });

  it('accepts startsWithinHours from 1 to 48 and rejects the rest', () => {
    expect(EventListQuery.parse({}).startsWithinHours).toBeUndefined();
    expect(EventListQuery.parse({ startsWithinHours: '6' }).startsWithinHours).toBe(6);
    for (const bad of ['0', '49', '1.5', 'x']) {
      expect(EventListQuery.safeParse({ startsWithinHours: bad }).success, bad).toBe(false);
    }
  });

  it('rejects malformed days, empty countries and unknown markets', () => {
    for (const day of ['2026-1-9', '20261009', '2026-02-30', '2026-13-01', 'today', '']) {
      expect(EventListQuery.safeParse({ day }).success, day).toBe(false);
    }
    expect(EventListQuery.safeParse({ country: '' }).success).toBe(false);
    expect(EventListQuery.safeParse({ market: 'ou' }).success).toBe(false);
  });
});

describe('eventListQueryAt', () => {
  const schema = eventListQueryAt(NOW);

  it('takes today up to today + 14 days (Addis Ababa)', () => {
    for (const day of ['2026-10-09', '2026-10-10', '2026-10-23']) {
      expect(schema.safeParse({ day }).success, day).toBe(true);
      expect(isEventDayInRange(day, NOW)).toBe(true);
    }
    expect(schema.safeParse({}).success).toBe(true);
  });

  it('rejects yesterday and day 15, with the issue on day', () => {
    for (const day of ['2026-10-08', '2026-10-24']) {
      const result = schema.safeParse({ day });
      expect(result.success, day).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(['day']);
    }
  });
});

describe('SearchQuery', () => {
  it('trims the text and accepts 2 to 60 characters, with an optional sport', () => {
    expect(SearchQuery.parse({ q: '  arsenal ' })).toEqual({ q: 'arsenal' });
    expect(SearchQuery.parse({ q: 'ሊግ', sport: 'tennis' })).toEqual({ q: 'ሊግ', sport: 'tennis' });
    expect(SearchQuery.safeParse({ q: 'a'.repeat(60) }).success).toBe(true);
  });

  it('rejects missing, too short (after trimming), too long and unknown-sport queries', () => {
    expect(SearchQuery.safeParse({}).success).toBe(false);
    expect(SearchQuery.safeParse({ q: 'a' }).success).toBe(false);
    expect(SearchQuery.safeParse({ q: '  a  ' }).success).toBe(false);
    expect(SearchQuery.safeParse({ q: '   ' }).success).toBe(false);
    expect(SearchQuery.safeParse({ q: 'a'.repeat(61) }).success).toBe(false);
    expect(SearchQuery.safeParse({ q: 'ab', sport: 'golf' }).success).toBe(false);
  });
});
