import { z } from 'zod';
import { EventStatusSchema, LocalizedNameSchema, SportCodeSchema } from './catalog';
import { OddsMilli, PageQuery, Santim } from './common';

/**
 * Jackpots and promotions (Phase 8). Money is santim as a decimal string;
 * odds are integer milli; times are ISO strings.
 *
 * A jackpot round is a fixed list of football games, each decided by its
 * 1X2 result. An entry picks one, two or all three outcomes ('1' home win,
 * 'X' draw, '2' away win) for every game and costs `costPerCombination` for
 * each way of choosing one pick per game (the product of the pick counts),
 * up to `maxCombinations`. Entries close at the first kick-off (`closesAt`).
 * Prize tiers are not cumulative: a combination wins the tier whose
 * `correct` equals its exact number of correct predictions (shared tiers
 * split their amount equally between the winning combinations, rounded
 * down; fixed tiers pay their amount per winning combination). A cancelled,
 * abandoned or postponed game counts every pick as correct (`all_win`); a
 * round with more than half of its games cancelled is void and every entry
 * is refunded. A prize above the entry's cost is winnings and is taxed like
 * bet winnings (`prizeTax`); jackpot entries are stakes for responsible
 * gambling limits and deposit wagering.
 *
 * Endpoints:
 * - GET /jackpots?template=&limit=&cursor= → JackpotListResponse: the open
 *   rounds (all of them) and a page of past rounds (closed, settled or
 *   cancelled; the cursor pages these).
 * - GET /jackpots/:id → JackpotRoundView (404 for an unknown id).
 * - POST /jackpots/:id/entries (auth, CSRF, Idempotency-Key header) with
 *   JackpotEntryRequest → JackpotEntryView. A replay with the same key and
 *   picks returns the same entry with the `idempotent-replayed: true` header;
 *   the key with other picks or another round → 422 `idempotency_key_reused`.
 *   Errors: 404 `not_found`, 409 `jackpot_closed` (JackpotClosedDetails),
 *   422 `jackpot_entry_invalid` (JackpotEntryInvalidDetails), 422
 *   `insufficient_funds` (details { balance, cost }), the responsible-gambling
 *   403 / 422 errors of bet placement (the cost is the stake), 429.
 * - GET /me/jackpot-entries?status=open|settled&limit=&cursor= →
 *   MyJackpotEntriesResponse, newest first (no status: all).
 * - GET /me/jackpot-entries/:id → JackpotEntryView (404 for another
 *   player's entry).
 * - GET /promotions → PromotionsResponse (public).
 * The player push `jackpot.settled` (user-stream.ts) tells the owner an
 * entry was settled or refunded.
 */

/** The jackpot templates (tabs): a 9-game daily and a 13-game weekly jackpot. */
export const JackpotTemplateCodeSchema = z.enum(['daily9', 'weekly13']);
export type JackpotTemplateCode = z.infer<typeof JackpotTemplateCodeSchema>;

/** A pick: '1' home win, 'X' draw, '2' away win. */
export const JackpotOutcomeSchema = z.enum(['1', 'X', '2']);
export type JackpotOutcome = z.infer<typeof JackpotOutcomeSchema>;

/** A game's result: its 1X2 outcome, or `cancelled` (every pick counts as correct). */
export const JackpotGameResultSchema = z.enum(['1', 'X', '2', 'cancelled']);
export type JackpotGameResult = z.infer<typeof JackpotGameResultSchema>;

/**
 * - scheduled: announced, not taking entries yet;
 * - open: taking entries until `closesAt`;
 * - closed: entries closed, waiting for results;
 * - settled: prizes paid;
 * - cancelled: void (more than half of the games cancelled): entries refunded.
 */
export const JackpotRoundStatusSchema = z.enum([
  'scheduled',
  'open',
  'closed',
  'settled',
  'cancelled',
]);
export type JackpotRoundStatus = z.infer<typeof JackpotRoundStatusSchema>;

/** open until the round settles; won (a prize above 0), lost, or void (refunded). */
export const JackpotEntryStatusSchema = z.enum(['open', 'won', 'lost', 'void']);
export type JackpotEntryStatus = z.infer<typeof JackpotEntryStatusSchema>;

/** How a cancelled game counts (only `all_win` exists: every pick is correct). */
export const JackpotCancelledRuleSchema = z.enum(['all_win']);

const Count = z.number().int().min(0);
/** A combination count that may exceed 2^53, as a decimal string. */
const BigCount = z.string().regex(/^\d+$/, 'expected a decimal count');

export const JackpotPrizeTierView = z.object({
  /** Exact number of correct predictions this tier pays. */
  correct: Count,
  /** shared: `amount` is split between the winning combinations; fixed: paid per combination. */
  kind: z.enum(['shared', 'fixed']),
  amount: Santim,
});
export type JackpotPrizeTierView = z.infer<typeof JackpotPrizeTierView>;

/** One prize tier of a settled round. */
export const JackpotTierPayoutView = z.object({
  correct: Count,
  kind: z.enum(['shared', 'fixed']),
  /** Winning combinations across all entries. */
  winningCombinations: BigCount,
  /** What each winning combination won ("0" when nobody won a shared tier). */
  prizePerCombination: Santim,
  /** prizePerCombination × winningCombinations. */
  total: Santim,
});
export type JackpotTierPayoutView = z.infer<typeof JackpotTierPayoutView>;

/** The outcome of a settled or cancelled round. */
export const JackpotSettlementView = z.object({
  void: z.boolean(),
  /** cancelled_games: more than half of the games were cancelled; not_opened: never opened. */
  voidReason: z.enum(['cancelled_games', 'not_opened']).nullable(),
  cancelledGames: Count,
  /** Entries that won a prize. */
  winners: Count,
  /** Every prize tier as paid, in tier order (empty when void). */
  payouts: z.array(JackpotTierPayoutView),
});
export type JackpotSettlementView = z.infer<typeof JackpotSettlementView>;

/** One game of a round. */
export const JackpotGameView = z.object({
  /** 0-based game order: picks are sent in this order. */
  position: Count,
  eventId: z.string(),
  /** The fixture's Game ID (formatGameId). */
  gameId: z.string(),
  sport: SportCodeSchema,
  /** "Home vs Away" in English (show `homeTeam` / `awayTeam` in the player's language). */
  eventName: z.string(),
  homeTeam: LocalizedNameSchema,
  awayTeam: LocalizedNameSchema,
  competition: LocalizedNameSchema,
  startTime: z.string(),
  status: EventStatusSchema,
  score: z.object({ home: Count, away: Count }).nullable(),
  /** The 1X2 odds now, for information only (jackpots are not priced by odds); null when not open. */
  odds: z.object({ '1': OddsMilli, X: OddsMilli, '2': OddsMilli }).nullable(),
  /** null until the game has a result. */
  result: JackpotGameResultSchema.nullable(),
});
export type JackpotGameView = z.infer<typeof JackpotGameView>;

export const JackpotRoundView = z.object({
  id: z.string(),
  templateCode: JackpotTemplateCodeSchema,
  status: JackpotRoundStatusSchema,
  gameCount: z.number().int().min(1),
  /** Entries close at the first kick-off. */
  closesAt: z.string(),
  costPerCombination: Santim,
  maxCombinations: z.number().int().min(1),
  /** The advertised jackpot: the amount of the first (every game correct) tier. */
  pool: Santim,
  cancelledRule: JackpotCancelledRuleSchema,
  /** Sorted by descending `correct`. */
  prizeTiers: z.array(JackpotPrizeTierView),
  games: z.array(JackpotGameView),
  settledAt: z.string().nullable(),
  /** Set once the round is settled or cancelled. */
  settlement: JackpotSettlementView.nullable(),
});
export type JackpotRoundView = z.infer<typeof JackpotRoundView>;

/** GET /jackpots: `limit` and `cursor` page the past rounds. */
export const JackpotListQuery = PageQuery.extend({
  template: JackpotTemplateCodeSchema.optional(),
});
export type JackpotListQuery = z.infer<typeof JackpotListQuery>;

export const JackpotListResponse = z.object({
  /** Rounds taking entries now, soonest closing first. */
  open: z.array(JackpotRoundView),
  /** Past rounds (closed, settled, cancelled), latest first. */
  recent: z.array(JackpotRoundView),
  /** Cursor of the next page of past rounds, or null. */
  nextCursor: z.string().nullable(),
});
export type JackpotListResponse = z.infer<typeof JackpotListResponse>;

/** Most games a round can have. */
export const MAX_JACKPOT_GAMES = 30;

/** One game's picks: 1 to 3 different outcomes (any order; stored as 1, X, 2). */
export const JackpotGamePicksSchema = z
  .array(JackpotOutcomeSchema)
  .min(1, 'pick at least one outcome')
  .max(3)
  .refine((picks) => new Set(picks).size === picks.length, 'an outcome is picked more than once');

/**
 * POST /jackpots/:id/entries (Idempotency-Key header required): one array
 * of picks per game, in game order. The server checks the game count and
 * the maximum number of combinations against the round (422
 * `jackpot_entry_invalid`) and charges combinations × costPerCombination.
 */
export const JackpotEntryRequest = z.object({
  picks: z.array(JackpotGamePicksSchema).min(1).max(MAX_JACKPOT_GAMES),
});
export type JackpotEntryRequest = z.infer<typeof JackpotEntryRequest>;

/** One game of an entry: the game, the player's picks and whether they hit. */
export const JackpotEntryGameView = JackpotGameView.extend({
  picks: z.array(JackpotOutcomeSchema),
  /** null until the game has a result; true when a pick matches it (or the game was cancelled). */
  hit: z.boolean().nullable(),
});
export type JackpotEntryGameView = z.infer<typeof JackpotEntryGameView>;

export const JackpotEntryView = z.object({
  id: z.string(),
  roundId: z.string(),
  templateCode: JackpotTemplateCodeSchema,
  status: JackpotEntryStatusSchema,
  roundStatus: JackpotRoundStatusSchema,
  closesAt: z.string(),
  /** One array per game, in game order, each in '1', 'X', '2' order. */
  picks: z.array(z.array(JackpotOutcomeSchema)),
  combinations: z.number().int().min(1),
  /** combinations × the round's cost per combination. */
  cost: Santim,
  /**
   * Once settled (won or lost): index k is the number of the entry's
   * combinations with exactly k correct predictions (decimal strings).
   */
  correct: z.array(BigCount).nullable(),
  /** The most correct predictions of any of its combinations (won or lost). */
  bestCorrect: Count.nullable(),
  /** The prize before tax, the tax and what was paid; "0" when lost or void, null while open. */
  prizeGross: Santim.nullable(),
  prizeTax: Santim.nullable(),
  prizeNet: Santim.nullable(),
  /** The cost refunded when the round was void, else null. */
  refund: Santim.nullable(),
  placedAt: z.string(),
  settledAt: z.string().nullable(),
  games: z.array(JackpotEntryGameView),
});
export type JackpotEntryView = z.infer<typeof JackpotEntryView>;

/** GET /me/jackpot-entries: status open (round not settled yet) or settled; omitted = all. */
export const MyJackpotEntriesQuery = PageQuery.extend({
  status: z.enum(['open', 'settled']).optional(),
});
export type MyJackpotEntriesQuery = z.infer<typeof MyJackpotEntriesQuery>;

export const MyJackpotEntriesResponse = z.object({
  items: z.array(JackpotEntryView),
  nextCursor: z.string().nullable(),
});
export type MyJackpotEntriesResponse = z.infer<typeof MyJackpotEntriesResponse>;

/** Error codes of the jackpot endpoints (besides the usual 401 / 403 / 404 / 422 / 429). */
export const JackpotErrorCodeSchema = z.enum([
  /** 409: the round does not take entries (any more); details JackpotClosedDetails. */
  'jackpot_closed',
  /** 422: the picks do not fit the round; details JackpotEntryInvalidDetails. */
  'jackpot_entry_invalid',
]);
export type JackpotErrorCode = z.infer<typeof JackpotErrorCodeSchema>;

/**
 * Why a round refuses entries: not_open (scheduled, opens later); closed
 * (closed, settled or cancelled, or its closing time has come); game_started
 * (a game kicked off or was cancelled before the closing time).
 */
export const JackpotClosedReasonSchema = z.enum(['not_open', 'closed', 'game_started']);

/** details of 409 `jackpot_closed`. */
export const JackpotClosedDetails = z.object({
  reason: JackpotClosedReasonSchema,
  status: JackpotRoundStatusSchema,
});
export type JackpotClosedDetails = z.infer<typeof JackpotClosedDetails>;

/** details of 422 `jackpot_entry_invalid`: plain-English problems and the round's limits. */
export const JackpotEntryInvalidDetails = z.object({
  errors: z.array(z.string()),
  gameCount: z.number().int().nullable(),
  /** The entry's combinations (null when the picks could not be read). */
  combinations: z.number().int().nullable(),
  maxCombinations: z.number().int().nullable(),
});
export type JackpotEntryInvalidDetails = z.infer<typeof JackpotEntryInvalidDetails>;

/** One step of the accumulator bonus ladder. */
export const MultiBonusTierView = z.object({
  /** Qualifying legs (odds at least minLegOddsMilli) needed. */
  minLegs: z.number().int().min(1),
  /** Bonus on the winnings, in basis points (300 = 3%). */
  percentBps: z.number().int().min(0),
});
export type MultiBonusTierView = z.infer<typeof MultiBonusTierView>;

/** The accumulator ("multi") bonus ladder in force. */
export const MultiBonusView = z.object({
  /** false: no bonus at the moment. */
  enabled: z.boolean(),
  /** A leg counts toward the ladder only at these odds or more. */
  minLegOddsMilli: OddsMilli,
  /** The most bonus one bet can earn. */
  maxBonus: Santim,
  /** Ascending minLegs; the highest step reached applies. */
  tiers: z.array(MultiBonusTierView),
});
export type MultiBonusView = z.infer<typeof MultiBonusView>;

/** GET /promotions (public): the multi-bonus ladder and the open jackpots. */
export const PromotionsResponse = z.object({
  multiBonus: MultiBonusView,
  /** Rounds taking entries now, soonest closing first. */
  jackpots: z.array(JackpotRoundView),
});
export type PromotionsResponse = z.infer<typeof PromotionsResponse>;

/**
 * A jackpot template as the back office edits it (Phase 9 routes; the
 * services exist in @vamos/db: updateJackpotTemplate). New rounds use it;
 * rounds already open keep the terms they were opened with.
 */
export const JackpotTemplateView = z.object({
  code: JackpotTemplateCodeSchema,
  /** Whether new rounds of this template are opened. */
  enabled: z.boolean(),
  gameCount: z.number().int().min(1).max(MAX_JACKPOT_GAMES),
  costPerCombination: Santim,
  maxCombinations: z.number().int().min(1),
  cancelledRule: JackpotCancelledRuleSchema,
  /** Sorted by strictly descending `correct`; the first one is for every game correct. */
  prizeTiers: z.array(JackpotPrizeTierView).min(1),
});
export type JackpotTemplateView = z.infer<typeof JackpotTemplateView>;

/** Body of the back office's jackpot template update (Phase 9). */
export const UpdateJackpotTemplateRequest = JackpotTemplateView;
export type UpdateJackpotTemplateRequest = z.infer<typeof UpdateJackpotTemplateRequest>;

/** Body of the back office's multi-bonus ladder update (Phase 9; updateMultiBonusSettings). */
export const UpdateMultiBonusRequest = MultiBonusView;
export type UpdateMultiBonusRequest = z.infer<typeof UpdateMultiBonusRequest>;

/** Error code of the settings updates: 422, details { key, issues: string[] }. */
export const SettingsErrorCodeSchema = z.enum(['invalid_setting']);
