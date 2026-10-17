import type {
  JackpotEntryGameView,
  JackpotEntryView,
  JackpotGameView,
  JackpotRoundView,
  JackpotSettlementView,
  LocalizedNameValue,
  MultiBonusView,
} from '@vamos/contracts';
import { formatGameId, jackpotPickHit, toWire, type MultiBonusConfig } from '@vamos/core';
import type { JackpotGame, JackpotRound, UserJackpotEntry } from '@vamos/db';
import { isSportCode, localized } from '../catalog/views';

/**
 * Pure builders of the jackpot and promotions wire views (no I/O). Money
 * goes out as santim strings, combination counts as decimal strings, times
 * as ISO strings.
 */

const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());
const wire = (amount: bigint | null): string | null => (amount === null ? null : toWire(amount));

function name(value: LocalizedNameValue): LocalizedNameValue {
  return localized(value);
}

/** One game of a round. */
export function jackpotGameView(game: JackpotGame): JackpotGameView {
  const score =
    game.eventStatus === 'scheduled' || game.scoreHome === null || game.scoreAway === null
      ? null
      : { home: game.scoreHome, away: game.scoreAway };
  return {
    position: game.position,
    eventId: game.eventId,
    gameId: formatGameId(game.gameId),
    // Jackpot games are football 1X2 games (JACKPOT_SPORT).
    sport: isSportCode(game.sportId) ? game.sportId : 'football',
    eventName: `${game.homeTeam.en} vs ${game.awayTeam.en}`,
    homeTeam: name(game.homeTeam),
    awayTeam: name(game.awayTeam),
    competition: name(game.competitionName),
    startTime: game.startTime.toISOString(),
    status: game.eventStatus,
    score,
    odds: game.odds === null ? null : { '1': game.odds['1'], X: game.odds.X, '2': game.odds['2'] },
    result: game.result,
  };
}

/**
 * The public outcome of a settled or cancelled round: the tiers as paid
 * and the number of winners. Stakes, totals and the house's share stay
 * internal (back office).
 */
export function jackpotSettlementView(round: JackpotRound): JackpotSettlementView | null {
  const settlement = round.settlement;
  if (settlement === null) return null;
  return {
    void: settlement.void,
    voidReason: settlement.voidReason,
    cancelledGames: settlement.cancelledGames,
    winners: settlement.winners,
    payouts: settlement.payouts.map((payout) => ({
      correct: payout.correct,
      kind: payout.kind,
      winningCombinations: payout.winningCombinations.toString(),
      prizePerCombination: toWire(payout.prizePerCombination),
      total: toWire(payout.total),
    })),
  };
}

export function jackpotRoundView(round: JackpotRound): JackpotRoundView {
  return {
    id: round.id,
    templateCode: round.templateCode,
    status: round.status,
    gameCount: round.gameCount,
    closesAt: round.closesAt.toISOString(),
    costPerCombination: toWire(round.costPerCombination),
    maxCombinations: round.maxCombinations,
    pool: toWire(round.pool),
    cancelledRule: round.template.cancelledRule,
    prizeTiers: [...round.template.prizeTiers]
      .sort((a, b) => b.correct - a.correct)
      .map((tier) => ({ correct: tier.correct, kind: tier.kind, amount: toWire(tier.amount) })),
    games: round.games.map(jackpotGameView),
    settledAt: iso(round.settledAt),
    settlement: jackpotSettlementView(round),
  };
}

/** One of the player's entries with each game's picks and whether they hit. */
export function jackpotEntryView(entry: UserJackpotEntry): JackpotEntryView {
  const { round } = entry;
  const rule = round.template.cancelledRule;
  const games = round.games.map((game): JackpotEntryGameView => {
    const picks = entry.picks[game.position] ?? [];
    return {
      ...jackpotGameView(game),
      picks: [...picks],
      hit: jackpotPickHit(picks, game.result, rule),
    };
  });
  return {
    id: entry.id,
    roundId: entry.roundId,
    templateCode: round.templateCode,
    status: entry.status,
    roundStatus: round.status,
    closesAt: round.closesAt.toISOString(),
    picks: entry.picks.map((picks) => [...picks]),
    combinations: entry.combinations,
    cost: toWire(entry.cost),
    correct: entry.correct === null ? null : entry.correct.map((count) => count.toString()),
    bestCorrect: entry.bestCorrect,
    prizeGross: wire(entry.prizeGross),
    prizeTax: wire(entry.prizeTax),
    prizeNet: wire(entry.prizeNet),
    refund: wire(entry.refund),
    placedAt: entry.placedAt.toISOString(),
    settledAt: iso(entry.settledAt),
    games,
  };
}

export function multiBonusView(config: MultiBonusConfig): MultiBonusView {
  return {
    enabled: config.enabled,
    minLegOddsMilli: config.minLegOddsMilli,
    maxBonus: toWire(config.maxBonus),
    tiers: [...config.tiers]
      .sort((a, b) => a.minLegs - b.minLegs)
      .map((tier) => ({ minLegs: tier.minLegs, percentBps: tier.percentBps })),
  };
}
