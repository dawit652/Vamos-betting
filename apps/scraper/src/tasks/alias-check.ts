import { enqueueOwnerAlert, listAliases } from '@vamos/db';
import { HOUR_MS, suspiciousAlias } from '@vamos/scraper';
import type { ScraperContext } from '../context';
import { intervalTask, type IntervalTask } from '../lib/interval';

/**
 * Rule L3's daily alias check (docs/plans/name-learning.md; owner, 23 Nov 2026): the team aliases
 * written in the last two days, by a person or by N4, that look wrong (a reserve, youth, women's or
 * national team, or another club: `suspiciousAlias`). They are logged and the owner gets one
 * Telegram line a day at most (alarm `alias_suspicious`). Nothing is changed: a person removes a
 * wrong alias in Back office → Feed → Aliases. Older aliases are not listed again every day.
 */
export const ALIAS_CHECK_INTERVAL_MS = 6 * HOUR_MS;
export const ALIAS_CHECK_LOOKBACK_MS = 48 * HOUR_MS;

export interface SuspiciousAliasRow {
  id: string;
  alias: string;
  team: string;
  sourceId: string | null;
  reason: string;
}

export interface AliasCheckSummary {
  checked: number;
  suspicious: SuspiciousAliasRow[];
  alerted: boolean;
}

export async function runAliasCheck(ctx: ScraperContext): Promise<AliasCheckSummary> {
  const now = ctx.clock();
  const since = now.getTime() - ALIAS_CHECK_LOOKBACK_MS;
  const rows = (await listAliases(ctx.db, { kind: 'team', limit: 2000 })).filter(
    (row) => row.createdAt.getTime() >= since,
  );
  const suspicious: SuspiciousAliasRow[] = rows.flatMap((row) => {
    const reason = suspiciousAlias(row.aliasNorm, [row.targetLabel]);
    return reason === null
      ? []
      : [
          {
            id: row.id,
            alias: row.aliasNorm,
            team: row.targetLabel,
            sourceId: row.sourceId,
            reason,
          },
        ];
  });
  let alerted = false;
  if (suspicious.length > 0) {
    ctx.logger.warn({ alarm: 'alias_suspicious', suspicious }, 'team aliases look wrong');
    alerted = await enqueueOwnerAlert(
      ctx.db,
      ctx.config.ownerAlerts,
      {
        alarm: 'alias_suspicious',
        count: suspicious.length,
        examples: suspicious.map((s) => `${s.alias} -> ${s.team}`),
      },
      now,
    );
  }
  ctx.logger[suspicious.length > 0 ? 'info' : 'debug'](
    { checked: rows.length, suspicious: suspicious.length, alerted },
    'alias check',
  );
  return { checked: rows.length, suspicious, alerted };
}

export function aliasCheckTask(ctx: ScraperContext): IntervalTask {
  return intervalTask({
    name: 'alias-check',
    intervalMs: ALIAS_CHECK_INTERVAL_MS,
    logger: ctx.logger,
    run: () => runAliasCheck(ctx),
    runOnStart: false,
  });
}
