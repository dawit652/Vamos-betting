import type { BetLine, ChannelLocale, JackpotSummary } from '@vamos/core';
import { desc, eq } from 'drizzle-orm';
import { isUuid } from '../betting/selections';
import { listOpenJackpotRounds } from '../jackpots/queries';
import { getPlayerBalances } from '../ledger/queries';
import type { DbExecutor } from '../ledger/types';
import { bets } from '../schema/betting';
import { channelName } from './games';

/** Bets listed by BETS and the USSD "My bets" screen. */
export const CHANNEL_RECENT_BETS = 3;

/** BAL: the player's cash and bonus balances (santim). */
export async function channelBalances(
  exec: DbExecutor,
  userId: string,
): Promise<{ cash: bigint; bonus: bigint }> {
  return getPlayerBalances(exec, userId);
}

/**
 * BETS: the player's latest bets, newest first, whatever their status or
 * channel, with what each paid when won or cashed out (net).
 */
export async function recentBetLines(
  exec: DbExecutor,
  userId: string,
  limit: number = CHANNEL_RECENT_BETS,
): Promise<BetLine[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new RangeError('limit must be an integer between 1 and 20');
  }
  if (!isUuid(userId)) return [];
  return exec
    .select({
      shortId: bets.shortId,
      status: bets.status,
      stake: bets.stake,
      potentialNetPayout: bets.potentialNetPayout,
      settledNetPayout: bets.settledNetPayout,
    })
    .from(bets)
    .where(eq(bets.userId, userId))
    .orderBy(desc(bets.placedAt), desc(bets.id))
    .limit(limit);
}

/**
 * JP: the jackpot rounds taking entries now (soonest closing first) with
 * their games (Game IDs and team names in the reply language) and cost per
 * combination. Entering by SMS is out of scope: the reply points to the website.
 */
export async function openJackpotSummaries(
  exec: DbExecutor,
  now: Date,
  locale: ChannelLocale,
): Promise<JackpotSummary[]> {
  const rounds = await listOpenJackpotRounds(exec, { now });
  return rounds.map((round) => ({
    templateCode: round.templateCode,
    gameCount: round.gameCount,
    costPerCombination: round.costPerCombination,
    pool: round.pool,
    closesAt: round.closesAt,
    games: round.games.map((game) => ({
      gameId: game.gameId,
      home: channelName(game.homeTeam, locale),
      away: channelName(game.awayTeam, locale),
    })),
  }));
}
