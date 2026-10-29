import { z } from 'zod';
import type {
  FetchPlanItem,
  ParseOutcome,
  RawDocument,
  Score,
  SourceAdapter,
  SourceDescriptor,
} from '../types';
import {
  allowedHostsSchema,
  checkRequests,
  cleanName,
  compileStatusMap,
  draftsFor,
  parseEpoch,
  parseIsoInstant,
  parseScoreInt,
  parseTimeText,
  purposeSchema,
  requestAuthSchema,
  requestUrlSchema,
  sportSchema,
  startParse,
  statusKey,
  defaultStatusSchema,
  requireStatusWithScore,
  statusValueSchema,
  statusWhenBlank,
  timeZoneSchema,
  zonedToUtc,
  MAX_RECORDS,
  type SourceStatus,
} from './common';

// ---------------------------------------------------------------------------
// Path syntax (no eval, no JSONPath library):
//   ""              the root value
//   a.b             object keys, separated by dots
//   a[0]            array index
//   a[*]            every element of an array (record paths only)
//   [0].a, data[*].teams.home   combinations; keys never contain '.', '[' or ']'
// Only own properties are read, so '__proto__' and friends are unreachable.

export type PathSegment = { key: string } | { index: number } | { all: true };

const MAX_PATH_LENGTH = 200;
const MAX_SEGMENTS = 16;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function parsePath(
  path: string,
): { ok: true; segments: PathSegment[] } | { ok: false; error: string } {
  if (path.length > MAX_PATH_LENGTH) return { ok: false, error: 'path too long' };
  const segments: PathSegment[] = [];
  let i = 0;
  while (i < path.length) {
    const c = path[i];
    if (c === '[') {
      const end = path.indexOf(']', i);
      if (end < 0) return { ok: false, error: 'unclosed [' };
      const inner = path.slice(i + 1, end);
      if (inner === '*') segments.push({ all: true });
      else if (/^\d{1,6}$/.test(inner)) segments.push({ index: Number(inner) });
      else return { ok: false, error: `bad index [${inner.slice(0, 20)}]` };
      i = end + 1;
      if (i < path.length && path[i] !== '.' && path[i] !== '[')
        return { ok: false, error: 'expected . or [' };
      if (path[i] === '.') i += 1;
      if (i === path.length && path[i - 1] === '.') return { ok: false, error: 'trailing dot' };
    } else {
      let end = i;
      while (end < path.length && path[end] !== '.' && path[end] !== '[' && path[end] !== ']')
        end += 1;
      const key = path.slice(i, end);
      if (key.length === 0 || path[end] === ']') return { ok: false, error: 'empty key' };
      if (FORBIDDEN_KEYS.has(key)) return { ok: false, error: `key ${key} is not allowed` };
      segments.push({ key });
      i = end;
      if (path[i] === '.') {
        i += 1;
        if (i === path.length) return { ok: false, error: 'trailing dot' };
      }
    }
    if (segments.length > MAX_SEGMENTS) return { ok: false, error: 'path too deep' };
  }
  return { ok: true, segments };
}

/** All values a path reaches; `truncated` when [*] expansion hit `limit`. */
export function resolvePath(
  root: unknown,
  segments: readonly PathSegment[],
  limit = MAX_RECORDS + 1,
): { values: unknown[]; truncated: boolean } {
  let frontier: unknown[] = [root];
  let truncated = false;
  for (const seg of segments) {
    const next: unknown[] = [];
    for (const v of frontier) {
      if ('key' in seg) {
        if (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.hasOwn(v, seg.key)) {
          next.push((v as Record<string, unknown>)[seg.key]);
        }
      } else if ('index' in seg) {
        if (Array.isArray(v) && seg.index < v.length) next.push(v[seg.index]);
      } else if (Array.isArray(v)) {
        for (const item of v) {
          if (next.length >= limit) {
            truncated = true;
            break;
          }
          next.push(item);
        }
      }
    }
    frontier = next;
  }
  return { values: frontier, truncated };
}

const pathSchema = z
  .string()
  .max(MAX_PATH_LENGTH)
  .superRefine((p, ctx) => {
    const r = parsePath(p);
    if (!r.ok) ctx.addIssue({ code: 'custom', message: r.error });
    else if (r.segments.some((s) => 'all' in s)) {
      ctx.addIssue({ code: 'custom', message: '[*] is only allowed in recordsPath' });
    }
  });
const recordsPathSchema = z
  .string()
  .max(MAX_PATH_LENGTH)
  .superRefine((p, ctx) => {
    const r = parsePath(p);
    if (!r.ok) ctx.addIssue({ code: 'custom', message: r.error });
    else if (r.segments.filter((s) => 'all' in s).length > 2) {
      ctx.addIssue({ code: 'custom', message: 'at most two [*]' });
    }
  });

const statusMapSchema = z.record(z.string().max(80), statusValueSchema).refine((m) => {
  return Object.keys(m).length <= 100 && compileStatusMap(m).ok;
}, 'status map invalid (more than 100 entries, empty or duplicate keys)');

export const GenericJsonConfigSchema = z
  .strictObject({
    allowedHosts: allowedHostsSchema,
    requests: z
      .array(z.strictObject({ url: requestUrlSchema, purpose: purposeSchema }))
      .min(1)
      .max(20),
    /**
     * An API key sent as a request header: `{ header, secret }`, where `secret` is the NAME of
     * an environment variable (SCRAPER_SECRET_*). At most one header; it goes to the origin of
     * each request URL and is dropped on a redirect to another origin.
     */
    auth: requestAuthSchema.optional(),
    sport: sportSchema,
    recordsPath: recordsPathSchema,
    fields: z.strictObject({
      home: pathSchema,
      away: pathSchema,
      competition: z.union([
        z.strictObject({ fixed: z.string().trim().min(1).max(120) }),
        z.strictObject({ path: pathSchema }),
      ]),
      kickoff: z.union([
        z.strictObject({ path: pathSchema, format: z.enum(['iso', 'epoch_ms', 'epoch_s']) }),
        z.strictObject({ datePath: pathSchema, timePath: pathSchema, timeZone: timeZoneSchema }),
      ]),
      externalRef: pathSchema.optional(),
      round: pathSchema.optional(),
      status: z
        .strictObject({
          path: pathSchema,
          map: statusMapSchema,
          default: defaultStatusSchema.optional(),
        })
        .optional(),
      score: z
        .strictObject({
          homePath: pathSchema,
          awayPath: pathSchema,
          htHomePath: pathSchema.optional(),
          htAwayPath: pathSchema.optional(),
        })
        .optional(),
    }),
    /** What the source's score means. The operator must say; we never assume. */
    scoreBasis: z.enum(['regular_time', 'includes_extra_time', 'unknown']).optional(),
  })
  .superRefine((c, ctx) => {
    checkRequests(c, ctx);
    requireStatusWithScore(c, ctx);
    if (c.fields.score && !c.scoreBasis) {
      ctx.addIssue({
        code: 'custom',
        message: 'scoreBasis is required when a score is configured',
        path: ['scoreBasis'],
      });
    }
    if (!c.fields.score && c.scoreBasis) {
      ctx.addIssue({ code: 'custom', message: 'scoreBasis without a score', path: ['scoreBasis'] });
    }
    const s = c.fields.score;
    if (s && (s.htHomePath === undefined) !== (s.htAwayPath === undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'htHomePath and htAwayPath go together',
        path: ['fields', 'score'],
      });
    }
  });
export type GenericJsonConfig = z.infer<typeof GenericJsonConfigSchema>;

const segs = (p: string): PathSegment[] => {
  const r = parsePath(p);
  return r.ok ? r.segments : [];
};
const one = (record: unknown, path: string): unknown =>
  resolvePath(record, segs(path), 2).values[0];
const text = (v: unknown): string | null =>
  typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null;

export function createGenericJsonAdapter(
  descriptor: SourceDescriptor,
  config: GenericJsonConfig,
): SourceAdapter {
  const f = config.fields;
  const statusLookup = f.status ? compileStatusMap(f.status.map) : null;
  return {
    descriptor,
    allowedHosts: config.allowedHosts,
    plan(): FetchPlanItem[] {
      return config.requests.map((r) => ({
        url: r.url,
        purpose: r.purpose,
        // A reference only: the fetcher reads the value when it fetches.
        ...(config.auth
          ? { auth: { header: config.auth.header, secret: config.auth.secret } }
          : {}),
      }));
    },
    parse(doc: RawDocument): ParseOutcome {
      const { collector, usable } = startParse(descriptor.id, doc);
      if (!usable) return collector.outcome();
      let json: unknown;
      try {
        json = JSON.parse(doc.body);
      } catch {
        collector.fatal('bad_json', 'the document is not JSON');
        return collector.outcome();
      }
      const found = resolvePath(json, segs(config.recordsPath));
      const only = found.values.length === 1 ? found.values[0] : undefined;
      const records = config.recordsPath.includes('[*]')
        ? found.values
        : Array.isArray(only)
          ? only
          : null;
      if (
        !records ||
        (config.recordsPath.includes('[*]') &&
          found.values.length === 0 &&
          !hasParent(json, config.recordsPath))
      ) {
        collector.fatal('records_not_found', 'recordsPath does not lead to a list of records');
        return collector.outcome();
      }
      if (found.truncated)
        collector.issue('error', 'record_limit', 'too many records; the rest are ignored');
      records.forEach((rec, index) => {
        if (!collector.beginRecord()) return;
        const ctx = { index };
        if (typeof rec !== 'object' || rec === null || Array.isArray(rec)) {
          collector.issue('error', 'bad_record', 'a record must be an object', ctx);
          return;
        }
        const home = cleanName(one(rec, f.home));
        const away = cleanName(one(rec, f.away));
        const competition = cleanName(
          'fixed' in f.competition ? f.competition.fixed : one(rec, f.competition.path),
        );
        if (!home || !away) {
          collector.issue('error', 'bad_name', 'home and away must be non-empty strings', ctx);
          return;
        }
        if (!competition) {
          collector.issue('error', 'bad_name', 'competition missing', { ...ctx, home, away });
          return;
        }
        const named = { ...ctx, home, away };
        // Kickoff
        let kickoff: Date | null;
        const k = f.kickoff;
        if ('path' in k) {
          const v = one(rec, k.path);
          kickoff =
            k.format === 'iso'
              ? typeof v === 'string'
                ? parseIsoInstant(v)
                : null
              : parseEpoch(v, k.format === 'epoch_ms' ? 'ms' : 's');
          if (!kickoff) {
            collector.issue('error', 'bad_time', `kickoff is not a valid ${k.format} value`, {
              ...named,
              value: v,
            });
            return;
          }
        } else {
          const d = one(rec, k.datePath);
          const t =
            typeof one(rec, k.timePath) === 'string'
              ? parseTimeText(one(rec, k.timePath) as string)
              : null;
          if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d) || !t) {
            collector.issue('error', 'bad_time', 'date must be YYYY-MM-DD and time HH:mm', {
              ...named,
              date: d,
            });
            return;
          }
          const z = zonedToUtc({ date: d, time: t, timeZone: k.timeZone });
          if (!z.ok) {
            collector.issue('error', 'bad_time', `kickoff rejected: ${z.reason}`, {
              ...named,
              date: d,
              time: t,
            });
            return;
          }
          kickoff = z.instant;
        }
        // Score
        let score: Score | null = null;
        if (f.score) {
          const h = one(rec, f.score.homePath);
          const a = one(rec, f.score.awayPath);
          if ((h !== undefined && h !== null) || (a !== undefined && a !== null)) {
            const hh = parseScoreInt(h);
            const aa = parseScoreInt(a);
            if (hh === null || aa === null) {
              collector.issue(
                'error',
                'bad_score',
                'score must be non-negative integers or plain digits',
                { ...named, home_score: h, away_score: a },
              );
              return;
            }
            let htH: number | null = null;
            let htA: number | null = null;
            if (f.score.htHomePath && f.score.htAwayPath) {
              const x = one(rec, f.score.htHomePath);
              const y = one(rec, f.score.htAwayPath);
              if ((x ?? null) !== null || (y ?? null) !== null) {
                htH = parseScoreInt(x);
                htA = parseScoreInt(y);
                if (htH === null || htA === null) {
                  collector.issue(
                    'error',
                    'bad_score',
                    'half-time score must be non-negative integers',
                    named,
                  );
                  return;
                }
              }
            }
            score = { home: hh, away: aa, htHome: htH, htAway: htA };
          }
        }
        // Status
        let status: SourceStatus | null = null;
        if (f.status && statusLookup?.ok) {
          const v = text(one(rec, f.status.path));
          if (v !== null && v.trim() !== '') {
            status = statusLookup.lookup.get(statusKey(v)) ?? null;
            if (!status) {
              collector.issue('error', 'unknown_status', 'status value is not in the status map', {
                ...named,
                value: v,
              });
              return;
            }
          }
        }
        // Never derive 'finished' from a score: a live score looks like a final one.
        status ??= statusWhenBlank(f.score !== undefined, f.status?.default);
        if (status === null) {
          collector.issue('error', 'missing_status', 'the record has no status', named);
          return;
        }
        const refRaw = f.externalRef ? one(rec, f.externalRef) : null;
        const ref = text(refRaw)?.trim().slice(0, 200) || null;
        const roundRaw = f.round ? text(one(rec, f.round)) : null;
        const drafts = draftsFor({
          home,
          away,
          competition,
          kickoff,
          externalRef: ref,
          round: roundRaw ? (cleanName(roundRaw)?.slice(0, 80) ?? null) : null,
          status,
          score,
          scoreBasis: config.scoreBasis ?? null,
        });
        if (!Array.isArray(drafts)) {
          collector.issue('error', drafts.code, drafts.message, named);
          return;
        }
        collector.accept(drafts, named);
      });
      return collector.outcome();
    },
  };
}

/** For `a[*]` paths: does the prefix before the last [*] exist (an empty list is fine)? */
function hasParent(json: unknown, path: string): boolean {
  const r = parsePath(path);
  if (!r.ok) return false;
  const last = r.segments.map((s) => 'all' in s).lastIndexOf(true);
  const v = resolvePath(json, r.segments.slice(0, last)).values;
  return v.some((x) => Array.isArray(x));
}
