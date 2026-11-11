import {
  apiCreditUsage,
  listScrapedEvents,
  listSources,
  sourceHealth,
  type ScrapeSource,
} from '@vamos/db';
import {
  calendarSpanDays,
  createAdapter,
  creditKeyOf,
  creditStatus,
  DAY_MS,
  daysLeftInMonthUtc,
  daysUntilLeavesNormal,
  estimateOddsReadsPerDay,
  estimateScoresReadsPerDay,
  METERED_RESULTS_WINDOW_END_MS,
  summariseCredits,
  TheOddsApiConfigSchema,
  utcMonthStart,
  type SourceAdapter,
} from '@vamos/scraper';
import {
  EXIT_OK,
  emit,
  noPositionals,
  optionalString,
  parseCommandArgs,
  table,
  UsageError,
  type CliEnv,
  type PollingSettings,
} from './io';
import { competitionResolver, meteredPolling } from '../lib/source-competition';

/** The Odds API 20K plan (docs/theoddsapi-plan/README.md, section 2): credits a month, reset on the 1st (UTC). */
export const PLAN_QUOTA = 20_000;
/** How far ahead the fixture calendar is read. Events are created at most 14 days ahead. */
export const CALENDAR_DAYS = 30;

const n1 = (value: number): string => (Math.round(value * 10) / 10).toFixed(1);

/** The C-2 settings: the scraper's own (SCRAPER_*), unless a flag tries another value. */
function pollingSettingsOf(
  parsed: ReturnType<typeof parseCommandArgs>,
  env: CliEnv,
): PollingSettings {
  const base = env.pollingSettings?.() ?? {
    priorityCompetitions: null,
    skipRedundantScores: false,
  };
  const priority = optionalString(parsed, 'priority');
  const skip = optionalString(parsed, 'skip-redundant-scores');
  let priorityCompetitions = base.priorityCompetitions;
  if (priority !== undefined) {
    const slugs = priority
      .split(',')
      .map((slug) => slug.trim().toLowerCase())
      .filter((slug) => slug.length > 0);
    if (slugs.some((slug) => !/^[a-z0-9][a-z0-9-]*$/.test(slug))) {
      throw new UsageError(`--priority takes competition slugs separated by commas, or "all"`);
    }
    priorityCompetitions = slugs.length === 0 || slugs.includes('all') ? null : [...new Set(slugs)];
  }
  if (skip !== undefined && skip !== 'on' && skip !== 'off') {
    throw new UsageError(`--skip-redundant-scores takes on or off, got "${skip}"`);
  }
  return {
    priorityCompetitions,
    skipRedundantScores: skip === undefined ? base.skipRedundantScores : skip === 'on',
  };
}

/**
 * `sources budget [--json]`: the credits a day each enabled metered source (The Odds API) will
 * use on the reading schedule over the fixture calendar of the next 30 days, against the plan
 * quota; the actual spend (last 24 h, month to date) and what is left per key; and how long the
 * credit guard stays in `normal` at the estimated rate. Read-only; the maths is in
 * @vamos/scraper (budget.ts) and replays the scheduler's own interval functions, with the same
 * C-2 tiers and redundant-scores skip (meteredPolling) as the scheduler.
 */
export async function sourcesBudget(args: string[], env: CliEnv): Promise<number> {
  const parsed = parseCommandArgs(args, {
    priority: { type: 'string' },
    'skip-redundant-scores': { type: 'string' },
  });
  noPositionals(parsed);
  const settings = pollingSettingsOf(parsed, env);
  const db = await env.database();
  const now = env.clock();
  const all = await listSources(db);
  const enabled = all.filter((s) => s.enabled);

  interface Metered {
    source: ScrapeSource;
    adapter: SourceAdapter;
    mode: 'odds' | 'scores';
    cost: number;
    key: string;
    label: string;
    horizonMs: number;
  }
  const metered: Metered[] = [];
  for (const source of enabled) {
    const built = createAdapter({
      id: source.id,
      adapter: source.adapter,
      upstream: source.upstream,
      config: source.config,
    });
    if (!built.ok || built.adapter.usage === undefined) continue;
    const plan = built.adapter.plan(now);
    const mode = plan.some((p) => p.purpose === 'odds')
      ? 'odds'
      : plan.some((p) => p.purpose === 'results')
        ? 'scores'
        : null;
    if (mode === null) continue;
    const config = TheOddsApiConfigSchema.safeParse(source.config);
    metered.push({
      source,
      adapter: built.adapter,
      mode,
      cost: built.adapter.usage.expectedCost,
      key: creditKeyOf(source.id, plan),
      label: config.success ? config.data.competition : source.id,
      horizonMs: (config.success ? config.data.horizonDays : 15) * DAY_MS,
    });
  }
  const disabledMetered = all.filter((s) => !s.enabled && s.adapter === 'theoddsapi').length;

  const failing = new Set(
    (await sourceHealth(db, now)).filter((x) => x.consecutiveFailures > 0).map((x) => x.sourceId),
  );
  const polling = await meteredPolling(db, {
    enabled,
    odds: metered.filter((m) => m.mode === 'odds').map((m) => m.source),
    scores: metered.filter((m) => m.mode === 'scores').map((m) => m.source),
    failing,
    ...settings,
  });
  const resolve = await competitionResolver(db);
  const events = await listScrapedEvents(db, {
    from: new Date(now.getTime() - METERED_RESULTS_WINDOW_END_MS),
    to: new Date(now.getTime() + CALENDAR_DAYS * DAY_MS),
  });
  const kickoffsOf = (competitionId: string | null): Date[] =>
    competitionId === null
      ? []
      : events.filter((e) => e.competitionId === competitionId).map((e) => e.startTime);

  const perSource = metered.map((m) => {
    const resolved = resolve(m.source, m.label);
    return { m, competition: resolved.key, kickoffs: kickoffsOf(resolved.id) };
  });
  const upcoming = perSource.flatMap((p) => p.kickoffs.filter((k) => k.getTime() > now.getTime()));
  const span = calendarSpanDays(now, upcoming, CALENDAR_DAYS);

  const sources = perSource.map(({ m, competition, kickoffs }) => {
    const tier = polling.get(m.source.id)?.tier ?? 'priority';
    const skipped = polling.get(m.source.id)?.skipped ?? false;
    const reads = skipped
      ? Array.from({ length: CALENDAR_DAYS }, () => 0)
      : m.mode === 'odds'
        ? estimateOddsReadsPerDay({
            now,
            kickoffs,
            days: CALENDAR_DAYS,
            horizonMs: m.horizonMs,
            tier,
          })
        : estimateScoresReadsPerDay({ now, kickoffs, days: CALENDAR_DAYS });
    const credits = summariseCredits(reads, m.cost, span);
    return {
      sourceId: m.source.id,
      competition,
      creditKey: m.key,
      mode: m.mode,
      tier,
      skipped,
      costPerRead: m.cost,
      matches: kickoffs.filter((k) => k.getTime() > now.getTime()).length,
      readsPerDay: credits.avgReadsPerDay,
      creditsPerDay: credits.avgCreditsPerDay,
      peakCreditsDay: credits.peakCredits,
      peakDay: credits.peakDay,
    };
  });

  const monthStart = utcMonthStart(now);
  const daysLeft = daysLeftInMonthUtc(now);
  const resetsOn = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const keyNames = [...new Set(metered.map((m) => m.key))].sort();
  const keys = [];
  for (const key of keyNames) {
    const members = metered.filter((m) => m.key === key);
    const ids = members.map((m) => m.source.id);
    const [last24h, month] = await Promise.all([
      apiCreditUsage(db, {
        sourceIds: ids,
        monthStart,
        since: new Date(now.getTime() - DAY_MS),
      }),
      apiCreditUsage(db, { sourceIds: ids, monthStart, since: monthStart }),
    ]);
    const status = creditStatus(
      last24h,
      members.map((m) => m.source.updatedAt),
      now,
    );
    const quota = status.quota ?? PLAN_QUOTA;
    const spentMonth = month.spentSince;
    const remaining = status.remaining ?? Math.max(0, quota - spentMonth);
    const creditsPerDay = sources
      .filter((s) => s.creditKey === key)
      .reduce((sum, s) => sum + s.creditsPerDay, 0);
    const leaves = daysUntilLeavesNormal({
      quota,
      remaining,
      creditsPerDay,
      daysLeftInMonth: daysLeft,
    });
    keys.push({
      creditKey: key,
      sources: ids,
      quota,
      quotaFromReading: status.quota !== null,
      remaining,
      spentLast24h: status.spentLast24h,
      spentMonthToDate: spentMonth,
      guardMode: status.mode,
      estimatedCreditsPerDay: creditsPerDay,
      estimatedMonthEndSpend: spentMonth + creditsPerDay * daysLeft,
      estimatedMonthEndShareOfQuota:
        quota > 0 ? (spentMonth + creditsPerDay * daysLeft) / quota : 0,
      daysUntilLeavesNormal: leaves.days,
      modeThen: leaves.mode,
    });
  }

  const unmatchedPriority = (settings.priorityCompetitions ?? []).filter(
    (slug) => !sources.some((s) => s.competition === slug),
  );
  const assumptions = [
    `Reads follow the scheduler's schedule in normal mode (priority competitions 10 min, 30 min, 2 h, 6 h by the next kickoff; standard ones 30 min, 2 h, 6 h, 6 h; scores every 20 min from kickoff + 110 min to + 4 h), one interval apart: no early start jitter.`,
    settings.priorityCompetitions === null
      ? 'Tiers: no priority list (SCRAPER_PRIORITY_COMPETITIONS unset), so every competition is priority.'
      : `Tiers: priority = ${settings.priorityCompetitions.join(', ')}; every other resolved competition is standard.`,
    settings.skipRedundantScores
      ? 'Redundant scores skipped (SCRAPER_SKIP_REDUNDANT_SCORES=on): a scores source whose competition has two other healthy full-time upstreams (one with half time) reads nothing.'
      : 'Every scores source is read (SCRAPER_SKIP_REDUNDANT_SCORES=off).',
    `Calendar: scheduled and live scraped events of the next ${CALENDAR_DAYS} days; events exist at most 14 days ahead, so rates are averaged over the ${span} day(s) the calendar covers.`,
    'An odds read that would return no match is free (not counted). A scores match stays in its window to + 4 h: an upper bound (a resulted match leaves it).',
    `Quota ${PLAN_QUOTA} (20K plan) when no run has reported the key's quota yet. Spend counts credits the runs recorded.`,
    'Estimated month-end spend = month to date + estimated rate x days left; the guard is replayed in quarter-day steps.',
  ];

  const lines: string[] = [];
  if (sources.length === 0) lines.push('no enabled metered (The Odds API) sources');
  else {
    lines.push(
      ...table(
        [
          'source',
          'competition',
          'mode',
          'cost',
          'matches',
          'reads/day',
          'credits/day',
          'peak day',
          'tier',
          'skipped',
        ],
        sources.map((s) => [
          s.sourceId,
          s.competition,
          s.mode,
          String(s.costPerRead),
          String(s.matches),
          n1(s.readsPerDay),
          n1(s.creditsPerDay),
          `${n1(s.peakCreditsDay)} (day ${s.peakDay})`,
          s.tier,
          s.skipped ? 'redundant' : '-',
        ]),
      ),
      '',
      ...table(
        [
          'credit key',
          'quota',
          'left',
          'spent 24h',
          'spent month',
          'est/day',
          'est month end',
          'guard',
          'leaves normal',
        ],
        keys.map((k) => [
          k.creditKey,
          `${k.quota}${k.quotaFromReading ? '' : '*'}`,
          String(k.remaining),
          String(k.spentLast24h),
          String(k.spentMonthToDate),
          n1(k.estimatedCreditsPerDay),
          `${Math.round(k.estimatedMonthEndSpend)} (${Math.round(k.estimatedMonthEndShareOfQuota * 100)}%)`,
          k.guardMode,
          k.daysUntilLeavesNormal === null
            ? 'not before reset'
            : `in ${n1(k.daysUntilLeavesNormal)} d (${k.modeThen})`,
        ]),
      ),
      '',
      `quota resets ${resetsOn.toISOString().slice(0, 10)} (${n1(daysLeft)} days). * = plan quota, no reading yet.`,
    );
    if (disabledMetered > 0)
      lines.push(`${disabledMetered} disabled Odds API source(s) not counted.`);
    if (unmatchedPriority.length > 0)
      lines.push(`priority slug(s) no metered source reads: ${unmatchedPriority.join(', ')}`);
  }
  lines.push('', 'assumptions:', ...assumptions.map((a) => `  - ${a}`));

  emit(
    env,
    parsed,
    {
      asOf: now.toISOString(),
      resetsOn: resetsOn.toISOString().slice(0, 10),
      daysLeftInMonth: daysLeft,
      calendarSpanDays: span,
      disabledMeteredSources: disabledMetered,
      priorityCompetitions: settings.priorityCompetitions,
      skipRedundantScores: settings.skipRedundantScores,
      unmatchedPriority,
      sources,
      keys,
      assumptions,
    },
    lines,
  );
  return EXIT_OK;
}
