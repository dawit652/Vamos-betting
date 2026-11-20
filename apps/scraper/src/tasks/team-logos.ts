import { eventsNeedingTeamLogos, markTeamLogosChecked, storeTeamLogo } from '@vamos/db';
import {
  API_FOOTBALL_HOST,
  API_FOOTBALL_KEY_HEADER,
  API_FOOTBALL_SECRET,
  apiFootballFixturesUrl,
  DAY_MS,
  matchApiFootballFixture,
  parseApiFootballFixtures,
  type ApiFootballFixture,
  type FetchResult,
} from '@vamos/scraper';
import type { ScraperContext } from '../context';
import { intervalTask, type IntervalTask } from '../lib/interval';
import { logoImagesAvailable, shrinkLogo } from '../lib/logo-image';

/**
 * Team logos (owner, 17 Nov 2026: "every team should have its logo"). Every TEAM_LOGOS_INTERVAL_MS:
 * the football matches of the next TEAM_LOGO_HORIZON_MS with a team that has no logo; one
 * API-Football request per kickoff day lists that day's fixtures, which carry each team's id; a
 * match is matched to exactly one fixture (kickoff and both names, as for the board's results);
 * each team's logo is downloaded once from API-Football's image host (no key, no quota), shrunk
 * to 64 px and stored (team_logos). A team looked for without a match waits TEAM_LOGO_RECHECK_MS.
 * Runs only with the API-Football key (SCRAPER_SECRET_API_FOOTBALL); SCRAPER_TEAM_LOGOS=off stops it.
 */

export const TEAM_LOGOS_INTERVAL_MS = 6 * 60 * 60_000;
export const TEAM_LOGO_HORIZON_MS = 2 * DAY_MS;
export const TEAM_LOGO_RECHECK_MS = 7 * DAY_MS;
/** Kickoff days asked per pass (each is one request of the daily quota). */
const MAX_DAYS_PER_PASS = 3;
/** Logos downloaded per pass; the rest come at the next pass. */
const MAX_DOWNLOADS_PER_PASS = 150;
export const API_FOOTBALL_MEDIA_HOST = 'media.api-sports.io';

export const teamLogoUrl = (apiFootballTeamId: number): string =>
  `https://${API_FOOTBALL_MEDIA_HOST}/football/teams/${apiFootballTeamId}.png`;

export interface TeamLogosSummary {
  candidates: number;
  /** Matches found among API-Football's fixtures. */
  matched: number;
  stored: number;
  /** Teams looked for without a logo found: asked again after the recheck period. */
  checked: number;
  failedRequests: number;
}

const dayOf = (at: Date): string => at.toISOString().slice(0, 10);

/** A failure worth trying again at the next pass; anything else waits TEAM_LOGO_RECHECK_MS. */
const passing = (result: FetchResult): boolean =>
  result.kind === 'circuit_open' ||
  result.kind === 'blocked' ||
  (result.kind === 'error' && result.retryable);

export async function runTeamLogos(ctx: ScraperContext): Promise<TeamLogosSummary> {
  const now = ctx.clock();
  const summary: TeamLogosSummary = {
    candidates: 0,
    matched: 0,
    stored: 0,
    checked: 0,
    failedRequests: 0,
  };
  const candidates = await eventsNeedingTeamLogos(ctx.db, {
    now,
    horizonMs: TEAM_LOGO_HORIZON_MS,
    recheckMs: TEAM_LOGO_RECHECK_MS,
    limit: 1000,
  });
  summary.candidates = candidates.length;
  if (candidates.length === 0) return summary;
  if (!(await logoImagesAvailable())) {
    // Nothing is asked or marked: the teams wait for a build where the image library loads.
    ctx.logger.error('team logos skipped: the image library (sharp) did not load');
    return summary;
  }

  const fixturesByDay = new Map<string, ApiFootballFixture[]>();
  for (const day of [...new Set(candidates.map((c) => dayOf(c.kickoff)))].slice(
    0,
    MAX_DAYS_PER_PASS,
  )) {
    const url = apiFootballFixturesUrl(day);
    await ctx.fetcher.forgetValidators(url);
    const result = await ctx.fetcher.fetch(
      {
        url,
        purpose: 'fixtures',
        auth: { header: API_FOOTBALL_KEY_HEADER, secret: API_FOOTBALL_SECRET },
      },
      { allowedHosts: [API_FOOTBALL_HOST], sourceKey: 'api-football-team-logos' },
    );
    if (result.kind !== 'ok') {
      summary.failedRequests += 1;
      ctx.logger.warn({ day, result: result.kind }, 'api-football fixtures for team logos failed');
      continue;
    }
    const parsed = parseApiFootballFixtures(new TextDecoder().decode(result.body));
    if (parsed === null || parsed.fixtures.length === 0) {
      summary.failedRequests += 1;
      ctx.logger.warn({ day, errors: parsed?.errors ?? [] }, 'api-football fixtures refused');
      continue;
    }
    fixturesByDay.set(day, parsed.fixtures);
  }

  // Team → API-Football id, and the teams looked for (a day not asked is not "looked for").
  const found = new Map<string, number>();
  const looked = new Set<string>();
  for (const candidate of candidates) {
    const fixtures = fixturesByDay.get(dayOf(candidate.kickoff));
    if (fixtures === undefined) continue;
    const fixture = matchApiFootballFixture(
      { home: candidate.home.name, away: candidate.away.name, kickoff: candidate.kickoff },
      fixtures,
    );
    if (fixture !== null) summary.matched += 1;
    for (const [team, apiId] of [
      [candidate.home, fixture?.homeId ?? null],
      [candidate.away, fixture?.awayId ?? null],
    ] as const) {
      if (!team.needsLogo) continue;
      looked.add(team.id);
      if (apiId !== null && !found.has(team.id)) found.set(team.id, apiId);
    }
  }

  // Stored, or tried again at the next pass (over the cap, a passing failure); the other teams
  // looked for (not found, no image, an unreadable image) wait TEAM_LOGO_RECHECK_MS.
  const settled = new Set<string>();
  for (const [index, [teamId, apiId]] of [...found].entries()) {
    if (index >= MAX_DOWNLOADS_PER_PASS) {
      settled.add(teamId);
      continue;
    }
    const image = await ctx.fetcher.fetch(
      { url: teamLogoUrl(apiId), purpose: 'fixtures', accept: 'image' },
      { allowedHosts: [API_FOOTBALL_MEDIA_HOST], sourceKey: 'api-football-team-logos' },
    );
    if (image.kind !== 'ok') {
      summary.failedRequests += 1;
      if (passing(image)) settled.add(teamId);
      ctx.logger.warn(
        {
          apiFootballTeamId: apiId,
          result: image.kind,
          reason: 'reason' in image ? image.reason : undefined,
        },
        'team logo download failed',
      );
      continue;
    }
    const png = await shrinkLogo(image.body);
    if (png === null) {
      ctx.logger.warn({ apiFootballTeamId: apiId }, 'team logo image unreadable');
      continue;
    }
    await storeTeamLogo(ctx.db, { teamId, apiFootballTeamId: apiId, png, now });
    settled.add(teamId);
    summary.stored += 1;
  }

  const waiting = [...looked].filter((id) => !settled.has(id));
  await markTeamLogosChecked(ctx.db, { teamIds: waiting, now });
  summary.checked = waiting.length;
  return summary;
}

export function teamLogosTask(ctx: ScraperContext): IntervalTask | null {
  if ((process.env[API_FOOTBALL_SECRET] ?? '').trim() === '') return null;
  if ((process.env.SCRAPER_TEAM_LOGOS ?? 'on').trim().toLowerCase() === 'off') return null;
  return intervalTask({
    name: 'team-logos',
    intervalMs: TEAM_LOGOS_INTERVAL_MS,
    run: () => runTeamLogos(ctx),
    logger: ctx.logger,
  });
}
