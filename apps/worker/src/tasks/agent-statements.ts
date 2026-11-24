import { generateAgentStatements, lastStatementWeek } from '@vamos/db';
import { intervalTask, type IntervalTask } from '../lib/interval';
import type { TaskContext } from './context';

/** Looked at hourly: last week's statements appear from Monday 01:00 Addis Ababa time on. */
export const AGENT_STATEMENTS_INTERVAL_MS = 60 * 60_000;

/**
 * Agents' weekly statements (docs/plans/agent-shops.md, "Phase 5 design", step 1): makes last
 * week's statement for every independent agent that has none yet. Idempotent (one per agent and
 * week), so a run missed while the worker was down is caught up by the next one.
 */
export async function runAgentStatements(ctx: TaskContext): Promise<number> {
  const now = ctx.clock();
  const weekStart = lastStatementWeek(now);
  const { created } = await ctx.db.transaction((tx) =>
    generateAgentStatements(tx, { weekStart, now }),
  );
  if (created > 0) ctx.logger.info({ weekStart, created }, 'agent statements made');
  return created;
}

export function agentStatementsTask(ctx: TaskContext, intervalMs?: number): IntervalTask {
  return intervalTask({
    name: 'agent-statements',
    intervalMs: intervalMs ?? AGENT_STATEMENTS_INTERVAL_MS,
    logger: ctx.logger,
    run: () => runAgentStatements(ctx),
  });
}
