import { sql } from 'drizzle-orm';
import type { DbExecutor } from '../ledger/types';
import { DEFAULT_LISTED_WINDOW_MS } from './events';

/** What decides whether a source that keeps answering has in fact stopped giving news (rule S5). */
export interface SourceContentFacts {
  sourceId: string;
  sourceName: string;
  /** When any observation of the source last took its current value (never null: sources without observations are left out). */
  lastChangedAt: Date;
  /**
   * Scraped events the source lists that are still scheduled and unresulted, that ended (at the
   * earliest) `staleAfterMs` or more before `now`, and whose end lies after `lastChangedAt`: the
   * source has shown nothing new since they ended.
   */
  dueMatches: number;
}

interface FactsRow extends Record<string, unknown> {
  source_id: string;
  source_name: string;
  last_changed_at: Date | string;
  due_matches: string | number;
}

/**
 * For every enabled source whose latest finished run was ok and that has produced at least one
 * observation: when its content last changed, and how many matches it lists ended long enough ago
 * (`staleAfterMs`) with nothing new from the source since. A source whose runs fail has its own
 * signals; one that never produced anything is not "frozen".
 */
export async function listSourceContentFacts(
  exec: DbExecutor,
  options: {
    now: Date;
    minMatchDurationMs: number;
    /** How long after a match's earliest possible end a source may stay silent. */
    staleAfterMs: number;
    listedWindowMs?: number;
  },
): Promise<SourceContentFacts[]> {
  const now = options.now.toISOString();
  const windowMs = options.listedWindowMs ?? DEFAULT_LISTED_WINDOW_MS;
  const minMatch = options.minMatchDurationMs;
  // Summed here: Postgres cannot type `$1 + $2` for two bound numbers.
  const endAndAllowance = minMatch + options.staleAfterMs;
  const result = await exec.execute<FactsRow>(sql`
    SELECT s.id AS source_id, s.name AS source_name, c.last_changed_at,
      (SELECT count(*) FROM events e
        WHERE e.feed_provider = 'scraped'
          AND e.status = 'scheduled' AND e.resulted_at IS NULL
          AND e.start_time + (${endAndAllowance} * interval '1 millisecond') <= ${now}::timestamptz
          AND e.start_time + (${minMatch} * interval '1 millisecond') > c.last_changed_at
          AND EXISTS (
            SELECT 1 FROM scrape_observations f
            WHERE f.source_id = s.id AND f.kind = 'fixture'
              AND f.competition_id = e.competition_id
              AND f.home_team_id = e.home_team_id
              AND f.away_team_id = e.away_team_id
              AND abs(extract(epoch FROM (f.kickoff - e.start_time))) * 1000 <= ${windowMs})
      ) AS due_matches
    FROM scrape_sources s
    JOIN LATERAL (
      SELECT max(o.changed_at) AS last_changed_at FROM scrape_observations o WHERE o.source_id = s.id
    ) c ON c.last_changed_at IS NOT NULL
    WHERE s.enabled
      AND (SELECT r.status FROM scrape_runs r
           WHERE r.source_id = s.id AND r.status NOT IN ('running', 'skipped')
           ORDER BY r.started_at DESC, r.id DESC LIMIT 1) = 'ok'
    ORDER BY s.id`);
  return result.rows.map((row) => ({
    sourceId: row.source_id,
    sourceName: row.source_name,
    lastChangedAt: new Date(row.last_changed_at),
    dueMatches: Number(row.due_matches),
  }));
}
