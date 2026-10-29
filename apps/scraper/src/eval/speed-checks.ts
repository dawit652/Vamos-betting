/**
 * P4 (the two cheap checks) of docs/scraper-evaluation/02-speed-and-resilience.md, on the real
 * openfootball en.1 2026-27 document (its latest commit), the real adapter, gates and promotion code,
 * a real Postgres (scratch database) and an injected clock:
 *
 *   1. identical snapshot: a source re-run with the same bytes (as 304 and as a plain 200), and a second
 *      promotion pass, must change no business row;
 *   2. absence never cancels: records are dropped from the snapshot (45 % and exactly 50 %); no event,
 *      market or selection that existed may change, over four simulated days of polling.
 *
 *   pnpm --filter @vamos/scraper-app exec tsx src/eval/speed-checks.ts <snapshot.json> <archiveDir> <dump> <out.json>
 *
 * The dump is `pg_dump -Fc vamos_eval_speed` taken right after `pnpm db:migrate && pnpm db:seed`.
 */
import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { runDueSources } from '../tasks/scheduler';
import { runPromotion } from '../tasks/promote';
import {
  DAY,
  HOUR,
  MINUTE,
  etagOf,
  openEval,
  openfootballSource,
  resetDatabase,
  type EvalHarness,
} from './speed-lib';

const URL_EN1 =
  'https://raw.githubusercontent.com/openfootball/football.json/master/2026-27/en.1.json';
const START = new Date('2026-10-01T10:00:00Z');

/** Tables whose rows are "business state": they must not change when nothing changed upstream. */
const DIGESTS: Record<string, string> = {
  observations: `select md5(coalesce(string_agg(t, ',' order by t), '')) from (select concat_ws('|', source_id, kind, source_key, competition_id, home_team_id, away_team_id, kickoff, status, score, score_basis, payload_hash, first_seen_at, changed_at) as t from scrape_observations) x`,
  history: `select count(*)::text from scrape_observation_history`,
  events: `select md5(coalesce(string_agg(t, ',' order by t), '')) from (select concat_ws('|', id, feed_ref, start_time, status, betting_open, score_home, score_away, resulted_at, updated_at) as t from events) x`,
  markets: `select md5(coalesce(string_agg(t, ',' order by t), '')) from (select concat_ws('|', id, event_id, type, line, status, updated_at) as t from markets) x`,
  selections: `select md5(coalesce(string_agg(t, ',' order by t), '')) from (select concat_ws('|', id, market_id, code, odds_milli, result, status, updated_at) as t from selections) x`,
  reviewItems: `select md5(coalesce(string_agg(t, ',' order by t), '')) from (select concat_ws('|', id, kind, subject_key, status, payload::text, updated_at) as t from scrape_review_items) x`,
  ratings: `select md5(coalesce(string_agg(t, ',' order by t), '')) from (select concat_ws('|', id, ratings::text) as t from teams) x`,
  auditRows: `select count(*)::text from audit_log`,
  outboxRows: `select count(*)::text from outbox_events`,
  oddsHistoryRows: `select count(*)::text from odds_history`,
};
/** Rows a run writes by design (the run record and the raw-page record). */
const BY_DESIGN = [
  'select count(*)::text from scrape_runs',
  'select count(*)::text from scrape_raw',
];

async function digest(h: EvalHarness): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [name, sql] of Object.entries(DIGESTS)) {
    const [row] = await h.rows<Record<string, string>>(sql);
    out[name] = Object.values(row ?? {})[0] ?? '';
  }
  return out;
}
const differing = (a: Record<string, string>, b: Record<string, string>): string[] =>
  Object.keys(a).filter((k) => a[k] !== b[k]);

async function setup(archiveDir: string, dump: string, doc: string): Promise<EvalHarness> {
  resetDatabase(dump);
  const h = await openEval({ archiveDir, start: START });
  await h.addSource(
    openfootballSource('of-en1', URL_EN1, 'English Premier League', 'Europe/London'),
  );
  await h.addCompetitionAlias('English Premier League', 'premier-league');
  await h.enableCompetition('premier-league');
  const shorts = (
    await h.rows<{ short_name: string }>("select short_name from teams where sport_id = 'football'")
  ).map((r) => r.short_name);
  await h.reviewRatings(shorts);
  h.net.serve(URL_EN1, { status: 200, body: doc, headers: { etag: etagOf(doc) } });
  return h;
}

/** One scheduler tick + one promotion pass at the current simulated time. */
async function tick(h: EvalHarness): Promise<{ ran: number }> {
  const s = await runDueSources(h.ctx, { random: () => 0 });
  await runPromotion(h.ctx);
  return { ran: s.ran };
}

function dropRecords(doc: string, dropIf: (index: number) => boolean): string {
  const json = JSON.parse(doc) as { matches: unknown[] };
  return JSON.stringify({ ...json, matches: json.matches.filter((_m, i) => !dropIf(i)) });
}

async function identicalSnapshot(archiveDir: string, dump: string, doc: string) {
  const h = await setup(archiveDir, dump, doc);
  try {
    // Learn the page (baseline for the shape gate needs 3 successful runs).
    for (let i = 0; i < 4; i += 1) {
      await tick(h);
      h.advance(15 * MINUTE);
    }
    const events = await h.count(
      "select count(*) as n from events where feed_provider = 'scraped'",
    );
    const items = await h.count('select count(*) as n from scrape_review_items');
    const before = await digest(h);
    const runsBefore = await h.count('select count(*) as n from scrape_runs');
    const rawBefore = await h.count('select count(*) as n from scrape_raw');

    // (a) the same bytes again, with the ETag: 304.
    const r304 = await h.run('of-en1');
    // (b) the same bytes without any validator: a plain 200 with an identical body.
    h.net.serve(URL_EN1, { status: 200, body: doc });
    await h.fetcher.forgetValidators(URL_EN1);
    h.advance(15 * MINUTE);
    const r200 = await h.run('of-en1');
    // (c) two more promotion passes.
    await runPromotion(h.ctx);
    await runPromotion(h.ctx);
    const after = await digest(h);
    return {
      scenario: 'identical snapshot',
      eventsCreatedBefore: events,
      reviewItemsBefore: items,
      statusOf304Run: r304.status,
      statusOf200Run: r200.status,
      runRowsAdded: (await h.count('select count(*) as n from scrape_runs')) - runsBefore,
      rawRowsAdded: (await h.count('select count(*) as n from scrape_raw')) - rawBefore,
      tablesChanged: differing(before, after),
      pass: differing(before, after).length === 0,
      note: 'scrape_runs and scrape_raw rows are written by design (run record, 304 sighting); they are not business state',
    };
  } finally {
    await h.close();
  }
}

async function absence(
  archiveDir: string,
  dump: string,
  doc: string,
  label: string,
  dropIf: (i: number) => boolean,
) {
  const h = await setup(archiveDir, dump, doc);
  try {
    for (let i = 0; i < 4; i += 1) {
      await tick(h);
      h.advance(15 * MINUTE);
    }
    const existing = await h.rows<{ id: string }>(
      "select id from events where feed_provider = 'scraped'",
    );
    const ids = existing.map((e) => e.id);
    const eventState = `select md5(coalesce(string_agg(t, ',' order by t), '')) as d from (select concat_ws('|', e.id, e.start_time, e.status, e.betting_open, e.score_home, e.score_away, e.resulted_at, e.updated_at) as t from events e where e.id = any($1)
      union all select concat_ws('|', m.id, m.status, m.updated_at) from markets m where m.event_id = any($1)
      union all select concat_ws('|', s.id, s.odds_milli, s.result, s.status, s.updated_at) from selections s join markets m on m.id = s.market_id where m.event_id = any($1)) x`;
    const stateBefore = (await h.rows<{ d: string }>(eventState, [ids]))[0]?.d;
    const thin = dropRecords(doc, dropIf);
    const kept = (JSON.parse(thin) as { matches: unknown[] }).matches.length;
    const total = (JSON.parse(doc) as { matches: unknown[] }).matches.length;
    h.net.serve(URL_EN1, { status: 200, body: thin, headers: { etag: etagOf(thin) } });
    const statuses: Record<string, number> = {};
    const kinds: Record<string, number> = {};
    // Four simulated days, one tick every 6 hours.
    for (let step = 0; step < 16; step += 1) {
      h.advance(6 * HOUR);
      await tick(h);
      const last = (
        await h.rows<{ status: string }>(
          'select status from scrape_runs order by started_at desc limit 1',
        )
      )[0];
      statuses[last?.status ?? 'none'] = (statuses[last?.status ?? 'none'] ?? 0) + 1;
    }
    const itemKinds = await h.rows<{ kind: string; n: string }>(
      'select kind, count(*)::text as n from scrape_review_items where created_at > $1 group by 1 order by 1',
      [START],
    );
    for (const r of itemKinds) kinds[r.kind] = Number(r.n);
    const stateAfter = (await h.rows<{ d: string }>(eventState, [ids]))[0]?.d;
    const bad = await h.count(
      "select count(*) as n from events where feed_provider = 'scraped' and status in ('cancelled','abandoned','postponed','finished')",
    );
    const voidMarkets = await h.count(
      "select count(*) as n from markets m join events e on e.id = m.event_id where e.feed_provider = 'scraped' and m.status = 'void'",
    );
    const missing = await h.count(
      "select count(*) as n from scrape_review_items where kind = 'fixture_missing'",
    );
    return {
      scenario: `absence: ${label}`,
      recordsInDocument: total,
      recordsAfterDrop: kept,
      droppedPercent: Number((100 * (1 - kept / total)).toFixed(1)),
      eventsExistingAtDrop: ids.length,
      eventStateUnchanged: stateBefore === stateAfter,
      eventsCancelledOrVoidedOrFinished: bad,
      voidMarkets,
      lastRunStatusCounts: statuses,
      reviewItemsOpenedAfterDropByKind: kinds,
      fixtureMissingItems: missing,
      pass: stateBefore === stateAfter && bad === 0 && voidMarkets === 0,
    };
  } finally {
    await h.close();
  }
}

async function main(): Promise<void> {
  const [snapshot, archiveDir, dump, out] = process.argv.slice(2);
  if (!snapshot || !archiveDir || !dump || !out) {
    process.stderr.write('usage: speed-checks.ts <snapshot.json> <archiveDir> <dump> <out.json>\n');
    process.exit(2);
  }
  const doc = readFileSync(snapshot, 'utf8');
  const results = [
    await identicalSnapshot(archiveDir, dump, doc),
    await absence(archiveDir, dump, doc, 'drop 45 % of the records', (i) => i % 20 < 9),
    await absence(archiveDir, dump, doc, 'drop exactly 50 % of the records', (i) => i % 2 === 1),
  ];
  void DAY;
  void BY_DESIGN;
  writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  process.exit(0);
}

void main();
