import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fixtureFeedRef } from './gates';
import { fixtureKey } from './normalize';

describe('fixture key', () => {
  it('the gates and the normalizer build the same key', () => {
    const when = fc
      .integer({ min: Date.UTC(2000, 0, 1), max: Date.UTC(2100, 0, 1) })
      .map((ms) => new Date(ms));
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.uuid(),
        fc.uuid(),
        when,
        (competitionId, homeTeamId, awayTeamId, d) => {
          expect(fixtureFeedRef({ competitionId, homeTeamId, awayTeamId }, d)).toBe(
            fixtureKey({ competitionId, homeTeamId, awayTeamId, firstKickoff: d }),
          );
        },
      ),
    );
  });
});
