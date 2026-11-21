/**
 * Thresholds of the scraper rules (docs/scraper.md section 6). Starting
 * values, to be tuned in shadow mode; each rule cites them by name, so a
 * change here is a change to the rule.
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

// --- Fixtures ---------------------------------------------------------------

/** Fixtures further ahead than this are not created. */
export const FIXTURE_HORIZON_MS = 14 * DAY_MS;
/** A fixture must start at least this far ahead to be created or moved to. */
export const MIN_LEAD_MS = 10 * MINUTE_MS;
/** Kickoffs closer than this are the same time. */
export const KICKOFF_TOLERANCE_MS = 5 * MINUTE_MS;
/** Observations of the same pairing closer than this belong to one fixture. */
export const CLUSTER_WINDOW_MS = 36 * HOUR_MS;
/** A fixture can match an existing event whose start is within this distance. */
export const MATCH_WINDOW_MS = 45 * DAY_MS;
/** A single source may postpone a kickoff by at most this much, and only later, with no bets. */
export const SMALL_SHIFT_MS = 2 * HOUR_MS;
/** An event no source has listed for this long is flagged (never cancelled). */
export const MISSING_AFTER_MS = 48 * HOUR_MS;

// --- Results ----------------------------------------------------------------

/** No football result is accepted before kickoff plus this. */
export const MIN_MATCH_DURATION_MS = 105 * MINUTE_MS;
/** Independent upstreams that must agree before a result can be applied. A floor, not a setting. */
export const MIN_INDEPENDENT_SOURCES = 2;
/** How long an agreed result must stay unchanged before it is applied (config can raise it). */
export const DEFAULT_RESULT_CONFIRM_MS = 15 * MINUTE_MS;
/** The configured wait can never be shorter than this. */
export const MIN_RESULT_CONFIRM_MS = 5 * MINUTE_MS;
/** A lone final score older than this (after the earliest possible end) goes to a person. */
export const UNVERIFIED_AFTER_MS = 6 * HOUR_MS;

// --- Source health ----------------------------------------------------------

/** Successful runs the parse-yield baseline is taken from. */
export const SHAPE_BASELINE_RUNS = 5;
/** Fewer successful runs than this and there is no baseline yet (the source is "learning"). */
export const SHAPE_MIN_BASELINE_RUNS = 3;
/** Accepted records below this share of the baseline mark a page as broken. */
export const SHAPE_MIN_RATIO = 0.5;
/**
 * S5: a source that keeps answering but has shown nothing new since a match it lists ended, this
 * long after that match's earliest possible end, is "stale" (frozen or lagging) and a person is told.
 */
export const SOURCE_STALE_AFTER_MS = 48 * HOUR_MS;

// --- Kickoff safety (docs/scraper.md 6.1a, docs/scraper-plan/kickoff-safety.md) -----------

/** C2: a single fresh source can confirm a kickoff only this close to it (0 wrong opens at 72 h and 96 h). */
export const KICKOFF_CONFIRM_LEAD_MS = 72 * HOUR_MS;
/** C2: the confirming statement must have held its value this long (insurance against a source mid-edit). */
export const KICKOFF_STABLE_MS = 24 * HOUR_MS;
/** A statement about an event has a kickoff at most this far from the event's start (largest measured early move 4.9 days). */
export const KICKOFF_EVIDENCE_WINDOW_MS = 7 * DAY_MS;

// --- Odds -------------------------------------------------------------------

/** A team's ratings need at least this many matches behind them to price real bets. */
export const MIN_RATING_MATCHES = 8;
/** Total implied probability of a market that partitions the outcomes must lie in this range. */
export const OVERROUND_MIN = 1.01;
export const OVERROUND_MAX = 1.3;
/** A re-price may move a selection by at most this factor (either way) without a person. */
export const MAX_PRICE_MOVE_RATIO = 1.25;

// --- Market odds (docs/scraper.md 3.1, rule O5) ---------------------------------

/**
 * O5: bookmaker prices last listed by a fetch longer ago than this are not used to price (the
 * licensed feed is fetched far more often; an older price means the feed has stopped).
 */
export const MARKET_ODDS_MAX_AGE_MS = 3 * HOUR_MS;
/**
 * Prematch betting on an event of a market-priced competition closes at least this long before its
 * start time (events.close_lead_ms). The licensed feed's prices and statuses arrive a minute or
 * more late (TheRundown Starter: 60 s, plus the time between polls), so no bet may be struck up to a
 * kick-off the feed has not reported yet. Only ever raised, never lowered.
 */
export const MARKET_CLOSE_LEAD_MS = 5 * MINUTE_MS;
/** A price row is linked to the event of the same competition and teams that starts within this of its kickoff. */
export const MARKET_ODDS_LINK_WINDOW_MS = 6 * HOUR_MS;
/**
 * A competitor board's prices (Hulusport via mr-x, docs/plans/hulusport-feed.md) confirmed upstream
 * or read by us longer ago than this are not used: the event goes back to our own prices. mr-x
 * reads each match about every 7 minutes.
 */
export const BOARD_PRICES_MAX_AGE_MS = 30 * MINUTE_MS;

/**
 * How old Narobet's prices (mr-z, docs/plans/narobet-feed.md) may be for the pricing step, by the
 * time left to the kickoff: mr-z re-reads a match's markets every 10 minutes in its last 3 hours,
 * every 30 minutes in its last 24 hours and every 6 hours before that; each limit leaves slack for
 * one late read. Older prices are not used: the event goes back to our own prices.
 */
export const NAROBET_FRESHNESS_STEPS: ReadonlyArray<{ aheadMs: number; maxAgeMs: number }> = [
  { aheadMs: 3 * 60 * MINUTE_MS, maxAgeMs: 20 * MINUTE_MS },
  { aheadMs: 24 * 60 * MINUTE_MS, maxAgeMs: 45 * MINUTE_MS },
];
/** Beyond the last of NAROBET_FRESHNESS_STEPS. */
export const NAROBET_PRICES_MAX_AGE_FAR_MS = 7 * 60 * MINUTE_MS;

export function narobetPricesMaxAgeMs(kickoff: Date, now: Date): number {
  const ahead = kickoff.getTime() - now.getTime();
  for (const step of NAROBET_FRESHNESS_STEPS) {
    if (ahead <= step.aheadMs) return step.maxAgeMs;
  }
  return NAROBET_PRICES_MAX_AGE_FAR_MS;
}
/**
 * Narobet-only matches (docs/plans/narobet-events.md): at most this many new events per read of
 * mr-z, so the first fill of 30 days spreads over a few hours instead of landing at once.
 */
export const NAROBET_EVENTS_MAX_NEW_PER_READ = 100;
/**
 * A Narobet-only match gets the market factory's markets (about 500 options) only this close to its
 * kickoff; further out it has Narobet's own markets only (our server's load at 30 days ahead).
 */
export const NAROBET_FACTORY_WITHIN_MS = 72 * HOUR_MS;
/**
 * API-Football leagues never listed from Narobet, by the owner's decision D5 (21 Nov 2026): club
 * friendlies (667, "Friendlies Clubs"). National-team (10) and women's (666) friendlies stay.
 */
export const NAROBET_EXCLUDED_LEAGUE_IDS: ReadonlySet<number> = new Set([667]);
/**
 * A2: an event priced from the market that starts within MARKET_LAPSE_LEAD_MS stays bettable only
 * while the market prices it from prices listed in the last MARKET_LAPSE_MAX_AGE_MS; otherwise the
 * re-pricing pass suspends its markets (`market_lapsed`) until a fresh market prices it again.
 */
export const MARKET_LAPSE_LEAD_MS = 3 * HOUR_MS;
export const MARKET_LAPSE_MAX_AGE_MS = 30 * MINUTE_MS;
/**
 * O1m: a market-priced event may open betting without calibrated team ratings only when its 1X2
 * consensus has at least this many distinct bookmakers, one of them in SHARP_BOOKMAKERS.
 */
export const MARKET_OPEN_MIN_BOOKS = 3;
/** Bookmakers whose prices follow the sharp money (low margin, high limits, or an exchange). */
export const SHARP_BOOKMAKERS: readonly string[] = Object.freeze([
  'pinnacle',
  'betfair_ex_uk',
  'betfair_ex_eu',
  'betfair_ex_au',
  'smarkets',
  'matchbook',
]);

/**
 * How often a bookmaker-odds source is read, by its next kickoff (docs/theoddsapi-plan/README.md,
 * section 4.5): within 3 h, within 24 h, within 14 days, none. Each read of The Odds API is metered.
 */
export const MARKET_ODDS_TIER_LIMITS_MS = [3 * HOUR_MS, 24 * HOUR_MS, 14 * DAY_MS] as const;
export const MARKET_ODDS_INTERVALS_MS = {
  normal: [10 * MINUTE_MS, 30 * MINUTE_MS, 2 * HOUR_MS, 6 * HOUR_MS],
  economy: [15 * MINUTE_MS, 60 * MINUTE_MS, 150 * MINUTE_MS, 6 * HOUR_MS],
} as const;
/**
 * C-2 (docs/feed-quality-plan.md): the odds of a `standard` competition (not in
 * SCRAPER_PRIORITY_COMPETITIONS) are read at least this far apart in the same bands: 30 min,
 * 2 h, 170 min, 6 h. A floor on the guard's own interval, so the guard can only slow it further.
 */
export const MARKET_ODDS_STANDARD_INTERVALS_MS = [
  30 * MINUTE_MS,
  2 * HOUR_MS,
  // Not 6 h: within 14 days a standard league's prices must stay younger than
  // MARKET_ODDS_MAX_AGE_MS (3 h, rule O5), or its market-priced events fall back to the model.
  170 * MINUTE_MS,
  6 * HOUR_MS,
] as const;
/** Minimal mode reads only leagues with a kickoff within 3 h, this often. */
export const MARKET_ODDS_MINIMAL_INTERVAL_MS = 30 * MINUTE_MS;

/**
 * A metered result source (The Odds API's /scores, 2 credits a read) reads its league only from
 * kickoff + METERED_RESULTS_WINDOW_START_MS to kickoff + METERED_RESULTS_WINDOW_END_MS of one of
 * the league's unresulted matches, this often per credit-guard mode; never otherwise (stop: never).
 * A match ends about 110 minutes after kickoff; once resulted it leaves the window at once.
 */
export const METERED_RESULTS_WINDOW_START_MS = 110 * MINUTE_MS;
export const METERED_RESULTS_WINDOW_END_MS = 4 * HOUR_MS;
export const METERED_RESULTS_INTERVALS_MS = {
  normal: 20 * MINUTE_MS,
  economy: 30 * MINUTE_MS,
  minimal: 60 * MINUTE_MS,
} as const;
