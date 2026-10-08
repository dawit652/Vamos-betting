import type { DbExecutor } from '@vamos/db';
import { rgExclusions, users, type rgExclusionKind } from '@vamos/db/schema';
import { and, desc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import { forbidden, notFound, type AppError } from '../../lib/errors';

export type ExclusionKind = (typeof rgExclusionKind.enumValues)[number];

export interface ActiveExclusion {
  kind: ExclusionKind;
  startsAt: Date;
  /** null = permanent self-exclusion. */
  endsAt: Date | null;
}

/**
 * The exclusion in force at `now` (starts_at <= now and ends_at is null or
 * after now), or null. When several overlap, the most restrictive one wins:
 * a self-exclusion before a cool-off, then the one that ends last (permanent
 * first), then the latest to start. `options.kind` limits the search to one kind.
 */
export async function getActiveExclusion(
  exec: DbExecutor,
  userId: string,
  now: Date,
  options: { kind?: ExclusionKind } = {},
): Promise<ActiveExclusion | null> {
  const [row] = await exec
    .select({
      kind: rgExclusions.kind,
      startsAt: rgExclusions.startsAt,
      endsAt: rgExclusions.endsAt,
    })
    .from(rgExclusions)
    .where(
      and(
        eq(rgExclusions.userId, userId),
        lte(rgExclusions.startsAt, now),
        or(isNull(rgExclusions.endsAt), gt(rgExclusions.endsAt, now)),
        options.kind === undefined ? undefined : eq(rgExclusions.kind, options.kind),
      ),
    )
    .orderBy(
      desc(sql`${rgExclusions.kind} = 'self_exclusion'`),
      // DESC puts NULL (permanent) first in PostgreSQL.
      desc(rgExclusions.endsAt),
      desc(rgExclusions.startsAt),
    )
    .limit(1);
  return row ?? null;
}

/** The 403 for an active exclusion: `self_excluded` or `cooling_off`, naming the end date. */
export function exclusionError(exclusion: ActiveExclusion): AppError {
  const endsAt = exclusion.endsAt?.toISOString() ?? null;
  const details = { kind: exclusion.kind, endsAt };
  if (exclusion.kind === 'self_exclusion') {
    return forbidden(
      'self_excluded',
      endsAt === null
        ? 'You have permanently self-excluded from Vamos.'
        : `You are self-excluded until ${endsAt}.`,
      details,
    );
  }
  return forbidden(
    'cooling_off',
    endsAt === null
      ? 'You are on a cool-off break.'
      : `You are on a cool-off break until ${endsAt}.`,
    details,
  );
}

/**
 * Throws when the player may not gamble (bet, deposit, enter jackpots) at
 * `now`: 404 for an unknown user, 403 `account_disabled` when the account is
 * not active (e.g. suspended after an underage KYC finding), and 403
 * `self_excluded` or `cooling_off` during an exclusion.
 */
export async function assertCanGamble(exec: DbExecutor, userId: string, now: Date): Promise<void> {
  const [user] = await exec
    .select({ status: users.status })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) throw notFound('User');
  if (user.status !== 'active') {
    throw forbidden('account_disabled', 'This account is disabled. Please contact support.', {
      status: user.status,
    });
  }
  const exclusion = await getActiveExclusion(exec, userId, now);
  if (exclusion !== null) {
    throw exclusionError(exclusion);
  }
}
