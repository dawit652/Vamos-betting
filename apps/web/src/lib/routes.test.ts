import { describe, expect, it } from 'vitest';
import { routes } from './routes';

describe('routes', () => {
  it('puts football at the root and other sports under /sport', () => {
    expect(routes.sport('football')).toBe('/');
    expect(routes.sport('tennis')).toBe('/sport/tennis');
    expect(routes.live()).toBe('/live');
    expect(routes.live('basketball')).toBe('/live/basketball');
    expect(routes.competition('football', 'et premier')).toBe('/sport/football/et%20premier');
  });
});
