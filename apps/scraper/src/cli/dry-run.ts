import { createHash } from 'node:crypto';
import {
  safeParse,
  toRawDocument,
  type FetchPlanItem,
  type FetchResult,
  type ParseOutcome,
  type RawDocument,
  type SourceAdapter,
} from '@vamos/scraper';
import {
  CliFailure,
  EXIT_FAILED,
  EXIT_OK,
  UsageError,
  emit,
  noPositionals,
  optionalString,
  parseCommandArgs,
  readInput,
  requiredString,
  type CliEnv,
  type ParsedArgs,
} from './io';
import { secretProblemMessage } from '../lib/secrets';
import { loadSourceFile } from './source-file';

const DEFAULT_LIMIT = 25;

function limitOf(parsed: ParsedArgs): number {
  const text = optionalString(parsed, 'limit');
  if (text === undefined) return DEFAULT_LIMIT;
  const n = Number(text);
  if (!Number.isInteger(n) || n < 0)
    throw new UsageError('--limit must be a whole number (0 = all)');
  return n === 0 ? Number.POSITIVE_INFINITY : n;
}

function score(s: { home: number; away: number; htHome: number | null; htAway: number | null }) {
  return `${s.home}-${s.away}${s.htHome === null ? '' : ` (ht ${s.htHome}-${s.htAway})`}`;
}

/** Text lines for one parse outcome: counts, the first `limit` observations, every issue. */
export function describeOutcome(outcome: ParseOutcome, limit: number): string[] {
  const lines = [
    `records seen ${outcome.stats.recordsSeen}, accepted ${outcome.stats.recordsAccepted}; ` +
      `${outcome.fixtures.length} fixtures, ${outcome.results.length} results, ` +
      `${outcome.issues.length} issues`,
  ];
  const shown = (kind: string, items: string[]) => {
    for (const item of items.slice(0, limit)) lines.push(`${kind}  ${item}`);
    if (items.length > limit) lines.push(`... ${items.length - limit} more ${kind}s (use --limit)`);
  };
  shown(
    'fixture',
    outcome.fixtures.map(
      (f) =>
        `${f.kickoff.toISOString()}  ${f.competition}: ${f.home} v ${f.away}  [${f.status}]` +
        (f.externalRef === null ? '' : `  ref ${f.externalRef}`),
    ),
  );
  shown(
    'result',
    outcome.results.map(
      (r) =>
        `${r.kickoff.toISOString()}  ${r.competition}: ${r.home} v ${r.away}  [${r.status}` +
        `${r.score === null ? '' : ` ${score(r.score)}`}, ${r.scoreBasis}]` +
        (r.externalRef === null ? '' : `  ref ${r.externalRef}`),
    ),
  );
  for (const issue of outcome.issues) {
    lines.push(
      `${issue.severity}${issue.fatal === true ? ' (fatal)' : ''}  ${issue.code}: ${issue.message}` +
        (issue.context === undefined ? '' : `  ${JSON.stringify(issue.context)}`),
    );
  }
  return lines;
}

const hasFatal = (outcome: ParseOutcome): boolean => outcome.issues.some((i) => i.fatal === true);

/** Parses one document the way the runner does (safeParse never throws). */
function parseDocument(adapter: SourceAdapter, doc: RawDocument): ParseOutcome {
  return safeParse(adapter, doc);
}

function guessContentType(path: string): string {
  if (/\.html?$/i.test(path)) return 'text/html; charset=utf-8';
  return 'application/json';
}

/**
 * `dry-parse --source-file source.json --document page.html`: parses a saved
 * document and prints observations and issues. No database, no network. Exit 1
 * when the config is invalid or the document cannot be understood (fatal issue).
 * `--url` says which planned URL the document stands for (openfootball picks
 * its competition by it; default: the first planned URL); `--at` is the fetch
 * time (default now); `--content-type` overrides the guess from the extension.
 */
export async function dryParse(args: string[], env: CliEnv): Promise<number> {
  const parsed = parseCommandArgs(args, {
    'source-file': { type: 'string' },
    document: { type: 'string' },
    url: { type: 'string' },
    at: { type: 'string' },
    'content-type': { type: 'string' },
    limit: { type: 'string' },
  });
  noPositionals(parsed);
  const limit = limitOf(parsed);
  const documentPath = requiredString(parsed, 'document');
  const { source, adapter } = await loadSourceFile(env, requiredString(parsed, 'source-file'));

  let fetchedAt = env.clock();
  const at = optionalString(parsed, 'at');
  if (at !== undefined) {
    fetchedAt = new Date(at);
    if (Number.isNaN(fetchedAt.getTime())) throw new UsageError('--at must be an ISO date-time');
  }
  const body = await readInput(env, documentPath, 'document');
  const url =
    optionalString(parsed, 'url') ?? adapter.plan(fetchedAt)[0]?.url ?? `file:${documentPath}`;
  const doc: RawDocument = {
    sourceId: source.id,
    url,
    status: 200,
    contentType: optionalString(parsed, 'content-type') ?? guessContentType(documentPath),
    body,
    fetchedAt,
    contentHash: createHash('sha256').update(body).digest('hex'),
  };
  const outcome = parseDocument(adapter, doc);
  emit(env, parsed, { sourceId: source.id, url, ...outcome }, describeOutcome(outcome, limit));
  return hasFatal(outcome) ? EXIT_FAILED : EXIT_OK;
}

function describeFetchFailure(
  result: Exclude<FetchResult, { kind: 'ok' }>,
  item: FetchPlanItem,
): string {
  switch (result.kind) {
    case 'not_modified':
      return 'not modified (304)';
    case 'blocked':
      return `blocked (${result.reason}); the site told us to stop, nothing was worked around`;
    case 'circuit_open':
      return 'circuit open after recent failures';
    case 'refused':
      return result.reason.startsWith('secret_')
        ? `refused (${result.reason}): ${secretProblemMessage(result.reason, item.auth?.secret)}`
        : `refused (${result.reason})`;
    case 'error':
      return `error (${result.code}): ${result.message}`;
  }
}

/**
 * `dry-fetch --source-file source.json`: fetches every planned URL through the
 * PoliteFetcher (host allow-list, robots.txt, rate limit, size and time limits)
 * and parses the answers. Prints; writes NOTHING (no database, no archive).
 * Exit 1 when the config is invalid, a request did not succeed, or a document
 * could not be understood.
 */
export async function dryFetch(args: string[], env: CliEnv): Promise<number> {
  const parsed = parseCommandArgs(args, {
    'source-file': { type: 'string' },
    limit: { type: 'string' },
  });
  noPositionals(parsed);
  const limit = limitOf(parsed);
  const { source, adapter } = await loadSourceFile(env, requiredString(parsed, 'source-file'));
  const plan = adapter.plan(env.clock());
  if (plan.length === 0) throw new CliFailure(`source "${source.id}" plans no requests`);

  const fetcher = env.fetcher();
  let failed = false;
  const requests: Array<Record<string, unknown>> = [];
  const lines: string[] = [];
  for (const item of plan) {
    const result = await fetcher.fetch(item, {
      allowedHosts: adapter.allowedHosts,
      sourceKey: source.id,
    });
    lines.push(`GET ${item.url}  (${item.purpose})`);
    if (result.kind !== 'ok') {
      failed = true;
      const message = describeFetchFailure(result, item);
      lines.push(`  ${message}`);
      requests.push({ url: item.url, purpose: item.purpose, ok: false, problem: message });
      continue;
    }
    const outcome = parseDocument(adapter, toRawDocument(source.id, result));
    if (hasFatal(outcome)) failed = true;
    lines.push(
      `  ${result.status} ${result.contentType ?? 'no content type'}, ${result.body.length} bytes, ` +
        `${result.durationMs} ms, sha256 ${result.contentHash.slice(0, 12)}`,
      ...describeOutcome(outcome, limit).map((l) => `  ${l}`),
    );
    requests.push({
      url: result.url,
      purpose: item.purpose,
      ok: true,
      status: result.status,
      bytes: result.body.length,
      contentHash: result.contentHash,
      ...outcome,
    });
  }
  lines.push('nothing was written to the database or the archive');
  emit(env, parsed, { sourceId: source.id, written: false, requests }, lines);
  return failed ? EXIT_FAILED : EXIT_OK;
}
