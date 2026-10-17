/**
 * Outbox event types written by the jackpot services. Payload money values
 * are santim strings.
 */

/**
 * A round started taking entries (aggregate 'jackpot_round'). Payload
 * { roundId, templateCode, closesAt, gameCount, costPerCombination,
 * maxCombinations, pool, eventIds }.
 */
export const JACKPOT_ROUND_OPENED = 'jackpot.round_opened';

/**
 * A round stopped taking entries (aggregate 'jackpot_round'). Payload
 * { roundId, templateCode, closesAt, closedAt, entries, stakes }.
 */
export const JACKPOT_ROUND_CLOSED = 'jackpot.round_closed';

/**
 * An entry was placed (aggregate 'jackpot_entry'). Payload { entryId,
 * roundId, userId, templateCode, combinations, cost, channel }.
 */
export const JACKPOT_ENTERED = 'jackpot.entered';

/**
 * One entry of a round was settled or refunded (aggregate 'jackpot_entry'),
 * the player push of Phase 8. Payload { entryId, roundId, userId,
 * templateCode, status: 'won' | 'lost' | 'void', cost, gross, tax, net,
 * refund, bestCorrect }: gross / tax / net are the prize ('0' when lost or
 * void); refund is the cost given back when the round is void ('0'
 * otherwise). The player's balance went up by net + refund.
 */
export const JACKPOT_SETTLED = 'jackpot.settled';

/**
 * A round was settled or voided (aggregate 'jackpot_round'). Payload
 * { roundId, templateCode, status: 'settled' | 'cancelled', void,
 * voidReason, results, cancelledGames, entries, winners, stakes, gross,
 * tax, net, refunds, undistributed }.
 */
export const JACKPOT_ROUND_SETTLED = 'jackpot.round_settled';

/**
 * A game's result changed after its round was settled (aggregate
 * 'jackpot_round'): nothing is paid again; the back office reviews it.
 * Payload { roundId, templateCode, games: [{ position, eventId, settled,
 * current }] }. Written once per round (results_flagged_at).
 */
export const JACKPOT_RESULT_MISMATCH = 'jackpot.result_mismatch';
