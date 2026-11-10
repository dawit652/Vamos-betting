import { closeReviewItemsBySubject, openReviewItem, type DbTransaction } from '@vamos/db';
import type { CreditProjection, CreditStatus } from '@vamos/scraper';

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
 */

export type CreditAlarmReason =
  | 'budget_low'
  | 'budget_exhausted'
  | 'budget_projection'
  | 'unauthorized'
  | 'unexpected_cost'
  | 'market_stale';

/** The key, the source and the run an alarm points at. */
export interface AlarmRef {
  creditKey: string;
  sourceId: string;
  runId: string;
  now: Date;
}

export const creditAlarmSubject = (
  creditKey: string,
  cause: 'budget' | 'projection' | 'unauthorized' | 'unexpected_cost',
): string => `credits|${creditKey}|${cause}`;

export const marketStaleSubject = (eventId: string): string => `market_stale|${eventId}`;

async function raise(
  tx: DbTransaction,
  ref: AlarmRef,
  subjectKey: string,
  reason: CreditAlarmReason,
  severity: 'warning' | 'critical',
  title: string,
  extra: Record<string, unknown>,
): Promise<void> {
  await openReviewItem(tx, {
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
