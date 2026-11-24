import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SAME_MATCH_KICKOFF_MS, sameMatchLikely } from './same-match';

const at = (iso: string) => new Date(iso);
const kickoff = at('2026-11-22T15:00:00Z');

describe('sameMatchLikely', () => {
  it('pairs two spellings of one match, home with home', () => {
    expect(
      sameMatchLikely(
        { home: 'Columbus Crew', away: 'St. Louis City', kickoff },
        { home: 'Columbus Crew SC', away: 'St. Louis City SC', kickoff },
      ),
    ).toBe(true);
  });

  it('never pairs a swapped match, sibling clubs, or kickoffs too far apart', () => {
    const a = { home: 'Manchester City', away: 'Arsenal', kickoff };
    expect(sameMatchLikely(a, { home: 'Arsenal', away: 'Manchester City', kickoff })).toBe(false);
    expect(sameMatchLikely(a, { home: 'Manchester United', away: 'Arsenal', kickoff })).toBe(false);
    const late = new Date(kickoff.getTime() + SAME_MATCH_KICKOFF_MS + 1);
    expect(sameMatchLikely(a, { ...a, kickoff: late })).toBe(false);
    const edge = new Date(kickoff.getTime() + SAME_MATCH_KICKOFF_MS);
    expect(sameMatchLikely(a, { ...a, kickoff: edge })).toBe(true);
  });

  const name = fc.stringMatching(/^[A-Z][a-z]{2,9}( [A-Z][a-z]{2,9}){0,2}$/);
  const listing = fc.record({
    home: name,
    away: name,
    kickoff: fc
      .integer({ min: 0, max: 3 * SAME_MATCH_KICKOFF_MS })
      .map((ms) => new Date(kickoff.getTime() + ms)),
  });

  it('is symmetric (property)', () => {
    fc.assert(
      fc.property(listing, listing, (a, b) => {
        expect(sameMatchLikely(a, b)).toBe(sameMatchLikely(b, a));
      }),
    );
  });

  it('pairs a listing with itself, and never across a kickoff gap over the window (property)', () => {
    fc.assert(
      fc.property(listing, fc.integer({ min: 1, max: 10 * SAME_MATCH_KICKOFF_MS }), (a, gap) => {
        expect(sameMatchLikely(a, a)).toBe(true);
        const far = { ...a, kickoff: new Date(a.kickoff.getTime() + SAME_MATCH_KICKOFF_MS + gap) };
        expect(sameMatchLikely(a, far)).toBe(false);
      }),
    );
  });
});
