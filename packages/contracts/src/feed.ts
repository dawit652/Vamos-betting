import { z } from 'zod';
import type { StaffPermission } from './admin';
import { Id, IsoDateTime, OddsMilli, Santim } from './common';

/**
 * The back-office feed API (`/admin/feed/*`, docs/scraper.md section 8): the
 * health of the data scraper's sources, the review queue of things a person
 * has to look at, name aliases and the kill switches. Same wire conventions
 * and staff session as the rest of `/admin/*` (santim as decimal strings,
 * timestamps as ISO-8601). Each route needs the permission below (401 without
 * a staff session, 403 without the permission); existing permissions only.
 *
 * Two routes are guarded more finely than this table can say; the API checks
 * the finer permission from the request body with the helpers below:
 * - `POST /admin/feed/review/:id/resolve` needs `trading.status`, or
 *   `trading.result` when the decision is `apply_result`, or `trading.odds`
 *   when it is `apply_reprice` (`resolveReviewPermission`).
 * - `PUT /admin/feed/competitions/:id` is listed with its strictest permission,
 *   `settings.edit`; a request that only turns flags off needs just
 *   `trading.status` (`competitionPolicyPermission`).
 */
export const FEED_ROUTE_PERMISSIONS = {
  'GET /admin/feed/health': 'trading.view',
  'GET /admin/feed/review': 'trading.view',
  'GET /admin/feed/review/:id': 'trading.view',
  'POST /admin/feed/review/:id/resolve': 'trading.status',
  'GET /admin/feed/aliases': 'trading.view',
  'POST /admin/feed/aliases': 'trading.status',
  'DELETE /admin/feed/aliases/:id': 'trading.status',
  'PUT /admin/feed/sources/:id': 'trading.status',
  'GET /admin/feed/competitions': 'trading.view',
  'PUT /admin/feed/competitions/:id': 'settings.edit',
} as const satisfies Record<string, StaffPermission>;
export type FeedRoute = keyof typeof FEED_ROUTE_PERMISSIONS;

// ---------------------------------------------------------------------------
// Closed sets. These mirror packages/core/src/scrape.ts (this package does not
// depend on @vamos/core); a drift test in the API package compares them.

export const FEED_SPORTS = ['football'] as const;
export const FEED_ADAPTERS = [
  'openfootball',
  'generic-json',
  'generic-html',
  'therundown',
] as const;
export const FEED_DATA_CLASSES = ['fixtures', 'results'] as const;
export const FEED_FIXTURE_STATUSES = ['scheduled', 'postponed', 'cancelled'] as const;
export const FEED_RESULT_STATUSES = ['finished', 'cancelled', 'abandoned', 'postponed'] as const;
export const FEED_SCORE_BASES = ['regular_time', 'includes_extra_time', 'unknown'] as const;
export const FEED_RUN_STATUSES = [
  'running',
  'ok',
  'failed',
  'broken',
  'blocked',
  'skipped',
] as const;
export const FEED_REVIEW_KINDS = [
  'unknown_team',
  'unknown_competition',
  'fixture_conflict',
  'kickoff_change',
  'fixture_missing',
  'cancellation_proposed',
  'ratings_uncalibrated',
  'odds_approval',
  'result_ready',
  'result_unverified',
  'result_conflict',
  'result_correction',
  'score_basis_unknown',
  'result_overdue',
  'source_broken',
  'source_stale',
] as const;
export const FEED_REVIEW_STATUSES = ['open', 'resolved', 'dismissed'] as const;
export const FEED_SEVERITIES = ['info', 'warning', 'critical'] as const;

export const FeedSportSchema = z.enum(FEED_SPORTS);
export const FeedAdapterSchema = z.enum(FEED_ADAPTERS);
export const FeedDataClassSchema = z.enum(FEED_DATA_CLASSES);
export const FeedFixtureStatusSchema = z.enum(FEED_FIXTURE_STATUSES);
export const FeedResultStatusSchema = z.enum(FEED_RESULT_STATUSES);
export const FeedScoreBasisSchema = z.enum(FEED_SCORE_BASES);
export const FeedRunStatusSchema = z.enum(FEED_RUN_STATUSES);
export const FeedReviewKindSchema = z.enum(FEED_REVIEW_KINDS);
export const FeedReviewStatusSchema = z.enum(FEED_REVIEW_STATUSES);
export const FeedSeveritySchema = z.enum(FEED_SEVERITIES);

export type FeedSport = z.infer<typeof FeedSportSchema>;
export type FeedAdapter = z.infer<typeof FeedAdapterSchema>;
export type FeedDataClass = z.infer<typeof FeedDataClassSchema>;
export type FeedFixtureStatus = z.infer<typeof FeedFixtureStatusSchema>;
export type FeedResultStatus = z.infer<typeof FeedResultStatusSchema>;
export type FeedScoreBasis = z.infer<typeof FeedScoreBasisSchema>;
export type FeedRunStatus = z.infer<typeof FeedRunStatusSchema>;
export type FeedReviewKind = z.infer<typeof FeedReviewKindSchema>;
export type FeedReviewStatus = z.infer<typeof FeedReviewStatusSchema>;
export type FeedSeverity = z.infer<typeof FeedSeveritySchema>;

// ---------------------------------------------------------------------------
// Shared pieces.

const Count = z.number().int().min(0);
const Cursor = z.string().min(1).max(200).optional();

/** A note a person writes with a decision (audited). */
const Note = z.string().trim().min(1).max(2000);

/** A team or competition name as a source writes it: no control characters (as in the scraper). */
// eslint-disable-next-line no-control-regex
const NO_CONTROL_CHARS = /^[^\u0000-\u001f\u007f]*$/;
const RawName = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(NO_CONTROL_CHARS, 'control characters are not allowed');

function page<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}

/** `status=open,resolved` or repeated `status=open&status=resolved`. */
function queryList<T extends z.ZodType>(item: T) {
  return z.preprocess(
    (value) =>
      typeof value === 'string'
        ? value
            .split(',')
            .map((part) => part.trim())
            .filter((part) => part.length > 0)
        : value,
    z.array(item).max(20),
  );
}

/** A football score; the half-time score is both sides or neither. */
const Points = z.number().int().min(0).max(99);
export const FeedScoreView = z.object({
  home: Points,
  away: Points,
  htHome: Points.nullable(),
  htAway: Points.nullable(),
});
export type FeedScoreView = z.infer<typeof FeedScoreView>;

// ---------------------------------------------------------------------------
// Source health (GET /admin/feed/health, PUT /admin/feed/sources/:id).

/**
 * ok: last run fine and recent. stale: no successful run for too long.
 * broken: the last run's shape check failed (nothing stored). blocked:
 * robots.txt, a block page or a rate limit (we back off). disabled: switched
 * off by a person. learning: too few successful runs for a baseline yet.
 */
export const FEED_SOURCE_STATES = [
  'ok',
  'stale',
  'broken',
  'blocked',
  'disabled',
  'learning',
] as const;
export const FeedSourceStateSchema = z.enum(FEED_SOURCE_STATES);
export type FeedSourceState = z.infer<typeof FeedSourceStateSchema>;

export const SourceLastRunView = z.object({
  status: FeedRunStatusSchema,
  startedAt: IsoDateTime,
  /** Null while the run is still `running`. */
  finishedAt: IsoDateTime.nullable(),
  recordsSeen: Count,
  recordsAccepted: Count,
});
export type SourceLastRunView = z.infer<typeof SourceLastRunView>;

export const SourceHealthView = z.object({
  id: z.string(),
  name: z.string(),
  adapter: FeedAdapterSchema,
  /** Who produces the data; sources sharing an upstream count once in a consensus. */
  upstream: z.string(),
  enabled: z.boolean(),
  /** Null when the source has never run. */
  lastRun: SourceLastRunView.nullable(),
  lastOkAt: IsoDateTime.nullable(),
  /** Runs in a row that ended failed, broken or blocked. */
  consecutiveFailures: Count,
  openReviewItems: Count,
  state: FeedSourceStateSchema,
});
export type SourceHealthView = z.infer<typeof SourceHealthView>;

/** GET /admin/feed/health. `queue.byKind` has a count (0 or more) for every review kind. */
export const FeedHealthResponse = z.object({
  sources: z.array(SourceHealthView),
  queue: z.object({
    /** Open review items in total. */
    open: Count,
    byKind: z.record(FeedReviewKindSchema, Count),
  }),
  competitions: z.object({
    total: Count,
    enabled: Count,
    autoOpen: Count,
    autoResults: Count,
  }),
  generatedAt: IsoDateTime,
});
export type FeedHealthResponse = z.infer<typeof FeedHealthResponse>;

/**
 * PUT /admin/feed/sources/:id: the kill switch of one source (audited).
 * Disabling stops the scraper at once; 404 for an unknown source.
 */
export const SetSourceEnabledRequest = z.strictObject({ enabled: z.boolean() });
export type SetSourceEnabledRequest = z.infer<typeof SetSourceEnabledRequest>;

export const SetSourceEnabledResponse = z.object({ source: SourceHealthView });
export type SetSourceEnabledResponse = z.infer<typeof SetSourceEnabledResponse>;

// ---------------------------------------------------------------------------
// Competition policy (GET /admin/feed/competitions, PUT /admin/feed/competitions/:id).

/** Where a competition's prices come from: the team-rating model (default) or a licensed bookmaker-odds feed first. */
export const FEED_PRICING_SOURCES = ['model', 'market'] as const;
export const FeedPricingSourceSchema = z.enum(FEED_PRICING_SOURCES);
export type FeedPricingSource = z.infer<typeof FeedPricingSourceSchema>;

export const CompetitionPolicyView = z.object({
  competitionId: z.string(),
  name: z.string(),
  sport: z.string(),
  /** The scraper may create fixtures in this competition. */
  enabled: z.boolean(),
  /** New fixtures with calibrated teams open for betting by themselves. */
  autoOpen: z.boolean(),
  /** Confirmed final scores are applied without a person. */
  autoResults: z.boolean(),
  /** Matches can go to extra time or penalties (knockouts). */
  extraTime: z.boolean(),
  /**
   * Where prices come from: 'model' (team ratings, the default) or 'market' (a licensed
   * bookmaker-odds feed first, the model as fallback).
   */
  pricingSource: FeedPricingSourceSchema,
  /** Null while the competition has no policy row yet (everything off). */
  updatedAt: IsoDateTime.nullable(),
  updatedBy: z.string().nullable(),
});
export type CompetitionPolicyView = z.infer<typeof CompetitionPolicyView>;

export const FeedCompetitionsResponse = z.object({ items: z.array(CompetitionPolicyView) });
export type FeedCompetitionsResponse = z.infer<typeof FeedCompetitionsResponse>;

const POLICY_FLAGS = ['enabled', 'autoOpen', 'autoResults', 'extraTime', 'pricingSource'] as const;
/** The flags whose switching off is a safety action (it only makes the scraper do less). */
const POLICY_SAFETY_FLAGS = ['enabled', 'autoOpen', 'autoResults'] as const;

/** PUT /admin/feed/competitions/:id: the flags to change; at least one, no others (audited). */
export const UpdateCompetitionPolicyRequest = z
  .strictObject({
    enabled: z.boolean().optional(),
    autoOpen: z.boolean().optional(),
    autoResults: z.boolean().optional(),
    extraTime: z.boolean().optional(),
    pricingSource: FeedPricingSourceSchema.optional(),
  })
  .refine((request) => POLICY_FLAGS.some((flag) => request[flag] !== undefined), {
    message: 'at least one flag must be given',
  });
export type UpdateCompetitionPolicyRequest = z.infer<typeof UpdateCompetitionPolicyRequest>;

export const UpdateCompetitionPolicyResponse = z.object({ competition: CompetitionPolicyView });
export type UpdateCompetitionPolicyResponse = z.infer<typeof UpdateCompetitionPolicyResponse>;

/**
 * The permission a policy change needs: `trading.status` when it only turns
 * `enabled`, `autoOpen` or `autoResults` off, or sets `pricingSource` back to
 * 'model' (traders' safety actions: the scraper does less, or falls back to the
 * model), `settings.edit` for anything else (turning something on, `extraTime`,
 * or switching to 'market').
 */
export function competitionPolicyPermission(
  request: UpdateCompetitionPolicyRequest,
): 'trading.status' | 'settings.edit' {
  const givenFlags = POLICY_FLAGS.filter((flag) => request[flag] !== undefined);
  const onlyTurnsOff = givenFlags.every((flag) =>
    flag === 'pricingSource'
      ? request.pricingSource === 'model'
      : (POLICY_SAFETY_FLAGS as readonly string[]).includes(flag) && request[flag] === false,
  );
  return givenFlags.length > 0 && onlyTurnsOff ? 'trading.status' : 'settings.edit';
}

// ---------------------------------------------------------------------------
// Aliases (GET / POST / DELETE /admin/feed/aliases).

export const FEED_ALIAS_KINDS = ['team', 'competition'] as const;
export const FeedAliasKindSchema = z.enum(FEED_ALIAS_KINDS);
export type FeedAliasKind = z.infer<typeof FeedAliasKindSchema>;

export const AliasView = z.object({
  id: z.string(),
  kind: FeedAliasKindSchema,
  sport: FeedSportSchema,
  /** The name as it was entered. */
  raw: z.string(),
  /** The normalised form that is matched (rule N1). */
  normalized: z.string(),
  /** The team or competition id. */
  targetId: z.string(),
  targetName: z.string(),
  /** Null: the alias holds for every source. */
  sourceId: z.string().nullable(),
  createdAt: IsoDateTime,
  createdBy: z.string(),
});
export type AliasView = z.infer<typeof AliasView>;

/** GET /admin/feed/aliases: newest first; `cursor` is the last alias's id. */
export const AliasListQuery = z.object({
  kind: FeedAliasKindSchema.optional(),
  sport: FeedSportSchema.optional(),
  sourceId: Id.optional(),
  /** Matches the raw name or the normalised name. */
  q: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: Cursor,
});
export type AliasListQuery = z.infer<typeof AliasListQuery>;

export const AliasListResponse = page(AliasView);
export type AliasListResponse = z.infer<typeof AliasListResponse>;

/**
 * POST /admin/feed/aliases (audited): maps a raw name to a team or competition,
 * for every source or for one. 404 for an unknown target or source; 409
 * `alias_conflict` when the name already maps to another target.
 */
export const CreateAliasRequest = z.strictObject({
  kind: FeedAliasKindSchema,
  sport: FeedSportSchema.default('football'),
  raw: RawName,
  targetId: Id,
  sourceId: Id.optional(),
});
export type CreateAliasRequest = z.infer<typeof CreateAliasRequest>;

/** `created: false` when the same alias already existed. */
export const CreateAliasResponse = z.object({ alias: AliasView, created: z.boolean() });
export type CreateAliasResponse = z.infer<typeof CreateAliasResponse>;

/**
 * DELETE /admin/feed/aliases/:id (audited): removes one alias, team or
 * competition (the id says which). 404 for an unknown id. Observations keep
 * the target they resolved to until the scraper's next promotion pass
 * re-resolves them, so the route only removes.
 */
export const RemoveAliasResponse = z.object({ removed: AliasView });
export type RemoveAliasResponse = z.infer<typeof RemoveAliasResponse>;

// ---------------------------------------------------------------------------
// Review queue payloads. Each kind's `payload` has the shape below; the wire
// type of a payload is an object, and the UI reads it with parseReviewPayload.

const Suggestion = z.object({ id: z.string(), name: z.string(), score: z.number().min(0).max(1) });

/** A source that supports an observation: when its observation took its current value. */
const SourceVote = z.object({ sourceId: z.string(), upstream: z.string(), changedAt: IsoDateTime });

/** Open bets on an event and what is staked on them (rule R9). */
const Exposure = z.object({ openBets: Count, totalStake: Santim });

const EventRef = {
  eventId: z.string(),
  /** The human-facing game number of the event. */
  gameId: z.string(),
  home: z.string(),
  away: z.string(),
  kickoff: IsoDateTime,
};

/** What one source said about the final result. */
const ResultObservationView = z.object({
  sourceId: z.string(),
  upstream: z.string(),
  status: FeedResultStatusSchema,
  /** Null unless the status is `finished`. */
  score: FeedScoreView.nullable(),
  scoreBasis: FeedScoreBasisSchema,
  changedAt: IsoDateTime,
});

/**
 * The suffix of the subject key of a re-price item (rule O3): an `odds_approval`
 * item whose subject ends in it asks a trader to apply new prices to an event
 * that already has some, as opposed to opening betting. A drift test in the API
 * compares it with the scraper's REPRICE_SUBJECT_SUFFIX.
 */
export const FEED_REPRICE_SUBJECT_SUFFIX = '|reprice';

/** True for the `odds_approval` items that propose a re-price (`apply_reprice` applies them). */
export function isRepriceItem(item: { kind: string; subjectKey: string }): boolean {
  return item.kind === 'odds_approval' && item.subjectKey.endsWith(FEED_REPRICE_SUBJECT_SUFFIX);
}

/** A priced book as the scraper stores it in a re-price item: markets by type and line, selections by code. */
export const RepriceProposal = z.array(
  z.object({
    type: z.string().min(1),
    line: z.string().nullable(),
    selections: z.array(z.object({ code: z.string().min(1), oddsMilli: OddsMilli })),
  }),
);
export type RepriceProposal = z.infer<typeof RepriceProposal>;

const OddsReviewPayload = z.object({
  ...EventRef,
  /** Why a person is asked (e.g. which team has too few rated matches, or which price moved too far). */
  reason: z.string().nullable(),
  /** The proposed markets, when prices exist (a proposal; nothing is stored or open yet). */
  markets: z.array(
    z.object({
      market: z.string(),
      selections: z.array(
        z.object({
          name: z.string(),
          oddsMilli: OddsMilli,
          /** The price currently stored, when a re-price is proposed. */
          previousOddsMilli: OddsMilli.optional(),
        }),
      ),
    }),
  ),
  /**
   * Re-price items only (subject ends in FEED_REPRICE_SUBJECT_SUFFIX): the
   * exact book `apply_reprice` applies, and the fingerprint it was priced from:
   * the team ratings, or for market prices the bookmaker consensus (its key
   * starts with "mkt1"). The decision is refused when that moved since (for a
   * market proposal: when the scraper has made or applied a newer one).
   */
  proposal: RepriceProposal.optional(),
  ratingsKey: z.string().optional(),
  /**
   * Where the prices of the proposal or the hand-over come from (rule O5): the
   * team-rating model, or the consensus of `books` bookmakers of a licensed feed
   * (`residual`: how well the goals model fits it). `fallback` says why the
   * market could not be used when the competition asked for it.
   */
  pricing: z
    .object({
      source: z.enum(['market', 'model']),
      books: Count.optional(),
      residual: z.number().min(0).max(1).optional(),
      fallback: z.enum(['no_consensus', 'poor_fit']).optional(),
    })
    .optional(),
});

const ResultReviewPayload = z.object({
  ...EventRef,
  /** The score the item proposes; resolving applies exactly this one. */
  score: FeedScoreView,
  sources: z.array(SourceVote),
  exposure: Exposure,
});

const ResultDisputePayload = z.object({
  ...EventRef,
  /** The score the event was resulted with (`result_correction`); null for `result_conflict`. */
  appliedScore: FeedScoreView.nullable(),
  observations: z.array(ResultObservationView),
  exposure: Exposure.optional(),
});

const GenericPayload = z.object({ detail: z.string() });

export const REVIEW_PAYLOAD_SCHEMAS = {
  unknown_team: z.object({
    sport: FeedSportSchema.default('football'),
    /** The name as the source wrote it. */
    raw: z.string(),
    /** The competition label of the fixture, as the source wrote it. */
    competition: z.string(),
    sourceId: z.string(),
    /** Up to a few catalogue teams that look alike; suggestions are never applied. */
    suggestions: z.array(Suggestion),
  }),
  unknown_competition: z.object({
    sport: FeedSportSchema.default('football'),
    raw: z.string(),
    sourceId: z.string(),
    suggestions: z.array(Suggestion),
  }),
  fixture_conflict: GenericPayload,
  kickoff_change: z.object({
    eventId: z.string(),
    currentKickoff: IsoDateTime,
    proposedKickoff: IsoDateTime,
    sources: z.array(SourceVote),
    hasBets: z.boolean(),
  }),
  fixture_missing: GenericPayload,
  cancellation_proposed: GenericPayload,
  ratings_uncalibrated: OddsReviewPayload,
  odds_approval: OddsReviewPayload,
  result_ready: ResultReviewPayload,
  result_unverified: ResultReviewPayload,
  result_conflict: ResultDisputePayload,
  result_correction: ResultDisputePayload,
  score_basis_unknown: GenericPayload,
  result_overdue: z.object({
    ...EventRef,
    /** Whole hours between kickoff and the moment the item was raised or last refreshed. */
    hoursSinceKickoff: Count,
    exposure: Exposure,
  }),
  source_broken: z.object({
    sourceId: z.string(),
    runId: z.string(),
    reason: z.string(),
    /** Records the broken run yielded. */
    recordsAccepted: Count,
    /** The median yield of the source's recent healthy runs (null when there is none). */
    baseline: z.number().min(0).nullable(),
  }),
  source_stale: z.object({
    sourceId: z.string(),
    sourceName: z.string(),
    /** When anything the source shows last changed. */
    lastChangedAt: IsoDateTime,
    /** Whole hours since then, when the item was raised or last refreshed. */
    hoursUnchanged: Count,
    /** Matches it lists that ended since then with no result from it. */
    dueMatches: Count,
  }),
} as const satisfies Record<FeedReviewKind, z.ZodType>;

/** The typed payload of each review kind. */
export type ReviewPayloadByKind = {
  [K in FeedReviewKind]: z.infer<(typeof REVIEW_PAYLOAD_SCHEMAS)[K]>;
};

/** The payload of a review item as its kind's type, or null when it does not have that shape. */
export function parseReviewPayload<K extends FeedReviewKind>(
  kind: K,
  payload: unknown,
): ReviewPayloadByKind[K] | null {
  const result = REVIEW_PAYLOAD_SCHEMAS[kind].safeParse(payload);
  return result.success ? (result.data as ReviewPayloadByKind[K]) : null;
}

// ---------------------------------------------------------------------------
// Review queue (GET /admin/feed/review, GET /admin/feed/review/:id, POST …/resolve).

export const ReviewItemView = z.object({
  id: z.string(),
  kind: FeedReviewKindSchema,
  /** What the item is about (the fixture key, the raw name, the source id); one open item per kind and subject. */
  subjectKey: z.string(),
  status: FeedReviewStatusSchema,
  severity: FeedSeveritySchema,
  title: z.string(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** Shaped by `kind`: see ReviewPayloadByKind and parseReviewPayload. */
  payload: z.record(z.string(), z.unknown()),
  /** How it was closed ({ decision, note, … }); null while open. */
  resolution: z.record(z.string(), z.unknown()).nullable(),
  /** A staff id, or `system:scraper` when the scraper closed it itself. */
  resolvedBy: z.string().nullable(),
  resolvedAt: IsoDateTime.nullable(),
});
export type ReviewItemView = z.infer<typeof ReviewItemView>;

/**
 * GET /admin/feed/review: newest first; `cursor` is opaque (the previous
 * `nextCursor`). A missing `status` or `kind` filter means every one.
 */
export const ReviewListQuery = z.object({
  status: queryList(FeedReviewStatusSchema).optional(),
  kind: queryList(FeedReviewKindSchema).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: Cursor,
});
export type ReviewListQuery = z.infer<typeof ReviewListQuery>;

export const ReviewListResponse = page(ReviewItemView);
export type ReviewListResponse = z.infer<typeof ReviewListResponse>;

/** GET /admin/feed/review/:id. */
export const ReviewDetailResponse = z.object({ item: ReviewItemView });
export type ReviewDetailResponse = z.infer<typeof ReviewDetailResponse>;

/**
 * POST /admin/feed/review/:id/resolve (audited). Every decision is checked by
 * the server against the item's kind (`FEED_RESOLVE_DECISION_KINDS`; 422
 * `decision_not_allowed`) and its state (409 `review_closed`).
 *
 * - dismiss: close without acting; any kind; the note says why.
 * - map_alias: unknown_team / unknown_competition: map the raw name to
 *   `targetId` (for `sourceId` only, or every source).
 * - open_betting: odds_approval: open betting on the event at the prices it proposes.
 * - apply_result: result_ready / result_unverified: apply the score the item
 *   proposes. The request carries no score: the server applies the one in the
 *   item's payload, so a client cannot invent one.
 * - apply_kickoff: kickoff_change: move the event to the proposed kickoff.
 * - apply_reprice: odds_approval items that propose a re-price (rule O3, see
 *   `isRepriceItem`): set the prices the item proposes on the event. The
 *   request carries no price: the server applies the proposal stored in the
 *   item, after checking again that the event is scheduled, not about to
 *   start, and that the ratings it was priced from still hold.
 */
export const ResolveReviewRequest = z.discriminatedUnion('decision', [
  z.strictObject({ decision: z.literal('dismiss'), note: Note }),
  z.strictObject({ decision: z.literal('map_alias'), targetId: Id, sourceId: Id.optional() }),
  z.strictObject({ decision: z.literal('open_betting') }),
  z.strictObject({ decision: z.literal('apply_result'), note: Note.optional() }),
  z.strictObject({ decision: z.literal('apply_kickoff') }),
  z.strictObject({ decision: z.literal('apply_reprice') }),
]);
export type ResolveReviewRequest = z.infer<typeof ResolveReviewRequest>;

export const FEED_RESOLVE_DECISIONS = [
  'dismiss',
  'map_alias',
  'open_betting',
  'apply_result',
  'apply_kickoff',
  'apply_reprice',
] as const;
export type FeedResolveDecision = (typeof FEED_RESOLVE_DECISIONS)[number];

/** The review kinds each decision may be used on (`dismiss`: all). */
export const FEED_RESOLVE_DECISION_KINDS = {
  dismiss: FEED_REVIEW_KINDS,
  map_alias: ['unknown_team', 'unknown_competition'],
  open_betting: ['odds_approval'],
  apply_result: ['result_ready', 'result_unverified'],
  apply_kickoff: ['kickoff_change'],
  // Only the odds_approval items of a re-price (isRepriceItem); the route checks the subject.
  apply_reprice: ['odds_approval'],
} as const satisfies Record<FeedResolveDecision, readonly FeedReviewKind[]>;

/**
 * The permission each decision needs; applying a result is `trading.result`,
 * applying prices is `trading.odds`, the rest `trading.status`.
 */
export const FEED_RESOLVE_DECISION_PERMISSIONS = {
  dismiss: 'trading.status',
  map_alias: 'trading.status',
  open_betting: 'trading.status',
  apply_result: 'trading.result',
  apply_kickoff: 'trading.status',
  apply_reprice: 'trading.odds',
} as const satisfies Record<FeedResolveDecision, StaffPermission>;

export function resolveReviewPermission(
  request: Pick<ResolveReviewRequest, 'decision'>,
): StaffPermission {
  return FEED_RESOLVE_DECISION_PERMISSIONS[request.decision];
}

/** `changed: false` when the item was already closed with the same decision. */
export const ResolveReviewResponse = z.object({ item: ReviewItemView, changed: z.boolean() });
export type ResolveReviewResponse = z.infer<typeof ResolveReviewResponse>;
