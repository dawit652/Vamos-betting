/** Outbox event types written by the betting services (aggregate type 'bet'). */
export const BET_PLACED = 'bet.placed';
/** A pending live bet was accepted after the delay. */
export const BET_ACCEPTED = 'bet.accepted';
/** A pending live bet was rejected after the delay and its stake refunded. */
export const BET_REJECTED = 'bet.rejected';
/** A bet was settled (or settled again after a correction). */
export const BET_SETTLED = 'bet.settled';
/** A correction reversed a bet's settlement and the bet is open again. */
export const BET_REOPENED = 'bet.reopened';
/** A correction could not be reversed (player balance too low); needs the back office. */
export const BET_CORRECTION_BLOCKED = 'bet.correction_blocked';
/**
 * A bet was cashed out. Payload { betId, userId, shortId, stake, quotedGross,
 * gross, tax, net, cashedOutAt } (santim as strings).
 */
export const BET_CASHED_OUT = 'bet.cashed_out';
