import * as cheerio from 'cheerio';
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
  DATE_FORMATS,
  MAX_FIELD_TEXT,
  allowedHostsSchema,
  checkRequests,
  cleanName,
  cleanText,
  compileStatusMap,
  draftsFor,
  parseDateText,
  parseIsoInstant,
  parseScoreInt,
  parseTimeText,
  purposeSchema,
  regexSchema,
  requestUrlSchema,
  sportSchema,
  startParse,
  statusKey,
  statusValueSchema,
  timeZoneSchema,
  zonedToUtc,
  type SourceStatus,
} from './common';

/** Where a value sits inside an item: a selector (default: the item itself) and an attribute (default: its text). */
const refShape = {
  selector: z.string().min(1).max(200).optional(),
  attr: z
    .string()
    .regex(/^[a-zA-Z][a-zA-Z0-9_:-]{0,40}$/)
    .optional(),
};
const hasSelectorOrAttr = (r: {
  selector?: string | undefined;
  attr?: string | undefined;
}): boolean => r.selector !== undefined || r.attr !== undefined;
const refWith = <T extends z.ZodRawShape>(extra: T) =>
  z
    .strictObject({ ...refShape, ...extra })
    .refine((r) => hasSelectorOrAttr(r as Ref), 'needs a selector or an attr');
const refSchema = refWith({});

const DEFAULT_SCORE_REGEX = '(\\d+)\\s*[-:]\\s*(\\d+)';

const selectorWorks = (s: string | undefined): boolean => {
  if (s === undefined) return true;
  try {
    cheerio.load('<div><p></p></div>')(s);
    return true;
  } catch {
    return false;
  }
};

const scoreRef = refWith({ regex: regexSchema(2).default(DEFAULT_SCORE_REGEX) });

export const GenericHtmlConfigSchema = z
  .strictObject({
    allowedHosts: allowedHostsSchema,
    requests: z
      .array(z.strictObject({ url: requestUrlSchema, purpose: purposeSchema }))
      .min(1)
      .max(20),
    sport: sportSchema,
    itemSelector: z.string().min(1).max(200),
    fields: z.strictObject({
      home: refSchema,
      away: refSchema,
      competition: z.union([
        z.strictObject({ fixed: z.string().trim().min(1).max(120) }),
        refSchema,
      ]),
      kickoff: z.union([
        refWith({ format: z.literal('iso') }),
        z.strictObject({
          date: refWith({ format: z.enum(DATE_FORMATS) }),
          time: refSchema,
          timeZone: timeZoneSchema,
        }),
      ]),
      externalRef: refSchema.optional(),
      round: refSchema.optional(),
      status: refWith({
        map: z.record(z.string().max(80), statusValueSchema),
        default: statusValueSchema.optional(),
      }).optional(),
      score: scoreRef.optional(),
      /** Half-time score, same rules as `score`. */
      halfTime: scoreRef.optional(),
    }),
    scoreBasis: z.enum(['regular_time', 'includes_extra_time', 'unknown']).optional(),
  })
  .superRefine((c, ctx) => {
    checkRequests(c, ctx);
    if (c.fields.score && !c.scoreBasis) {
      ctx.addIssue({
        code: 'custom',
        message: 'scoreBasis is required when a score is configured',
        path: ['scoreBasis'],
      });
    }
    if (!c.fields.score && (c.scoreBasis || c.fields.halfTime)) {
      ctx.addIssue({
        code: 'custom',
        message: 'scoreBasis / halfTime need a score',
        path: ['scoreBasis'],
      });
    }
    const selectors: (string | undefined)[] = [c.itemSelector];
    const walk = (v: unknown): void => {
      if (typeof v !== 'object' || v === null) return;
      for (const [k, x] of Object.entries(v)) {
        if (k === 'selector' && typeof x === 'string') selectors.push(x);
        else walk(x);
      }
    };
    walk(c.fields);
    if (!selectors.every(selectorWorks)) {
      ctx.addIssue({
        code: 'custom',
        message: 'a CSS selector does not compile',
        path: ['itemSelector'],
      });
    }
    if (c.fields.status && !compileStatusMap(c.fields.status.map).ok) {
      ctx.addIssue({
        code: 'custom',
        message: 'status map invalid',
        path: ['fields', 'status', 'map'],
      });
    }
  });
export type GenericHtmlConfig = z.infer<typeof GenericHtmlConfigSchema>;

type Ref = { selector?: string | undefined; attr?: string | undefined };

export function createGenericHtmlAdapter(
  descriptor: SourceDescriptor,
  config: GenericHtmlConfig,
): SourceAdapter {
  const f = config.fields;
  const statusLookup = f.status ? compileStatusMap(f.status.map) : null;
  return {
    descriptor,
    allowedHosts: config.allowedHosts,
    plan(): FetchPlanItem[] {
      return config.requests.map((r) => ({ url: r.url, purpose: r.purpose }));
    },
    parse(doc: RawDocument): ParseOutcome {
      const { collector, usable } = startParse(descriptor.id, doc);
      if (!usable) return collector.outcome();
      // cheerio only parses; scripts in the page are never run.
      const $ = cheerio.load(doc.body);
      const items = $(config.itemSelector);
      if (items.length === 0) {
        collector.fatal('no_items', 'itemSelector matched nothing: the markup may have changed');
        return collector.outcome();
      }
      const read = (item: cheerio.Cheerio<never>, ref: Ref): string | null => {
        const el = ref.selector ? item.find(ref.selector).first() : item;
        if (el.length === 0) return null;
        const raw = ref.attr ? el.attr(ref.attr) : el.text();
        if (raw === undefined) return null;
        const t = cleanText(raw, MAX_FIELD_TEXT);
        return t === '' ? null : t;
      };
      const pair = (
        text: string | null,
        regex: string,
      ): { ok: true; v: [number, number] | null } | { ok: false } => {
        if (text === null) return { ok: true, v: null };
        const m = new RegExp(regex).exec(text);
        const a = m ? parseScoreInt(m[1]) : null;
        const b = m ? parseScoreInt(m[2]) : null;
        return a === null || b === null ? { ok: false } : { ok: true, v: [a, b] };
      };
      items.slice(0, 10_000).each((index, node) => {
        if (!collector.beginRecord()) return false;
        const item = $(node) as unknown as cheerio.Cheerio<never>;
        const ctx = { index };
        const home = cleanName(read(item, f.home));
        const away = cleanName(read(item, f.away));
        const competition = cleanName(
          'fixed' in f.competition ? f.competition.fixed : read(item, f.competition),
        );
        if (!home || !away) {
          collector.issue('error', 'bad_name', 'home and away not found', ctx);
          return;
        }
        if (!competition) {
          collector.issue('error', 'bad_name', 'competition not found', { ...ctx, home, away });
          return;
        }
        const named = { ...ctx, home, away };
        let kickoff: Date | null;
        const k = f.kickoff;
        if ('format' in k) {
          const t = read(item, k);
          kickoff = t ? parseIsoInstant(t) : null;
          if (!kickoff) {
            collector.issue('error', 'bad_time', 'kickoff is not an ISO instant with an offset', {
              ...named,
              value: t,
            });
            return;
          }
        } else {
          const dt = read(item, k.date);
          const tt = read(item, k.time);
          const d = dt ? parseDateText(dt, k.date.format) : null;
          const t = tt ? parseTimeText(tt) : null;
          if (!d || !t) {
            collector.issue(
              'error',
              'bad_time',
              `date (${k.date.format}) or time (HH:mm) not understood`,
              { ...named, date: dt, time: tt },
            );
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
        let score: Score | null = null;
        if (f.score) {
          const s = pair(read(item, f.score), f.score.regex);
          if (!s.ok) {
            collector.issue('error', 'bad_score', 'score text does not match the regex', named);
            return;
          }
          if (s.v) {
            let ht: [number, number] | null = null;
            if (f.halfTime) {
              const h = pair(read(item, f.halfTime), f.halfTime.regex);
              if (!h.ok) {
                collector.issue(
                  'error',
                  'bad_score',
                  'half-time text does not match the regex',
                  named,
                );
                return;
              }
              ht = h.v;
            }
            score = {
              home: s.v[0],
              away: s.v[1],
              htHome: ht?.[0] ?? null,
              htAway: ht?.[1] ?? null,
            };
          }
        }
        let status: SourceStatus | null = null;
        if (f.status && statusLookup?.ok) {
          const v = read(item, f.status);
          if (v !== null) {
            status = statusLookup.lookup.get(statusKey(v)) ?? null;
            if (!status) {
              collector.issue('error', 'unknown_status', 'status text is not in the status map', {
                ...named,
                value: v,
              });
              return;
            }
          }
        }
        status ??= score ? 'finished' : (f.status?.default ?? 'scheduled');
        const drafts = draftsFor({
          home,
          away,
          competition,
          kickoff,
          externalRef: f.externalRef ? (read(item, f.externalRef)?.slice(0, 200) ?? null) : null,
          round: f.round ? (read(item, f.round)?.slice(0, 80) ?? null) : null,
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
