import type { SportCode } from '@vamos/core';
import { and, asc, eq, gt, inArray, lte, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { competitions, events, markets, selections, teams } from '../schema/catalog';
import { CatalogNotFoundError } from './errors';
import type { EventStatus, MarketStatus, SelectionStatus } from './live';

/**
 * Read helpers for the catalogue's writers (worker tasks, trading), which
 * work on raw rows rather than the public wire views of the read API.
 */

export interface CatalogIds {
  /** competition id by `<sport>/<slug>`. */
  competitions: Map<string, string>;
  /** team id by `<sport>/<short name>`. */
  teams: Map<string, string>;
}

/** Ids of every competition and team, for resolving feed fixtures. */
export async function loadCatalogIds(exec: DbExecutor): Promise<CatalogIds> {
  const competitionRows = await exec
    .select({ id: competitions.id, sportId: competitions.sportId, slug: competitions.slug })
    .from(competitions);
  const teamRows = await exec
    .select({ id: teams.id, sportId: teams.sportId, shortName: teams.shortName })
    .from(teams);
  return {
    competitions: new Map(competitionRows.map((row) => [`${row.sportId}/${row.slug}`, row.id])),
    teams: new Map(teamRows.map((row) => [`${row.sportId}/${row.shortName}`, row.id])),
  };
}

export interface SimulationCandidate {
  id: string;
  sport: SportCode;
  status: EventStatus;
  startTime: Date;
}

/**
 * Events of a feed provider the live simulator has to look at: live ones and
 * scheduled ones whose start time has come. Oldest start first.
 */
export async function listSimulationCandidates(
  exec: DbExecutor,
  options: { feedProvider: string; now: Date; limit?: number },
): Promise<SimulationCandidate[]> {
  const rows = await exec
    .select({
      id: events.id,
      sport: events.sportId,
      status: events.status,
      startTime: events.startTime,
    })
    .from(events)
    .where(
      and(
        eq(events.feedProvider, options.feedProvider),
        or(
          eq(events.status, 'live'),
          and(eq(events.status, 'scheduled'), lte(events.startTime, options.now)),
        ),
      ),
    )
    .orderBy(asc(events.startTime), asc(events.id))
    .limit(options.limit ?? 500);
  return rows.map((row) => ({ ...row, sport: row.sport as SportCode }));
}

/** Ids of a provider's scheduled events starting after `after`, soonest first. */
export async function listScheduledEventIds(
  exec: DbExecutor,
  options: { feedProvider: string; after: Date; limit?: number },
): Promise<string[]> {
  const rows = await exec
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.feedProvider, options.feedProvider),
        eq(events.status, 'scheduled'),
        gt(events.startTime, options.after),
      ),
    )
    .orderBy(asc(events.startTime), asc(events.id))
    .limit(options.limit ?? 500);
  return rows.map((row) => row.id);
}

export interface EventForSimulation {
  id: string;
  sport: SportCode;
  status: EventStatus;
  bettingOpen: boolean;
  startTime: Date;
  /** teams.ratings of both sides (pricing inputs of the mock feed). */
  homeRatings: Record<string, number> | null;
  awayRatings: Record<string, number> | null;
}

/** Locks an event (FOR UPDATE) and returns it with both teams' ratings. */
export async function lockEventForSimulation(
  tx: DbTransaction,
  eventId: string,
): Promise<EventForSimulation> {
  const home = alias(teams, 'home_team');
  const away = alias(teams, 'away_team');
  const [row] = await tx
    .select({
      id: events.id,
      sport: events.sportId,
      status: events.status,
      bettingOpen: events.bettingOpen,
      startTime: events.startTime,
      homeRatings: home.ratings,
      awayRatings: away.ratings,
    })
    .from(events)
    .innerJoin(home, eq(home.id, events.homeTeamId))
    .innerJoin(away, eq(away.id, events.awayTeamId))
    .where(eq(events.id, eventId))
    .for('update', { of: events });
  if (row === undefined) throw new CatalogNotFoundError('event', eventId);
  return { ...row, sport: row.sport as SportCode };
}

export interface MarketWithSelections {
  id: string;
  type: string;
  line: string | null;
  key: string;
  status: MarketStatus;
  /** In display order. */
  selections: Array<{ id: string; code: string; oddsMilli: number; status: SelectionStatus }>;
}

/** Every market of an event (id order) with its selections. */
export async function marketsWithSelections(
  exec: DbExecutor,
  eventId: string,
): Promise<MarketWithSelections[]> {
  const marketRows = await exec
    .select({
      id: markets.id,
      type: markets.type,
      line: markets.line,
      key: markets.key,
      status: markets.status,
    })
    .from(markets)
    .where(eq(markets.eventId, eventId))
    .orderBy(asc(markets.id));
  if (marketRows.length === 0) return [];
  const selectionRows = await exec
    .select({
      id: selections.id,
      marketId: selections.marketId,
      code: selections.code,
      oddsMilli: selections.oddsMilli,
      status: selections.status,
    })
    .from(selections)
    .where(
      inArray(
        selections.marketId,
        marketRows.map((row) => row.id),
      ),
    )
    .orderBy(asc(selections.sortOrder), asc(selections.id));
  const byMarket = new Map<string, MarketWithSelections['selections']>();
  for (const { marketId, ...selection } of selectionRows) {
    const list = byMarket.get(marketId) ?? [];
    list.push(selection);
    byMarket.set(marketId, list);
  }
  return marketRows.map((market) => ({ ...market, selections: byMarket.get(market.id) ?? [] }));
}
