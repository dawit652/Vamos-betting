import { getSource, listSources, sourceHealth, upsertSource } from '@vamos/db';
import {
  runTruthCheck,
  seasonStart,
  UnknownUpstreamError,
  type UpstreamTruthRow,
} from '../eval/truth-check';
import {
  CliFailure,
  EXIT_OK,
  emit,
  noPositionals,
  optionalString,
  parseCommandArgs,
  requiredString,
  table,
  UsageError,
  type CliEnv,
} from './io';
import { loadSourceFile } from './source-file';

const iso = (date: Date | null): string => (date === null ? '-' : date.toISOString());

/** `sources list`: every source with its state (enabled, last run, failures, open review items). */
export async function sourcesList(args: string[], env: CliEnv): Promise<number> {
  const parsed = parseCommandArgs(args, {});
  noPositionals(parsed);
  const db = await env.database();
  const [sources, health] = await Promise.all([listSources(db), sourceHealth(db, env.clock())]);
  const byId = new Map(health.map((h) => [h.sourceId, h]));
  const rows = sources.map((source) => {
    const h = byId.get(source.id);
    return {
      id: source.id,
      name: source.name,
      adapter: source.adapter,
      upstream: source.upstream,
      enabled: source.enabled,
      lastStatus: h?.lastStatus ?? null,
      lastOkAt: h?.lastOkAt ?? null,
      consecutiveFailures: h?.consecutiveFailures ?? 0,
      openReviewItems: h?.openReviewItems ?? 0,
    };
  });
  const lines =
    rows.length === 0
      ? ['no sources']
      : table(
          ['id', 'adapter', 'upstream', 'state', 'last run', 'last ok', 'failures', 'open items'],
          rows.map((r) => [
            r.id,
            r.adapter,
            r.upstream,
            r.enabled ? 'enabled' : 'disabled',
            r.lastStatus ?? 'never run',
            iso(r.lastOkAt),
            String(r.consecutiveFailures),
            String(r.openReviewItems),
          ]),
        );
  emit(env, parsed, rows, lines);
  return EXIT_OK;
}

/**
 * `sources upsert --file source.json`: validates the config with createAdapter,
 * then upserts. A new source starts DISABLED and an existing one keeps its
 * enabled flag: switching a source on stays a person's decision.
 */
export async function sourcesUpsert(args: string[], env: CliEnv): Promise<number> {
  const parsed = parseCommandArgs(args, { file: { type: 'string' } });
  noPositionals(parsed);
  const { source } = await loadSourceFile(env, requiredString(parsed, 'file'));
  const db = await env.database();
  const before = await getSource(db, source.id);
  const saved = await db.transaction((tx) => upsertSource(tx, source, env.actor));
  const outcome =
    before === null
      ? 'created'
      : saved.updatedAt.getTime() === before.updatedAt.getTime()
        ? 'unchanged'
        : 'updated';
  emit(env, parsed, { outcome, id: saved.id, enabled: saved.enabled, adapter: saved.adapter }, [
    `${outcome} source ${saved.id} (${saved.adapter}, upstream ${saved.upstream})`,
    saved.enabled
      ? 'state: enabled (unchanged)'
      : 'state: disabled; it stays off until a person switches it on',
  ]);
  return EXIT_OK;
}

const pct = (rate: number | null): string => (rate === null ? '-' : `${(rate * 100).toFixed(2)}%`);
const scoreText = (s: {
  home: number;
  away: number;
  htHome: number | null;
  htAway: number | null;
}) =>
  `${s.home}-${s.away}${s.htHome === null || s.htAway === null ? '' : ` (HT ${s.htHome}-${s.htAway})`}`;
/** Disagreement examples printed per upstream (the JSON and the stored row hold up to 20). */
const PRINTED_EXAMPLES = 5;

/** `--since YYYY-MM-DD` as midnight UTC; anything else is a usage error. */
function sinceDate(text: string): Date {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T00:00:00Z`) : null;
  if (date === null || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw new UsageError('--since must be a date as YYYY-MM-DD');
  }
  return date;
}

/**
 * `sources truth-check [--upstream <name>] [--since YYYY-MM-DD] [--write] [--json]` (plan task 1.2):
 * for each upstream (or one), compares its finished regular-time result observations (football) of
 * the events that have an applied final result (resulted, finished, score set) since the date
 * (default: 1 July of the current season) with the applied result. The full-time score must match,
 * and the half-time score too when both sides have one. One comparison per event and upstream: an
 * upstream with several sources disagrees when any of its sources does. Prints upstream, compared,
 * agreed, rate and trust level; `--write` stores the rows in scrape_source_trust (with up to 20
 * recent disagreements), which is what the result ladder reads. The check is partly circular: a
 * result applied on this upstream's own vote agrees with it by construction, so the table also
 * counts those events (from the `scrape.result.applied` audit row) and the rate without them.
 */
export async function sourcesTruthCheck(args: string[], env: CliEnv): Promise<number> {
  const parsed = parseCommandArgs(args, {
    upstream: { type: 'string' },
    since: { type: 'string' },
    write: { type: 'boolean' },
  });
  noPositionals(parsed);
  const now = env.clock();
  const sinceText = optionalString(parsed, 'since');
  const since = sinceText === undefined ? seasonStart(now) : sinceDate(sinceText);
  const upstream = optionalString(parsed, 'upstream');
  const write = parsed.values.write === true;
  const db = await env.database();
  let rows: UpstreamTruthRow[];
  try {
    rows = await runTruthCheck(db, {
      sport: 'football',
      since,
      ...(upstream === undefined ? {} : { upstream }),
      now,
      write,
    });
  } catch (error) {
    if (error instanceof UnknownUpstreamError) {
      throw new CliFailure(error.message, [
        error.known.length === 0
          ? 'there are no sources'
          : `known upstreams: ${error.known.join(', ')}`,
      ]);
    }
    throw error;
  }
  const json = {
    sport: 'football',
    since: since.toISOString(),
    measuredAt: now.toISOString(),
    written: write,
    upstreams: rows.map((r) => ({
      upstream: r.upstream,
      compared: r.compared,
      agreed: r.agreed,
      rate: r.rate,
      trust: r.trust,
      windowFrom: r.windowFrom?.toISOString() ?? null,
      windowTo: r.windowTo?.toISOString() ?? null,
      ownVote: r.ownVote,
      unrecorded: r.unrecorded,
      independentCompared: r.independentCompared,
      independentAgreed: r.independentAgreed,
      independentRate: r.independentRate,
      disagreements: r.disagreements,
    })),
  };
  const lines = [
    `Truth-check (football): events resulted with a final score, kickoff since ${since.toISOString().slice(0, 10)}`,
    "Each upstream's finished regular-time scores against the applied result: full time, and half time when both have one.",
    "Partly circular: a result applied on an upstream's own vote agrees with it by construction. 'own vote' counts those",
    "events (audit scrape.result.applied; 'no audit' = entered by hand or applied before it was recorded); 'rate w/o own' leaves them out.",
    '',
    ...(rows.length === 0
      ? ['no sources']
      : table(
          [
            'upstream',
            'compared',
            'agreed',
            'rate',
            'trust',
            'own vote',
            'no audit',
            'rate w/o own',
          ],
          rows.map((r) => [
            r.upstream,
            String(r.compared),
            String(r.agreed),
            pct(r.rate),
            r.trust,
            String(r.ownVote),
            String(r.unrecorded),
            pct(r.independentRate),
          ]),
        )),
    ...rows.flatMap((r) =>
      r.disagreements.length === 0
        ? []
        : [
            '',
            `${r.upstream}: ${r.disagreements.length} recent disagreement(s)${
              r.disagreements.length > PRINTED_EXAMPLES ? ` (newest ${PRINTED_EXAMPLES} shown)` : ''
            }`,
            ...table(
              ['  event', 'kickoff', 'source', 'observed', 'applied'],
              r.disagreements
                .slice(0, PRINTED_EXAMPLES)
                .map((d) => [
                  `  ${d.eventId}`,
                  d.kickoff,
                  d.sourceId,
                  scoreText(d.observed),
                  scoreText(d.applied),
                ]),
            ),
          ],
    ),
    '',
    write
      ? `stored ${rows.length} row(s) in scrape_source_trust`
      : 'nothing stored (add --write to store the rows the result ladder reads)',
  ];
  emit(env, parsed, json, lines);
  return EXIT_OK;
}
