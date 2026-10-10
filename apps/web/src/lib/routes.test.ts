import { describe, expect, it } from 'vitest';
import { routes, sportFromPath } from './routes';

describe('routes', () => {
  it('puts football at the root and other sports under /sport', () => {
    expect(routes.sport('football')).toBe('/');
    expect(routes.sport('tennis')).toBe('/sport/tennis');
    expect(routes.live()).toBe('/live');
    expect(routes.live('basketball')).toBe('/live/basketball');
    expect(routes.competition('football', 'et premier')).toBe('/sport/football/et%20premier');
  });

  it('reads the sport back from a path', () => {
    expect(sportFromPath('/')).toEqual({ sport: 'football', live: false });
    expect(sportFromPath('/live')).toEqual({ sport: 'football', live: true });
    expect(sportFromPath('/sport/tennis')).toEqual({ sport: 'tennis', live: false });
    expect(sportFromPath('/sport/tennis/atp')).toEqual({ sport: 'tennis', live: false });
    expect(sportFromPath('/live/volleyball')).toEqual({ sport: 'volleyball', live: true });
    expect(sportFromPath('/sport/chess')).toBeNull();
    expect(sportFromPath('/account')).toBeNull();
  });
});
