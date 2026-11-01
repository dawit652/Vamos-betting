import { getReferenceBudget, listSources } from '@vamos/db';
import {
  parseTherundownEvents,
  readResponseMeters,
  TherundownConfigSchema,
  therundownDayUrl,
  THERUNDOWN_HOST,
  utcDateOf,
  type FetchPlanItem,
  type FetchResult,
  type TherundownConfig,
} from '@vamos/scraper';
import { secretProblemMessage } from '../lib/secrets';
import {
  CliFailure,
  EXIT_FAILED,
  EXIT_OK,
  emit,
  noPositionals,
  optionalString,
  parseCommandArgs,
  type CliEnv,
} from './io';
import { loadSourceFile } from './source-file';

const DEFAULT_BASE_URL = `https://${THERUNDOWN_HOST}`;
/** The source id of the draft in docs/therundown-plan/README.md 5.9. */
const DEFAULT_SOURCE_ID = 'therundown';

interface CheckedSource {
  id: string;
  config: TherundownConfig;
}

/** The source to check: the file given, else the TheRundown source of the database. */
async function loadTherundownSource(env: CliEnv, file: string | undefined): Promise<CheckedSource> {
  if (file !== undefined) {
    const { source } = await loadSourceFile(env, file);
    if (source.adapter !== 'therundown') {
      throw new CliFailure(
        `source "${source.id}" uses the adapter "${source.adapter}", not "therundown"`,
      );
    }
    return { id: source.id, config: parseConfig(source.id, source.config) };
  }
  const db = await env.database();
  const sources = (await listSources(db)).filter((source) => source.adapter === 'therundown');
  const source = sources.find((s) => s.id === DEFAULT_SOURCE_ID) ?? sources[0];
  if (source === undefined) {
    throw new CliFailure('no source with the adapter "therundown" in the database', [
      'add one with "sources upsert --file source.json", or pass --source-file',
    ]);
  }
  return { id: source.id, config: parseConfig(source.id, source.config) };
}

function parseConfig(id: string, config: unknown): TherundownConfig {
  const parsed = TherundownConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new CliFailure(
      `the config of source "${id}" (therundown) is not valid`,
      parsed.error.issues.map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`),
    );
  }
  return parsed.data;
}

function describeFailure(
  result: Exclude<FetchResult, { kind: 'ok' }>,
  item: FetchPlanItem,
): string {
  switch (result.kind) {
    case 'not_modified':
      return 'not modified (304)';
    case 'blocked':
      return `blocked (${result.reason}${result.status === undefined ? '' : `, HTTP ${result.status}`}); nothing was worked around`;
    case 'circuit_open':
      return 'circuit open after recent failures';
    case 'refused':
      return result.reason.startsWith('secret_')
        ? `refused (${result.reason}): ${secretProblemMessage(result.reason, item.auth?.secret)}`
        : `refused (${result.reason})`;
    case 'error':
      return `error (${result.code}${result.status === undefined ? '' : `, HTTP ${result.status}`}): ${result.message}`;
  }
}

const show = (value: number | string | Date | null): string =>
  value === null ? '-' : value instanceof Date ? value.toISOString() : String(value);

/**
 * `therundown check [--source-file f]`: one day request for each configured sport, for today
 * (UTC), through the PoliteFetcher with the key of SCRAPER_SECRET_THERUNDOWN (never printed). It
 * prints, per request, the HTTP status, the delay and rate headers, the data points the response
 * cost and what is left, how many events parsed, how many prices were kept and the parse issues
 * by code. It writes NOTHING (no database, no archive, and the body is dropped: TheRundown's
 * licence allows 24 hours). Exit 1 when a request failed or a body did not parse.
 */
export async function therundownCheck(args: string[], env: CliEnv): Promise<number> {
  const parsed = parseCommandArgs(args, { 'source-file': { type: 'string' } });
  noPositionals(parsed);
  const { id, config } = await loadTherundownSource(env, optionalString(parsed, 'source-file'));
  const baseUrl = env.therundownBaseUrl?.() ?? DEFAULT_BASE_URL;
  const today = utcDateOf(env.clock());
  const filters = {
    marketIds: config.markets,
    bookIds: [...config.books.anchors, ...config.books.others],
  };
  const fetcher = env.fetcher();
  let failed = false;
  const requests: Array<Record<string, unknown>> = [];
  const lines: string[] = [];
  for (const entry of config.competitions) {
    const item: FetchPlanItem = {
      url: therundownDayUrl(baseUrl, entry.sportId, today, filters),
      purpose: 'both',
      auth: config.auth,
    };
    lines.push(`GET ${item.url}  (sport ${entry.sportId}, ${entry.competition})`);
    const result = await fetcher.fetch(item, { allowedHosts: config.allowedHosts, sourceKey: id });
    if (result.kind !== 'ok') {
      failed = true;
      const problem = describeFailure(result, item);
      lines.push(`  ${problem}`);
      requests.push({ sportId: entry.sportId, url: item.url, ok: false, problem });
      continue;
    }
    const meters = readResponseMeters(result.headers, env.clock());
    const outcome = parseTherundownEvents(result.body, { allowedMarketIds: config.markets });
    const fatal = outcome.counts.fatal !== undefined;
    if (fatal) failed = true;
    const prices = outcome.events.reduce((sum, event) => sum + event.prices.length, 0);
    const issues = Object.entries(outcome.counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    lines.push(
      `  HTTP ${result.status}, data delay ${show(meters.delayHeader)} s, rate limit ${show(meters.rateLimit)}/s`,
      `  data points: cost ${show(meters.cost)}, used ${show(meters.snapshot?.used ?? null)}, remaining ${show(meters.snapshot?.remaining ?? null)}, reset ${show(meters.snapshot?.resetAt ?? null)}`,
      `  events ${outcome.events.length}, prices kept ${prices}, issues ${issues.length === 0 ? 'none' : issues.map(([code, n]) => `${code} ${n}`).join(', ')}`,
    );
    if (fatal) lines.push(`  the body did not parse: ${outcome.issues[0]?.detail ?? 'unknown'}`);
    requests.push({
      sportId: entry.sportId,
      url: result.url,
      ok: !fatal,
      status: result.status,
      delaySeconds: meters.delayHeader,
      rateLimit: meters.rateLimit,
      dataPoints: {
        cost: meters.cost,
        used: meters.snapshot?.used ?? null,
        remaining: meters.snapshot?.remaining ?? null,
        resetAt: meters.snapshot?.resetAt ?? null,
      },
      events: outcome.events.length,
      pricesKept: prices,
      issues: outcome.counts,
    });
  }
  lines.push('nothing was written to the database or the archive');
  emit(env, parsed, { sourceId: id, date: today, written: false, requests }, lines);
  return failed ? EXIT_FAILED : EXIT_OK;
}

/** `therundown budget`: the budget row (the meters TheRundown last reported, today's spend, the level). */
export async function therundownBudget(args: string[], env: CliEnv): Promise<number> {
  const parsed = parseCommandArgs(args, {});
  noPositionals(parsed);
  const db = await env.database();
  const budget = await getReferenceBudget(db, 'therundown');
  if (budget === null) {
    emit(env, parsed, { budget: null }, ['no budget row yet: the poller has not read a response']);
    return EXIT_OK;
  }
  emit(env, parsed, { budget }, [
    `level        ${budget.level}`,
    `used         ${show(budget.used)}`,
    `remaining    ${show(budget.remaining)}`,
    `resets at    ${show(budget.resetAt)}`,
    `read at      ${show(budget.observedAt)}`,
    `spent today  ${budget.spentToday} (UTC day ${budget.spentDay})`,
    `data delay   ${show(budget.delaySeconds)} s`,
    `rate limit   ${show(budget.rateLimit)}/s`,
    `updated at   ${show(budget.updatedAt)}`,
  ]);
  return EXIT_OK;
}
