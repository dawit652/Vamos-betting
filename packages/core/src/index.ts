/**
 * @vamos/core – pure domain logic shared by the API, worker and front ends.
 * No I/O and no runtime dependencies. Money is `bigint` santim
 * (1 ETB = 100 santim); odds are integer milli (1.85 → 1850).
 */
export const CURRENCY = 'ETB' as const;

export * from './money';
export * from './odds';
export * from './risk';
export * from './rules';
export * from './multibonus';
export * from './tax';
export * from './betslip';
export * from './settlement';
export * from './cashout';
export * from './jackpot';
export * from './markets';
export * from './market-factory';
export * from './market-resolve';
export * from './market-labels';
export * from './market-consensus';
export * from './consensus-tolerance';
export * from './best-price';
export * from './phone';
export * from './age';
export * from './codes';
export * from './oddspolicy';
export * from './wagering';
export * from './businessday';
export * from './aml';
export * from './pspstatement';
export * from './scrape';
export * from './smstext';
export * from './textcommand';
export * from './channelreply';
export * from './ussd';
export * from './smsparse';
export * from './smsmatch';
export * from './balancechain';
export * from './paymentmethods';
export * from './payoutflow';
export * from './owner-alert';
