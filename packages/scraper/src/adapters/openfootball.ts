import { z } from 'zod';
import type { FetchPlanItem, ParseOutcome, RawDocument, SourceAdapter, SourceDescriptor } from '../types';
import {
  allowedHostsSchema,
  checkRequests,
  cleanName,
  draftsFor,
  parseScoreInt,
  requestUrlSchema,
  sportSchema,
  startParse,
  timeZoneSchema,
  zonedToUtc,
  type RecordParts,
} from './common';
import type { Score } from '../types';

/**
 * Config of the openfootball adapter (github.com/openfootball/football.json,
 * CC0). Times in that dataset are LOCAL to the league, so the zone is part of
 * the config and the conversion is explicit (rule T1).
 */
export const OpenFootballConfigSchema = z
  .strictObject({
    allowedHosts: allowedHostsSchema.default(['raw.githubusercontent.com']),
    requests: z
      .array(z.strictObject({ url: requestUrlSchema, competition: z.string().trim().min(1).max(120) }))
      .min(1)
      .max(20),
    timeZone: timeZoneSchema,
    sport: sportSchema,
  })
  .superRefine(checkRequests);
export type OpenFootballConfig = z.infer<typeof OpenFootballConfigSchema>;

type Pair = [number, number];

function pairOf(value: unknown): Pair | string {
  if (!Array.isArray(value) || value.length !== 2) return 'must be an array of exactly 2 numbers';
  const a = typeof value[0] === 'number' ? parseScoreInt(value[0]) : null;
  const b = typeof value[1] === 'number' ? parseScoreInt(value[1]) : null;
  if (a === null || b === null) return 'must be two non-negative integers';
  return [a, b];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function createOpenFootballAdapter(
  descriptor: SourceDescriptor,
  config: OpenFootballConfig,
): SourceAdapter {
  return {
    descriptor,
    allowedHosts: config.allowedHosts,
    plan(): FetchPlanItem[] {
      return config.requests.map((r) => ({ url: r.url, purpose: 'both' as const }));
    },
    parse(doc: RawDocument): ParseOutcome {
      const { collector, usable } = startParse(descriptor.id, doc);
      if (!usable) return collector.outcome();
      const request =
        config.requests.find((r) => r.url === doc.url) ??
        (config.requests.length === 1 ? config.requests[0] : undefined);
      if (!request) {
        collector.fatal('unknown_request', 'the document URL matches no configured request', { url: doc.url });
        return collector.outcome();
      }
      let json: unknown;
      try {
        json = JSON.parse(doc.body);
      } catch {
        collector.fatal('bad_json', 'the document is not JSON');
        return collector.outcome();
      }
      const matches = isObject(json) ? json.matches : undefined;
      if (!Array.isArray(matches)) {
        collector.fatal('bad_shape', 'expected an object with a "matches" array');
        return collector.outcome();
      }
      matches.forEach((m: unknown, index) => {
        if (!collector.beginRecord()) return;
        const ctx = { index };
        if (!isObject(m)) {
          collector.issue('error', 'bad_record', 'a match must be an object', ctx);
          return;
        }
        const home = cleanName(m.team1);
        const away = cleanName(m.team2);
        if (!home || !away) {
          collector.issue('error', 'bad_name', 'team1 and team2 must be non-empty strings', ctx);
          return;
        }
        const named = { ...ctx, home, away };
        if (typeof m.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(m.date)) {
          collector.issue('error', 'bad_date', 'date must be YYYY-MM-DD', { ...named, date: m.date });
          return;
        }
        if (m.time === undefined || m.time === null) {
          collector.issue('warning', 'missing_time', 'no kickoff time; we do not guess one', named);
          return;
        }
        if (typeof m.time !== 'string' || !/^\d{1,2}:\d{2}$/.test(m.time)) {
          collector.issue('error', 'bad_time', 'time must be HH:MM', { ...named, time: m.time });
          return;
        }
        const zoned = zonedToUtc({
          date: m.date,
          time: m.time.padStart(5, '0'),
          timeZone: config.timeZone,
        });
        if (!zoned.ok) {
          collector.issue('error', 'bad_time', `kickoff rejected: ${zoned.reason}`, {
            ...named,
            date: m.date,
            time: m.time,
          });
          return;
        }

        let score: Score | null = null;
        let basis: 'regular_time' | 'unknown' = 'regular_time';
        const raw = m.score;
        if (raw !== undefined && raw !== null) {
          if (!isObject(raw)) {
            collector.issue('error', 'bad_score', 'score must be an object', named);
            return;
          }
          let main: Pair | string;
          if (raw.ft !== undefined) {
            main = pairOf(raw.ft);
          } else if (raw.et !== undefined || raw.p !== undefined) {
            basis = 'unknown';
            main = pairOf(raw.et !== undefined ? raw.et : raw.p);
          } else {
            collector.issue('error', 'bad_score', 'score has none of ft, et, p', named);
            return;
          }
          if (typeof main === 'string') {
            collector.issue('error', 'bad_score', `score ${main}`, named);
            return;
          }
          let ht: Pair | null = null;
          if (raw.ht !== undefined && raw.ht !== null) {
            const h = pairOf(raw.ht);
            if (typeof h === 'string') {
              collector.issue('error', 'bad_score', `half-time score ${h}`, named);
              return;
            }
            ht = h;
          }
          score = { home: main[0], away: main[1], htHome: ht?.[0] ?? null, htAway: ht?.[1] ?? null };
        }
        const parts: RecordParts = {
          home,
          away,
          competition: request.competition,
          kickoff: zoned.instant,
          externalRef: null,
          round: typeof m.round === 'string' ? cleanName(m.round)?.slice(0, 80) ?? null : null,
          status: score ? 'finished' : 'scheduled',
          score,
          scoreBasis: score ? basis : null,
        };
        const drafts = draftsFor(parts);
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
