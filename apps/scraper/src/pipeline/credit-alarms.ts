import type { OwnerAlertsConfig } from '@vamos/config';
import type { OutOfLineSelection, OwnerAlertInput } from '@vamos/core';
import {
  closeReviewItemsBySubject,
  enqueueOwnerAlert,
  openReviewItem,
  type DbTransaction,
} from '@vamos/db';
import { scrapeReviewItems } from '@vamos/db/schema';
import { and, eq } from 'drizzle-orm';
import {
  rateLimitLow,
  type CreditProjection,
  type CreditStatus,
  type RateLimitReading,
} from '@vamos/scraper';

/**
 * The alarms of a metered odds API (docs/theoddsapi-plan/README.md, section 4.8). Each is a
 * `source_broken` review item (the kind accepts any reason) with its own subject key, so at most
 * one is open per key and cause, and opening it again only refreshes it:
 *
 * | reason             | opens when                                  | resolves when               |
 * | budget_low         | the key's guard is in economy or minimal    | the guard is normal again   |
 * | budget_exhausted   | the guard stops (the key not refused)       | credits are back (the 1st)  |
 * | budget_projection  | the guard is normal, but the last 24 h of spending would outrun the remaining credits before the 1st | the projection fits |
 * | unauthorized       | an answer refused the key (401)             | a read succeeds             |
 * | unexpected_cost    | a request cost more than expected (G3)      | a person dismisses it       |
 * | market_stale       | a market-priced match within 24 h kept old prices | fresh prices arrive   |
 * | odds_out_of_line   | a selection is priced above the best book price (O7) | none is any more     |
 * | rate_limit_low     | a daily-limited API left under 10% of today's requests | a reading above it |
 *
 * The first five also tell the owner (plan task 1.11): when `ref.alerts` has an owner number, the
 * transaction that opens the item, or changes its reason (budget_low to budget_exhausted share one
 * item), writes an `owner.alert` outbox row; a refresh that changes nothing does not. market_stale
 * and odds_out_of_line are per match and do not.
 */

export type CreditAlarmReason =
  | 'rate_limit_low'
  | 'budget_low'
  | 'budget_exhausted'
  | 'budget_projection'
  | 'unauthorized'
  | 'unexpected_cost'
  | 'market_stale'
  | 'odds_out_of_line';

/** The key, the source and the run an alarm points at. */
export interface AlarmRef {
  creditKey: string;
  sourceId: string;
  runId: string;
  now: Date;
  /** The owner's alert settings (config.ownerAlerts): without a number no alert is written. */
  alerts?: Pick<OwnerAlertsConfig, 'phones'>;
}

export const creditAlarmSubject = (
  creditKey: string,
  cause: 'budget' | 'projection' | 'unauthorized' | 'unexpected_cost' | 'rate_limit',
): string => `credits|${creditKey}|${cause}`;

export const marketStaleSubject = (eventId: string): string => `market_stale|${eventId}`;

/** The subject of an event's odds_out_of_line alarm (rule O7). */
export const OUT_OF_LINE_SUBJECT_PREFIX = 'odds_out_of_line|';
export const outOfLineSubject = (eventId: string): string =>
  `${OUT_OF_LINE_SUBJECT_PREFIX}${eventId}`;

/** The reason of the open source_broken item of `subjectKey`, or null when none is open. */
async function openReason(tx: DbTransaction, subjectKey: string): Promise<string | null> {
  const [row] = await tx
    .select({ payload: scrapeReviewItems.payload })
    .from(scrapeReviewItems)
    .where(
      and(
        eq(scrapeReviewItems.kind, 'source_broken'),
        eq(scrapeReviewItems.subjectKey, subjectKey),
        eq(scrapeReviewItems.status, 'open'),
      ),
    )
    .limit(1);
  const reason = (row?.payload as { reason?: unknown } | undefined)?.reason;
  return typeof reason === 'string' ? reason : null;
}

async function raise(
  tx: DbTransaction,
  ref: AlarmRef,
  subjectKey: string,
  reason: CreditAlarmReason,
  severity: 'info' | 'warning' | 'critical',
  title: string,
  extra: Record<string, unknown>,
  alert?: OwnerAlertInput,
): Promise<void> {
  const owner = ref.alerts !== undefined && ref.alerts.phones.length > 0 ? ref.alerts : undefined;
  const before =
    owner !== undefined && alert !== undefined ? await openReason(tx, subjectKey) : null;
  const { created } = await openReviewItem(tx, {
    kind: 'source_broken',
    subjectKey,
    severity,
    title,
    // sourceId, runId, reason, recordsAccepted and baseline are the contract's source_broken fields.
    payload: {
      sourceId: ref.sourceId,
      runId: ref.runId,
      reason,
      recordsAccepted: 0,
      baseline: null,
      creditKey: ref.creditKey,
      ...extra,
    },
    now: ref.now,
  });
  // Once per episode, and again when it gets worse: refreshing the open item every pass is not news.
  if (owner !== undefined && alert !== undefined && (created || before !== reason)) {
    await enqueueOwnerAlert(tx, owner, alert, ref.now);
  }
}

/**
 * budget_low while the guard is in economy or minimal, budget_exhausted while it stops for
 * credits; resolved when it is normal again. A stop for a refused key is the unauthorized alarm's.
 */
export async function syncBudgetAlarm(
  tx: DbTransaction,
  ref: Omit<AlarmRef, 'runId'> & { runId: string | null },
  status: CreditStatus,
): Promise<void> {
  const subjectKey = creditAlarmSubject(ref.creditKey, 'budget');
  const figures = {
    mode: status.mode,
    remaining: status.remaining,
    quota: status.quota,
    spentLast24h: status.spentLast24h,
  };
  if ((status.mode === 'economy' || status.mode === 'minimal') && ref.runId !== null) {
    await raise(
      tx,
      { ...ref, runId: ref.runId },
      subjectKey,
      'budget_low',
      'warning',
      'Bookmaker odds credits are running low: reading less often',
      figures,
      { alarm: 'budget_low', creditKey: ref.creditKey },
    );
    return;
  }
  if (status.mode === 'stop' && !status.keyRefused && ref.runId !== null) {
    await raise(
      tx,
      { ...ref, runId: ref.runId },
      subjectKey,
      'budget_exhausted',
      'critical',
      'Bookmaker odds credits are used up: no reads until the 1st',
      figures,
      { alarm: 'budget_exhausted', creditKey: ref.creditKey },
    );
    return;
  }
  if (status.mode === 'normal') {
    await closeReviewItemsBySubject(tx, subjectKey, {
      kinds: ['source_broken'],
      resolution: 'the credit guard is normal again',
      now: ref.now,
    });
  }
}

/**
 * rate_limit_low (task A3): a daily-limited API's latest answer left under 10% of the day's
 * requests (`rateLimitLow`); resolved by the first reading above it (after midnight UTC at the
 * latest). Tells the owner once per episode.
 */
export async function syncRateLimitAlarm(
  tx: DbTransaction,
  ref: AlarmRef,
  reading: RateLimitReading,
): Promise<void> {
  const subjectKey = creditAlarmSubject(ref.creditKey, 'rate_limit');
  if (!rateLimitLow(reading)) {
    await closeReviewItemsBySubject(tx, subjectKey, {
      kinds: ['source_broken'],
      resolution: 'more than 10% of the daily requests are left',
      now: ref.now,
    });
    return;
  }
  await raise(
    tx,
    ref,
    subjectKey,
    'rate_limit_low',
    'warning',
    `The daily request limit is nearly used: ${reading.remaining} of ${reading.limit} left today`,
    { limit: reading.limit, remaining: reading.remaining },
    {
      alarm: 'rate_limit_low',
      creditKey: ref.creditKey,
      remaining: reading.remaining,
      limit: reading.limit,
    },
  );
}

const oneDecimal = (n: number): number => Math.round(n * 10) / 10;

/**
 * budget_projection (plan item C-3): the guard is still normal, but the last 24 h of spending
 * would use up the remaining credits before the quota resets. In economy, minimal and stop the
 * budget alarm already speaks, so this one is for `normal` only; resolved when the projection fits.
 */
export async function syncProjectionAlarm(
  tx: DbTransaction,
  ref: Omit<AlarmRef, 'runId'> & { runId: string | null },
  status: CreditStatus,
  projection: CreditProjection,
): Promise<void> {
  const subjectKey = creditAlarmSubject(ref.creditKey, 'projection');
  if (projection.overruns && status.mode === 'normal' && ref.runId !== null) {
    const days = projection.daysUntilEmpty === null ? 0 : oneDecimal(projection.daysUntilEmpty);
    await raise(
      tx,
      { ...ref, runId: ref.runId },
      subjectKey,
      'budget_projection',
      'warning',
      `Bookmaker odds credits will run out in about ${Math.max(1, Math.round(days))} days, before the reset on the 1st`,
      {
        remaining: status.remaining,
        quota: status.quota,
        spentLast24h: status.spentLast24h,
        projectedToReset: Math.round(projection.projectedToReset),
        daysUntilEmpty: days,
        daysLeftInMonth: oneDecimal(projection.daysLeftInMonth),
      },
      { alarm: 'budget_projection', creditKey: ref.creditKey, daysUntilEmpty: days },
    );
    return;
  }
  if (!projection.overruns) {
    await closeReviewItemsBySubject(tx, subjectKey, {
      kinds: ['source_broken'],
      resolution: 'the projection fits the remaining credits',
      now: ref.now,
    });
  }
}

/** An answer refused the key (HTTP 401): a bad or deactivated key, or no credits left. */
export async function raiseUnauthorized(tx: DbTransaction, ref: AlarmRef): Promise<void> {
  await raise(
    tx,
    ref,
    creditAlarmSubject(ref.creditKey, 'unauthorized'),
    'unauthorized',
    'critical',
    'The bookmaker odds API refused the key (HTTP 401): reads are stopped',
    {},
    { alarm: 'unauthorized', creditKey: ref.creditKey },
  );
}

/** A read with the key succeeded: the refusal is over. */
export async function resolveUnauthorized(
  tx: DbTransaction,
  creditKey: string,
  now: Date,
): Promise<void> {
  await closeReviewItemsBySubject(tx, creditAlarmSubject(creditKey, 'unauthorized'), {
    kinds: ['source_broken'],
    resolution: 'a read with the key succeeded',
    now,
  });
}

/** G3: a request cost more than expected (a book list over 10, or a default that changed). */
export async function raiseUnexpectedCost(
  tx: DbTransaction,
  ref: AlarmRef,
  cost: { cost: number; expected: number },
): Promise<void> {
  await raise(
    tx,
    ref,
    creditAlarmSubject(ref.creditKey, 'unexpected_cost'),
    'unexpected_cost',
    'warning',
    `A bookmaker odds request cost ${cost.cost} credits instead of ${cost.expected}`,
    cost,
    { alarm: 'unexpected_cost', creditKey: ref.creditKey, ...cost },
  );
}

/**
 * A market-priced match within 24 h of kickoff kept prices the market can no longer back (the
 * re-pricing pass's `keep` case); resolved once fresh prices price it again.
 */
export async function syncMarketStaleAlarm(
  tx: DbTransaction,
  input: { eventId: string; kickoff: Date; stale: boolean; now: Date },
): Promise<void> {
  const subjectKey = marketStaleSubject(input.eventId);
  if (!input.stale) {
    await closeReviewItemsBySubject(tx, subjectKey, {
      kinds: ['source_broken'],
      resolution: 'fresh bookmaker prices arrived',
      now: input.now,
    });
    return;
  }
  await raise(
    tx,
    { creditKey: '', sourceId: 'market', runId: input.eventId, now: input.now },
    subjectKey,
    'market_stale',
    'warning',
    'Bookmaker prices are stale for a match within 24 h: it keeps its last prices',
    { eventId: input.eventId, kickoff: input.kickoff.toISOString() },
  );
}

/**
 * Rule O7 (P-3): the event's prices, as the re-pricing pass makes them now, have selections above
 * the best fresh book price (`outOfLine`, with both prices). With the cap off (the default,
 * measurement) they are offered as they are: a warning; with SCRAPER_CAP_AT_BEST_PRICE=on they were
 * lowered to the best book price: an info item that says so. Refreshed every pass while it holds
 * (the payload lists the selections now); resolved once no selection is out of line any more, or by
 * resolveOutOfLineAlarm once the event leaves the pass.
 */
export async function syncOutOfLineAlarm(
  tx: DbTransaction,
  input: {
    eventId: string;
    feedRef: string;
    kickoff: Date;
    outOfLine: readonly OutOfLineSelection[];
    capped: boolean;
    now: Date;
  },
): Promise<void> {
  const subjectKey = outOfLineSubject(input.eventId);
  if (input.outOfLine.length === 0) {
    await closeReviewItemsBySubject(tx, subjectKey, {
      kinds: ['source_broken'],
      resolution: 'no selection is priced above the best book price any more',
      now: input.now,
    });
    return;
  }
  const n = input.outOfLine.length;
  const what = n === 1 ? '1 selection' : `${n} selections`;
  await raise(
    tx,
    { creditKey: '', sourceId: 'market', runId: input.eventId, now: input.now },
    subjectKey,
    'odds_out_of_line',
    input.capped ? 'info' : 'warning',
    input.capped
      ? `${what} capped at the best bookmaker price (O7)`
      : `${what} priced above the best bookmaker price, not capped (SCRAPER_CAP_AT_BEST_PRICE=off)`,
    {
      eventId: input.eventId,
      feedRef: input.feedRef,
      kickoff: input.kickoff.toISOString(),
      capped: input.capped,
      selections: input.outOfLine.map((o) => ({ ...o })),
    },
  );
}

/** Resolves an event's odds_out_of_line alarm once the re-pricing pass no longer looks at it. */
export async function resolveOutOfLineAlarm(
  tx: DbTransaction,
  eventId: string,
  now: Date,
): Promise<number> {
  const closed = await closeReviewItemsBySubject(tx, outOfLineSubject(eventId), {
    kinds: ['source_broken'],
    resolution: 'the event left the re-pricing pass (kickoff near, result, or policy removed)',
    now,
  });
  return closed.length;
}
