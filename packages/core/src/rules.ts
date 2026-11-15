import { type Santim, birr } from './money';
import type { OddsMilli } from './odds';

/**
 * Business-rule configuration types and their defaults. Every value is
 * editable in the back office (stored in the `settings` table) and must be
 * confirmed with counsel before a licensed launch.
 */

export interface BetRules {
  /** Minimum stake per bet. Betika-style low entry: 5 ETB. */
  minStake: Santim;
  /** Maximum stake per bet. */
  maxStake: Santim;
  /** Maximum gross payout (return + bonus) per bet; anything above is capped. */
  maxPayout: Santim;
  /** Maximum number of legs in an accumulator. */
  maxLegs: number;
  /** Lowest odds accepted on any leg. */
  minLegOddsMilli: OddsMilli;
  /** Highest combined odds accepted (milli). */
  maxTotalOddsMilli: bigint;
}

export interface MultiBonusTier {
  /** Minimum number of qualifying legs for this tier. */
  minLegs: number;
  /** Bonus on winnings (gross return − stake) in basis points. */
  percentBps: number;
}

export interface MultiBonusConfig {
  enabled: boolean;
  /** A leg qualifies for the bonus only if its odds are at least this. */
  minLegOddsMilli: OddsMilli;
  /** Tiers sorted by ascending `minLegs`; the highest reached tier applies. */
  tiers: MultiBonusTier[];
  /** Maximum bonus amount per bet. */
  maxBonus: Santim;
}

export type TaxBase = 'net_winnings' | 'gross_payout';

export interface TaxConfig {
  /** Winnings tax rate in basis points (2000 = 20%). */
  rateBps: number;
  /**
   * What the rate applies to. `net_winnings` = gross payout − stake (a winning
   * bet can never pay less than its stake); `gross_payout` = the whole payout.
   */
  base: TaxBase;
  /** No tax when the taxable base is strictly below this amount. */
  exemptBelow: Santim;
}

export interface CashOutConfig {
  enabled: boolean;
  /** House margin taken from the fair cash-out value, in basis points. */
  marginBps: number;
  /** Offers below this amount are not shown. */
  minOffer: Santim;
}

/**
 * How a cancelled (or abandoned, postponed) game of a jackpot counts:
 * `all_win` counts every pick of the game as correct. Under every rule a
 * draw with more than half of its games cancelled is void and every entry
 * is refunded (isJackpotDrawVoid in jackpot.ts).
 */
export type JackpotCancelledRule = 'all_win';

export interface JackpotPrizeTier {
  /** Number of correct predictions required (e.g. 13 of 13). */
  correct: number;
  /**
   * `shared`: `amount` is a pool split equally between all winning combinations.
   * `fixed`: every winning combination receives `amount`.
   */
  kind: 'shared' | 'fixed';
  amount: Santim;
}

export interface JackpotTemplate {
  code: 'daily9' | 'weekly13';
  /**
   * Whether new rounds of this template are opened. Rounds already open run
   * to the end on the terms they were opened with.
   */
  enabled: boolean;
  gameCount: number;
  costPerCombination: Santim;
  maxCombinations: number;
  cancelledRule: JackpotCancelledRule;
  /**
   * Sorted by descending `correct`. The first tier (every game correct) is
   * the advertised jackpot ("pool").
   */
  prizeTiers: JackpotPrizeTier[];
}

export interface ResponsibleGamblingRules {
  minAge: number;
}

/**
 * Deposit and withdrawal limits (the `payments` setting). A "day" is the
 * last 24 hours (rolling), like the responsible-gambling windows.
 */
export interface PaymentRules {
  /** Smallest deposit accepted. */
  minDeposit: Santim;
  /** Largest single deposit accepted. */
  maxDeposit: Santim;
  /** Smallest withdrawal accepted. */
  minWithdrawal: Santim;
  /** Largest single withdrawal accepted. */
  maxWithdrawal: Santim;
  /** Most a player may withdraw over any rolling 24 hours (open and paid requests). */
  dailyWithdrawalCap: Santim;
  /**
   * Withdrawals strictly below this amount are approved automatically (when
   * every other check passes); the rest wait for manual review.
   */
  autoApproveBelow: Santim;
  /**
   * Turnover required per deposited birr before a withdrawal, in basis points
   * (10_000 = each deposit must be staked once). See `remainingWagering`.
   */
  wageringMultiplierBps: number;
  /** A deposit intent not completed within this many minutes expires. */
  depositIntentTtlMinutes: number;
  /** Payout attempts at the provider before a payout needs manual handling. */
  payoutMaxAttempts: number;
}

export const DEFAULT_BET_RULES: BetRules = {
  minStake: birr(5),
  maxStake: birr(100_000),
  maxPayout: birr(500_000),
  maxLegs: 40,
  minLegOddsMilli: 1010,
  maxTotalOddsMilli: 1_000_000_000n, // 1,000,000.000
};

/** Nahubet accumulator bonus ladder (on winnings). */
export const DEFAULT_MULTI_BONUS: MultiBonusConfig = {
  enabled: true,
  minLegOddsMilli: 1300,
  tiers: [
    { minLegs: 3, percentBps: 300 },
    { minLegs: 4, percentBps: 500 },
    { minLegs: 5, percentBps: 800 },
    { minLegs: 6, percentBps: 1_000 },
    { minLegs: 7, percentBps: 1_500 },
    { minLegs: 8, percentBps: 2_000 },
    { minLegs: 9, percentBps: 2_500 },
    { minLegs: 10, percentBps: 3_000 },
    { minLegs: 12, percentBps: 4_000 },
    { minLegs: 15, percentBps: 5_000 },
    { minLegs: 20, percentBps: 10_000 },
    { minLegs: 25, percentBps: 15_000 },
    { minLegs: 30, percentBps: 20_000 },
  ],
  maxBonus: birr(50_000),
};

/**
 * Proclamation 1395/2025 reportedly sets 20–25% on lottery/betting winnings.
 * Rate, base and exemption are placeholders pending legal confirmation.
 */
export const DEFAULT_TAX: TaxConfig = {
  rateBps: 2_000,
  base: 'net_winnings',
  exemptBelow: birr(100),
};

export const DEFAULT_CASH_OUT: CashOutConfig = {
  enabled: true,
  marginBps: 500,
  minOffer: birr(1),
};

export const DEFAULT_LIVE_BET_DELAY_MS = 6_000;

export const DEFAULT_RESPONSIBLE_GAMBLING: ResponsibleGamblingRules = {
  minAge: 21,
};

export const DEFAULT_JACKPOTS: Record<JackpotTemplate['code'], JackpotTemplate> = {
  daily9: {
    code: 'daily9',
    enabled: true,
    gameCount: 9,
    costPerCombination: birr(10),
    maxCombinations: 1_024,
    cancelledRule: 'all_win',
    prizeTiers: [
      { correct: 9, kind: 'shared', amount: birr(100_000) },
      { correct: 8, kind: 'fixed', amount: birr(200) },
    ],
  },
  weekly13: {
    code: 'weekly13',
    enabled: true,
    gameCount: 13,
    costPerCombination: birr(10),
    maxCombinations: 4_096,
    cancelledRule: 'all_win',
    prizeTiers: [
      { correct: 13, kind: 'shared', amount: birr(1_000_000) },
      { correct: 12, kind: 'shared', amount: birr(100_000) },
      { correct: 11, kind: 'fixed', amount: birr(500) },
      { correct: 10, kind: 'fixed', amount: birr(50) },
    ],
  },
};

/** Payment limits (placeholders to confirm with counsel and the PSPs). */
export const DEFAULT_PAYMENT_RULES: PaymentRules = {
  minDeposit: birr(10),
  maxDeposit: birr(100_000),
  minWithdrawal: birr(50),
  maxWithdrawal: birr(100_000),
  dailyWithdrawalCap: birr(200_000),
  autoApproveBelow: birr(5_000),
  wageringMultiplierBps: 10_000,
  depositIntentTtlMinutes: 30,
  payoutMaxAttempts: 5,
};
