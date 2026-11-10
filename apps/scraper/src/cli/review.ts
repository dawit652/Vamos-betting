import { reviewQueueSummary, type Database } from '@vamos/db';
import { EXIT_OK, emit, noPositionals, parseCommandArgs, table, type CliEnv } from './io';

/**
 * `review counts [--json]`: the OPEN review-queue items per kind (every kind,
 * zeros included) with the creation time of the oldest open item, and the
 * total, so the queue can be seen at a glance.
 */
export async function reviewCounts(args: string[], env: CliEnv): Promise<number> {
  const parsed = parseCommandArgs(args, {});
  noPositionals(parsed);
  const db: Database = await env.database();
  const kinds = await reviewQueueSummary(db, 'open');
  const total = kinds.reduce((sum, k) => sum + k.count, 0);
  emit(
    env,
    parsed,
    {
      kinds: kinds.map((k) => ({
        kind: k.kind,
        count: k.count,
        oldestCreatedAt: k.oldestCreatedAt?.toISOString() ?? null,
      })),
      total,
    },
    [
      ...table(
        ['kind', 'open', 'oldest open'],
        kinds.map((k) => [k.kind, String(k.count), k.oldestCreatedAt?.toISOString() ?? '-']),
      ),
      `${total} open review item(s)`,
    ],
  );
  return EXIT_OK;
}
