import { runInNewContext } from 'node:vm';
import type { ScrapeFixtureStatus, ScrapeResultStatus, ScrapeScoreBasis } from '@vamos/core';
import { z } from 'zod';
import {
  FixtureObservationSchema,
  ResultObservationSchema,
  type FixtureObservation,
  type ParseIssue,
  type ParseOutcome,
  type RawDocument,
  type ResultObservation,
  type Score,
  type SourceAdapter,
} from '../types';
import { authHeaderProblem, SECRET_NAME_RE } from '../fetch/auth';
import { isValidTimeZone, zonedToUtc } from '../normalize';

export { isValidTimeZone, zonedToUtc };

// ---------------------------------------------------------------------------
// Limits. Pages come from the open internet: every loop and buffer is bounded.

/** A larger document is not parsed at all (fatal issue). */
export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
/** Candidate records examined per document; the rest are ignored with an issue. */
export const MAX_RECORDS = 5000;
/** Issues kept per document, the summary issue included. */
export const MAX_ISSUES = 50;
/** Longest regex source an operator may configure. */
export const MAX_REGEX_LENGTH = 200;
/** Size of each adversarial input a configured regex is tested against. */
export const REGEX_TEST_INPUT_LENGTH = 100 * 1024;
/** Time a configured regex gets, in total, for all test inputs. */
export const REGEX_TIME_BUDGET_MS = 250;
/** Longest piece of text read from one field (a team name is capped at 120 later). */
export const MAX_FIELD_TEXT = 500;

// ---------------------------------------------------------------------------
// Text

// Control characters, plus the invisible bidi/zero-width characters that can
// make a name display as something else. ZWNJ/ZWJ stay: Persian and Indic
// names need them.
const STRIPPED = /[\p{Cc}\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu;

/** Strips control characters, collapses whitespace, caps the length. */
export function cleanText(value: string, max = MAX_FIELD_TEXT): string {
  return value.replace(STRIPPED, ' ').replace(/\s+/gu, ' ').trim().slice(0, max);
}

/** A team or competition name: text, cleaned. Null when nothing usable is left. */
export function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = cleanText(value.replace(STRIPPED, ''), MAX_FIELD_TEXT);
  return cleaned.length === 0 ? null : cleaned;
}

function clipContextValue(value: unknown): unknown {
  if (typeof value === 'string') return value.length > 120 ? `${value.slice(0, 120)}…` : value;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value === undefined) return null;
  try {
    return clipContextValue(JSON.stringify(value) ?? '[unprintable]');
  } catch {
    return '[unprintable]';
  }
}

// ---------------------------------------------------------------------------
// Collecting results

export type FixtureDraft = Omit<FixtureObservation, 'sourceId' | 'observedAt'>;
export type ResultDraft = Omit<ResultObservation, 'sourceId' | 'observedAt'>;
export type ObservationDraft = FixtureDraft | ResultDraft;

/**
 * Collects what one `parse` call finds. It owns the counters (so
 * `recordsAccepted <= recordsSeen` holds by construction), the cap on issues
 * (a hostile page cannot make unbounded output), and the zod validation of
 * every record: an invalid record is dropped with an issue, never repaired.
 */
export class ParseCollector {
  private readonly fixtures: FixtureObservation[] = [];
  private readonly results: ResultObservation[] = [];
  private readonly issues: ParseIssue[] = [];
  private fatalIssue: ParseIssue | null = null;
  private suppressed = 0;
  private seen = 0;
  private accepted = 0;
  private recordOpen = false;
  private capReported = false;

  constructor(
    readonly sourceId: string,
    readonly observedAt: Date,
  ) {}

  get recordsSeen(): number {
    return this.seen;
  }

  /**
   * Starts a candidate record. Returns false once MAX_RECORDS candidates were
   * seen: the caller stops looping (and an issue says so, once).
   */
  beginRecord(): boolean {
    if (this.seen >= MAX_RECORDS) {
      if (!this.capReported) {
        this.capReported = true;
        this.issue(
          'error',
          'record_limit',
          `more than ${MAX_RECORDS} records; the rest are ignored`,
        );
      }
      this.recordOpen = false;
      return false;
    }
    this.seen += 1;
    this.recordOpen = true;
    return true;
  }

  issue(
    severity: ParseIssue['severity'],
    code: string,
    message: string,
    context?: Record<string, unknown>,
  ): void {
    if (this.issues.length >= MAX_ISSUES) {
      this.suppressed += 1;
      return;
    }
    const issue: ParseIssue = { severity, code, message: message.slice(0, 300) };
    if (context) {
      issue.context = Object.fromEntries(
        Object.entries(context).map(([k, v]) => [k, clipContextValue(v)]),
      );
    }
    this.issues.push(issue);
  }

  /** The document as a whole cannot be understood. The outcome then has no records. */
  fatal(code: string, message: string, context?: Record<string, unknown>): void {
    if (this.fatalIssue) return;
    this.fatalIssue = { severity: 'error', code, message: message.slice(0, 300), fatal: true };
    if (context) {
      this.fatalIssue.context = Object.fromEntries(
        Object.entries(context).map(([k, v]) => [k, clipContextValue(v)]),
      );
    }
  }

  get isFatal(): boolean {
    return this.fatalIssue !== null;
  }

  /**
   * Validates the drafts of the open record (one or two observations) with the
   * schemas of types.ts. All or nothing: if any draft is invalid the record is
   * dropped with a precise issue. Returns whether the record was accepted.
   */
  accept(drafts: ObservationDraft[], context: Record<string, unknown>): boolean {
    if (!this.recordOpen) return false;
    const fixtures: FixtureObservation[] = [];
    const results: ResultObservation[] = [];
    for (const draft of drafts) {
      const full = { ...draft, sourceId: this.sourceId, observedAt: this.observedAt };
      if (draft.kind === 'fixture') {
        const parsed = FixtureObservationSchema.safeParse(full);
        if (!parsed.success) return this.reject(parsed.error, context);
        fixtures.push(parsed.data);
      } else {
        const parsed = ResultObservationSchema.safeParse(full);
        if (!parsed.success) return this.reject(parsed.error, context);
        results.push(parsed.data);
      }
    }
    this.fixtures.push(...fixtures);
    this.results.push(...results);
    this.accepted += 1;
    this.recordOpen = false;
    return true;
  }

  private reject(error: z.ZodError, context: Record<string, unknown>): false {
    const detail = error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || 'record'}: ${i.message}`)
      .join('; ');
    this.issue('error', 'invalid_record', `record dropped: ${detail}`, context);
    this.recordOpen = false;
    return false;
  }

  outcome(): ParseOutcome {
    let issues: ParseIssue[] = this.fatalIssue
      ? [this.fatalIssue, ...this.issues]
      : [...this.issues];
    let suppressed = this.suppressed;
    if (issues.length > MAX_ISSUES) {
      suppressed += issues.length - (MAX_ISSUES - 1);
      issues = issues.slice(0, MAX_ISSUES - 1);
    }
    if (suppressed > 0) {
      if (issues.length >= MAX_ISSUES) {
        suppressed += issues.length - (MAX_ISSUES - 1);
        issues = issues.slice(0, MAX_ISSUES - 1);
      }
      issues.push({
        severity: 'warning',
        code: 'issues_truncated',
        message: `${suppressed} further issues were not listed`,
        context: { suppressed },
      });
    }
    const dead = this.fatalIssue !== null;
    return {
      fixtures: dead ? [] : this.fixtures,
      results: dead ? [] : this.results,
      issues,
      stats: { recordsSeen: this.seen, recordsAccepted: dead ? 0 : this.accepted },
    };
  }
}

/** A problem that makes the whole document unusable, or null. */
export function documentProblem(doc: RawDocument): { code: string; message: string } | null {
  if (typeof doc.body !== 'string') return { code: 'bad_body', message: 'the body is not text' };
  if (!(doc.fetchedAt instanceof Date) || Number.isNaN(doc.fetchedAt.getTime())) {
    return { code: 'bad_fetched_at', message: 'the fetch time is not a valid date' };
  }
  // UTF-8 never takes fewer bytes than characters, nor more than 3 per UTF-16 unit.
  const tooBig =
    doc.body.length > MAX_DOCUMENT_BYTES ||
    (doc.body.length * 3 > MAX_DOCUMENT_BYTES &&
      new TextEncoder().encode(doc.body).length > MAX_DOCUMENT_BYTES);
  if (tooBig) {
    return {
      code: 'document_too_large',
      message: `the document is over ${MAX_DOCUMENT_BYTES} bytes`,
    };
  }
  if (doc.body.trim().length === 0)
    return { code: 'empty_document', message: 'the document is empty' };
  return null;
}

/** Starts a collector for a document, or a finished fatal outcome when the document is unusable. */
export function startParse(
  sourceId: string,
  doc: RawDocument,
): { collector: ParseCollector; usable: boolean } {
  const fetchedAt = doc.fetchedAt instanceof Date ? doc.fetchedAt : new Date(Number.NaN);
  const collector = new ParseCollector(sourceId, fetchedAt);
  const problem = documentProblem(doc);
  if (problem) {
    collector.fatal(problem.code, problem.message, { url: doc.url });
    return { collector, usable: false };
  }
  return { collector, usable: true };
}

/**
 * Calls `adapter.parse` and turns anything it throws into a fatal issue. Adapters
 * are written not to throw; this is the belt to their braces, so one surprising
 * page can never take the runner down.
 */
export function safeParse(adapter: SourceAdapter, doc: RawDocument): ParseOutcome {
  try {
    const problem = documentProblem(doc);
    if (problem) {
      const c = new ParseCollector(adapter.descriptor.id, new Date(0));
      c.fatal(problem.code, problem.message);
      return c.outcome();
    }
    const out = adapter.parse(doc);
    const seen = Math.max(0, out.stats.recordsSeen);
    return {
      ...out,
      stats: { recordsSeen: seen, recordsAccepted: Math.min(out.stats.recordsAccepted, seen) },
    };
  } catch (error) {
    const c = new ParseCollector(adapter.descriptor.id, new Date(0));
    c.fatal(
      'parser_crashed',
      `adapter threw: ${error instanceof Error ? error.message : String(error)}`,
    );
    return c.outcome();
  }
}

// ---------------------------------------------------------------------------
// Turning one source record into observations

export type SourceStatus = ScrapeFixtureStatus | ScrapeResultStatus;
export const SOURCE_STATUSES = [
  'scheduled',
  'postponed',
  'cancelled',
  'finished',
  'abandoned',
] as const;

export interface RecordParts {
  home: string;
  away: string;
  competition: string;
  kickoff: Date;
  externalRef: string | null;
  round: string | null;
  status: SourceStatus;
  score: Score | null;
  /** Null when the source config has no score at all. */
  scoreBasis: ScrapeScoreBasis | null;
}

/**
 * What a record's status means for the observations:
 * scheduled -> a fixture; finished / abandoned -> a result; postponed and
 * cancelled -> both a fixture and a result with no score (the rules for
 * cancellations read either kind, and a duplicate review item is deduplicated
 * by its subject key). A finished match without a score is not repaired.
 */
export function draftsFor(p: RecordParts): ObservationDraft[] | { code: string; message: string } {
  const base = {
    externalRef: p.externalRef,
    sport: 'football' as const,
    competition: p.competition,
    home: p.home,
    away: p.away,
    kickoff: p.kickoff,
  };
  const fixture = (status: ScrapeFixtureStatus): FixtureDraft => ({
    kind: 'fixture',
    ...base,
    status,
    round: p.round,
  });
  const result = (status: ScrapeResultStatus, score: Score | null): ResultDraft => ({
    kind: 'result',
    ...base,
    status,
    score,
    scoreBasis: p.scoreBasis ?? 'unknown',
  });
  switch (p.status) {
    case 'scheduled':
      return [fixture('scheduled')];
    case 'finished':
      if (!p.score) return { code: 'missing_score', message: 'finished match without a score' };
      return [result('finished', p.score)];
    case 'abandoned':
      return [result('abandoned', null)];
    case 'postponed':
    case 'cancelled':
      return [fixture(p.status), result(p.status, null)];
  }
}

// ---------------------------------------------------------------------------
// Numbers and scores

/**
 * A score component: a non-negative integer, or a string of plain ASCII digits
 * (at most 3). Anything else ("2.5", "-1", " 2", "2 (pen)", "٣") is not a score.
 */
export function parseScoreInt(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'string' && /^[0-9]{1,3}$/.test(value)) return Number(value);
  return null;
}

// ---------------------------------------------------------------------------
// Dates and times (never guessed: rule T1)

const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}(?::?\d{2})?)$/;

function validCalendar(y: number, mo: number, d: number): boolean {
  if (mo < 1 || mo > 12 || d < 1) return false;
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
}

/** Parses an ISO-8601 instant that states its offset (Z or +hh:mm). No offset, no instant. */
export function parseIsoInstant(text: string): Date | null {
  const m = ISO_INSTANT.exec(text.trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const s = Number(m[6] ?? '0');
  if (!validCalendar(y, mo, d) || h > 23 || mi > 59 || s > 59) return null;
  let offsetMin = 0;
  const off = m[7] as string;
  if (off !== 'Z') {
    const digits = off.replace(':', '');
    const oh = Number(digits.slice(1, 3));
    const om = Number(digits.slice(3, 5) || '0');
    if (oh > 14 || om > 59) return null;
    offsetMin = (digits[0] === '-' ? -1 : 1) * (oh * 60 + om);
  }
  const ms = Date.UTC(y, mo - 1, d, h, mi, s) - offsetMin * 60_000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A local ISO date-time with no offset, split into the parts `zonedToUtc` needs. */
export function parseLocalIso(text: string): { date: string; time: string } | null {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::00(?:\.0+)?)?$/.exec(text.trim());
  return m ? { date: m[1] as string, time: m[2] as string } : null;
}

export const DATE_FORMATS = ['YYYY-MM-DD', 'DD/MM/YYYY', 'DD.MM.YYYY', 'MMM D, YYYY'] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

/** Date text in one of the supported formats to 'YYYY-MM-DD', or null (also for 31 February). */
export function parseDateText(text: string, format: DateFormat): string | null {
  const t = text.trim();
  let y: number;
  let mo: number;
  let d: number;
  let m: RegExpExecArray | null;
  switch (format) {
    case 'YYYY-MM-DD':
      m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
      if (!m) return null;
      [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      break;
    case 'DD/MM/YYYY':
      m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
      if (!m) return null;
      [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
      break;
    case 'DD.MM.YYYY':
      m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(t);
      if (!m) return null;
      [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
      break;
    case 'MMM D, YYYY': {
      m = /^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})$/.exec(t);
      if (!m) return null;
      const month = MONTHS[(m[1] as string).toLowerCase()];
      if (month === undefined) return null;
      [y, mo, d] = [Number(m[3]), month, Number(m[2])];
      break;
    }
  }
  return validCalendar(y, mo, d) ? `${pad(y, 4)}-${pad(mo, 2)}-${pad(d, 2)}` : null;
}

/** 'H:mm' or 'HH:mm' (optionally ':00' seconds) to 'HH:mm'. */
export function parseTimeText(text: string): string | null {
  const m = /^(\d{1,2}):(\d{2})(?::00)?$/.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h > 23 || mi > 59 ? null : `${pad(h, 2)}:${pad(mi, 2)}`;
}

/** Epoch seconds or milliseconds to a Date (an integer, or plain digits). */
export function parseEpoch(value: unknown, unit: 'ms' | 's'): Date | null {
  let n: number;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && /^[0-9]{1,16}$/.test(value)) n = Number(value);
  else return null;
  if (!Number.isSafeInteger(n) || n < 0) return null;
  const date = new Date(unit === 's' ? n * 1000 : n);
  return Number.isNaN(date.getTime()) ? null : date;
}

// ---------------------------------------------------------------------------
// Config building blocks (spec rule S3: every request host is on the allow-list)

const hostSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/, 'a lower-case host name, no scheme, port or wildcard');

export const allowedHostsSchema = z
  .array(hostSchema)
  .min(1, 'allowedHosts must list at least one host')
  .max(20);

export const sportSchema = z.literal('football').default('football');

export const timeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((tz) => isValidTimeZone(tz), 'not a valid IANA time zone');

export const purposeSchema = z.enum(['fixtures', 'results', 'both']).default('both');

/** A URL problem (not https, credentials, host off the allow-list), or null. */
export function urlProblem(raw: string, allowedHosts: readonly string[]): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'not a valid URL';
  }
  if (url.protocol !== 'https:') return 'only https URLs are allowed';
  if (url.username || url.password) return 'URLs must not carry credentials';
  if (!allowedHosts.includes(url.hostname.toLowerCase())) {
    return `host ${url.hostname} is not in allowedHosts`;
  }
  return null;
}

/** superRefine for any config with `allowedHosts` and `requests[].url`. */
export function checkRequests(
  config: { allowedHosts: string[]; requests: { url: string }[] },
  ctx: z.RefinementCtx,
): void {
  config.requests.forEach((request, i) => {
    const problem = urlProblem(request.url, config.allowedHosts);
    if (problem) {
      ctx.addIssue({ code: 'custom', message: problem, path: ['requests', i, 'url'] });
    }
  });
}

export const requestUrlSchema = z.string().min(1).max(2000);

/**
 * How a source sends an API key (docs/scraper.md 6.7): one header, whose VALUE the fetcher
 * reads from the environment variable named in `secret`. The config holds only that name, so
 * the database, the audit trail and every error message built from the config never hold a key.
 * Messages never repeat what was configured: a key pasted into the wrong field must not leak
 * through the error that refuses it.
 */
export const requestAuthSchema = z.strictObject({
  header: z
    .string()
    .max(64, 'header: at most 64 characters')
    .superRefine((name, ctx) => {
      const problem = authHeaderProblem(name);
      if (problem !== null) ctx.addIssue({ code: 'custom', message: problem });
    }),
  secret: z
    .string()
    .regex(
      SECRET_NAME_RE,
      'must be the NAME of an environment variable matching ^SCRAPER_SECRET_[A-Z0-9_]{1,64}$ (the key itself never goes in the config)',
    ),
});
export type RequestAuth = z.infer<typeof requestAuthSchema>;

/** Flattens zod errors to the strings `createAdapter` returns. */
export function zodErrors(error: z.ZodError): string[] {
  return error.issues.slice(0, 20).map((i) => `${i.path.join('.') || 'config'}: ${i.message}`);
}

// ---------------------------------------------------------------------------
// Operator-supplied regexes: bounded, tested, never trusted

/** Nested or alternating quantified groups and back-references are where backtracking explodes. */
const RISKY = /\((?:[^()\\]|\\.)*[*+{|](?:[^()\\]|\\.)*\)[*+{]|\\[1-9]|\\k</;

function adversarialInputs(): string[] {
  const n = REGEX_TEST_INPUT_LENGTH;
  return [
    'a'.repeat(n),
    `${'a'.repeat(n)}!`,
    `${' '.repeat(n)}x`,
    '-'.repeat(n),
    '1-'.repeat(n / 2),
    `${'1 '.repeat(n / 2)}x`,
    '0:'.repeat(n / 2),
  ];
}

/**
 * Checks a regex an operator wrote into a source config. Returns an error
 * message, or null when it is acceptable: at most 200 characters, valid, at
 * least `minGroups` capture groups, no nested quantifiers or back-references,
 * and it finishes on 100 KB adversarial inputs within a time budget (run in a
 * vm with a watchdog, so a runaway pattern is interrupted, not waited for).
 */
export function regexProblem(source: string, minGroups: number): string | null {
  if (source.length === 0 || source.length > MAX_REGEX_LENGTH) {
    return `a regex must have 1 to ${MAX_REGEX_LENGTH} characters`;
  }
  if (RISKY.test(source)) return 'regex rejected: nested quantifiers or back-references';
  let groups: number;
  try {
    groups = (new RegExp(`${source}|`).exec('') ?? []).length - 1;
  } catch {
    return 'regex does not compile';
  }
  if (groups < minGroups) return `regex needs at least ${minGroups} capture groups`;
  try {
    runInNewContext(
      'const re = new RegExp(src); for (const s of inputs) re.exec(s);',
      { src: source, inputs: adversarialInputs() },
      { timeout: REGEX_TIME_BUDGET_MS },
    );
  } catch {
    return `regex rejected: too slow on a ${REGEX_TEST_INPUT_LENGTH / 1024} KB input`;
  }
  return null;
}

/** A zod string for an operator regex. */
export function regexSchema(minGroups: number): z.ZodString {
  return z.string().superRefine((source, ctx) => {
    const problem = regexProblem(source, minGroups);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });
}

/** Normalised key for status maps: source values compare case-insensitively, trimmed. */
export function statusKey(text: string): string {
  return cleanText(text, 80).toLowerCase();
}

export const statusValueSchema = z.enum(SOURCE_STATUSES);

/**
 * The status used when a record gives none (`status.default`). Never 'finished':
 * a score alone, or a blank status, must not settle a match (review finding 4).
 */
export const defaultStatusSchema = statusValueSchema.refine((v) => v !== 'finished', {
  message: "a default status must not be 'finished'",
});

/**
 * The status of a record whose status field gave nothing (missing, null or
 * blank). With a score configured the source must say what state the match is
 * in: the configured default, else null (the record is dropped as
 * `missing_status`). Without a score the record is just a fixture: 'scheduled'.
 * 'finished' is never derived (a live score looks like a final one).
 */
export function statusWhenBlank(
  scoreConfigured: boolean,
  configuredDefault: SourceStatus | undefined,
): SourceStatus | null {
  if (configuredDefault !== undefined) return configuredDefault;
  return scoreConfigured ? null : 'scheduled';
}

/** Superrefine check: a configured score needs a status field to tell live from final. */
export function requireStatusWithScore(
  c: { fields: { score?: unknown; status?: unknown } },
  ctx: z.RefinementCtx,
): void {
  if (c.fields.score && !c.fields.status) {
    ctx.addIssue({
      code: 'custom',
      message: 'a status field (with a map) is required when a score is configured',
      path: ['fields', 'status'],
    });
  }
}

/** Builds the lookup of a configured status map; duplicate keys after normalising are an error. */
export function compileStatusMap(
  map: Record<string, SourceStatus>,
): { ok: true; lookup: Map<string, SourceStatus> } | { ok: false; error: string } {
  const lookup = new Map<string, SourceStatus>();
  for (const [key, value] of Object.entries(map)) {
    const k = statusKey(key);
    if (k.length === 0) return { ok: false, error: 'empty status key' };
    if (lookup.has(k) && lookup.get(k) !== value) {
      return { ok: false, error: `status "${k}" is mapped twice` };
    }
    lookup.set(k, value);
  }
  return { ok: true, lookup };
}

export function issueContext(
  index: number,
  parts: Record<string, unknown> = {},
): Record<string, unknown> {
  return { index, ...parts };
}
