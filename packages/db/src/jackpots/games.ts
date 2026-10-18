import type { JackpotGameResult, Outcome1X2 } from '@vamos/core';
import { asc, eq, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { MarketStatus } from '../catalog/live';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { competitions, events, markets, selections, teams } from '../schema/catalog';
import { jackpotGames } from '../schema/jackpots';
import type { JackpotGame } from './types';

type SelectionResult = 'won' | 'lost' | 'void' | null;

/** What decides a game's result: its 1X2 market's status and the results of '1', 'X' and '2'. */
export interface GameResultSource {
  marketStatus: MarketStatus;
  results: Record<Outcome1X2, SelectionResult>;
}

/**
 * A jackpot game's result as the catalogue decides it now (pure):
 * - 'cancelled' when its 1X2 market is void, or every selection is void:
 *   resultEvent voids the markets of a cancelled, abandoned or postponed
 *   match (and the feed withdraws stale fixtures that way);
 * - '1', 'X' or '2' once the market is settled with exactly that selection
 *   won and the other two lost;
 * - null otherwise: not resulted yet, or a state that does not add up (the
 *   round then waits rather than settle on it).
 */
export function catalogueGameResult(source: GameResultSource): JackpotGameResult | null {
  const { results } = source;
  if (source.marketStatus === 'void') return 'cancelled';
  if (results['1'] === 'void' && results.X === 'void' && results['2'] === 'void') {
    return 'cancelled';
  }
  if (source.marketStatus !== 'settled') return null;
  const won = (['1', 'X', '2'] as const).filter((code) => results[code] === 'won');
  const lost = (['1', 'X', '2'] as const).filter((code) => results[code] === 'lost');
  const [winner] = won;
  if (won.length === 1 && lost.length === 2 && winner !== undefined) return winner;
  return null;
}

/** A game with its catalogue state: the view fields plus what its result is now. */
export interface LoadedJackpotGame extends JackpotGame {
  roundId: string;
  /** The result the catalogue gives now (catalogueGameResult); `result` is the recorded one. */
  current: JackpotGameResult | null;
  /** events.betting_open: false while a trader or the feed halts betting on the event. */
  bettingOpen: boolean;
}

const homeTeams = alias(teams, 'home_team');
const awayTeams = alias(teams, 'away_team');
const homeSelections = alias(selections, 'home_selection');
const drawSelections = alias(selections, 'draw_selection');
const awaySelections = alias(selections, 'away_selection');

/**
 * The games of the given rounds with their events, 1X2 odds and results,
 * by round id, each list in game order. Reads only.
 */
export async function loadJackpotGames(
  exec: DbExecutor,
  roundIds: readonly string[],
): Promise<Map<string, LoadedJackpotGame[]>> {
  const byRound = new Map<string, LoadedJackpotGame[]>();
  const ids = [...new Set(roundIds)];
  if (ids.length === 0) return byRound;
  const rows = await exec
    .select({
      roundId: jackpotGames.roundId,
      position: jackpotGames.position,
      eventId: jackpotGames.eventId,
      marketId: jackpotGames.marketId,
      homeSelectionId: jackpotGames.homeSelectionId,
      drawSelectionId: jackpotGames.drawSelectionId,
      awaySelectionId: jackpotGames.awaySelectionId,
      result: jackpotGames.result,
      gameId: events.gameId,
      sportId: events.sportId,
      competitionName: competitions.name,
      homeTeam: homeTeams.name,
      awayTeam: awayTeams.name,
      startTime: events.startTime,
      eventStatus: events.status,
      bettingOpen: events.bettingOpen,
      scoreHome: events.scoreHome,
      scoreAway: events.scoreAway,
      marketStatus: markets.status,
      homeOdds: homeSelections.oddsMilli,
      homeStatus: homeSelections.status,
      homeResult: homeSelections.result,
      drawOdds: drawSelections.oddsMilli,
      drawStatus: drawSelections.status,
      drawResult: drawSelections.result,
      awayOdds: awaySelections.oddsMilli,
      awayStatus: awaySelections.status,
      awayResult: awaySelections.result,
    })
    .from(jackpotGames)
    .innerJoin(events, eq(events.id, jackpotGames.eventId))
    .innerJoin(competitions, eq(competitions.id, events.competitionId))
    .innerJoin(homeTeams, eq(homeTeams.id, events.homeTeamId))
    .innerJoin(awayTeams, eq(awayTeams.id, events.awayTeamId))
    .innerJoin(markets, eq(markets.id, jackpotGames.marketId))
    .innerJoin(homeSelections, eq(homeSelections.id, jackpotGames.homeSelectionId))
    .innerJoin(drawSelections, eq(drawSelections.id, jackpotGames.drawSelectionId))
    .innerJoin(awaySelections, eq(awaySelections.id, jackpotGames.awaySelectionId))
    .where(inArray(jackpotGames.roundId, ids))
    .orderBy(asc(jackpotGames.roundId), asc(jackpotGames.position));
  for (const row of rows) {
    const oddsOpen =
      row.marketStatus === 'open' &&
      row.homeStatus === 'open' &&
      row.drawStatus === 'open' &&
      row.awayStatus === 'open';
    const game: LoadedJackpotGame = {
      roundId: row.roundId,
      position: row.position,
      eventId: row.eventId,
      marketId: row.marketId,
      selectionIds: { '1': row.homeSelectionId, X: row.drawSelectionId, '2': row.awaySelectionId },
      gameId: row.gameId,
      sportId: row.sportId,
      competitionName: row.competitionName,
      homeTeam: row.homeTeam,
      awayTeam: row.awayTeam,
      startTime: row.startTime,
      eventStatus: row.eventStatus,
      scoreHome: row.scoreHome,
      scoreAway: row.scoreAway,
      odds: oddsOpen ? { '1': row.homeOdds, X: row.drawOdds, '2': row.awayOdds } : null,
      result: row.result,
      bettingOpen: row.bettingOpen,
      current: catalogueGameResult({
        marketStatus: row.marketStatus,
        results: { '1': row.homeResult, X: row.drawResult, '2': row.awayResult },
      }),
    };
    const list = byRound.get(row.roundId) ?? [];
    list.push(game);
    byRound.set(row.roundId, list);
  }
  return byRound;
}

/** The games of one round (game order). */
export async function loadRoundGames(
  exec: DbExecutor,
  roundId: string,
): Promise<LoadedJackpotGame[]> {
  return (await loadJackpotGames(exec, [roundId])).get(roundId) ?? [];
}

/**
 * Locks the events of the round's games FOR SHARE, in id order (the
 * catalogue's lock order starts at the event): resulting, the live
 * simulator and the feed take the event FOR UPDATE before they change its
 * status, results or start, so what the caller reads next stays as it is
 * until COMMIT. With `markets`, also locks the games' 1X2 markets FOR SHARE
 * (id order), so a trader's suspension waits for the caller, or is seen.
 */
export async function lockRoundEvents(
  tx: DbTransaction,
  roundId: string,
  options: { markets?: boolean } = {},
): Promise<void> {
  const rows = await tx
    .select({ eventId: jackpotGames.eventId, marketId: jackpotGames.marketId })
    .from(jackpotGames)
    .where(eq(jackpotGames.roundId, roundId));
  const eventIds = [...new Set(rows.map((row) => row.eventId))].sort();
  if (eventIds.length === 0) return;
  await tx
    .select({ id: events.id })
    .from(events)
    .where(inArray(events.id, eventIds))
    .orderBy(asc(events.id))
    .for('share');
  if (options.markets !== true) return;
  // setMarketStatus locks only the market row (event → market is the catalogue's order).
  const marketIds = [...new Set(rows.map((row) => row.marketId))].sort();
  await tx
    .select({ id: markets.id })
    .from(markets)
    .where(inArray(markets.id, marketIds))
    .orderBy(asc(markets.id))
    .for('share');
}
