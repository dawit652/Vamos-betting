import { describe, expect, it } from 'vitest';
import tennisScores from './fixtures/real/scores-tennis.json';
import { hasFeedScores, NO_FEED_SCORES_REVIEW_AFTER_MS } from './coverage';

describe('feed score coverage', () => {
  it('reads scores for football and basketball, never for tennis', () => {
    expect(hasFeedScores('football')).toBe(true);
    expect(hasFeedScores('basketball')).toBe(true);
    expect(hasFeedScores('tennis')).toBe(false);
    expect(hasFeedScores('volleyball')).toBe(false);
  });

  it('matches the real capture: a tennis match two hours in had no score', () => {
    const [match] = tennisScores;
    expect(match).toMatchObject({ completed: false, scores: null, last_update: null });
    expect(NO_FEED_SCORES_REVIEW_AFTER_MS).toBeGreaterThanOrEqual(5 * 60 * 60 * 1000);
  });
});
