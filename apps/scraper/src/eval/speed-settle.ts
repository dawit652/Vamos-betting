/**
 * P3 (measured part) of docs/scraper-evaluation/02-speed-and-resilience.md: how long do the real
 * services take from "result applied" to "bets settled"?
 *
 * On the scratch database, with events created by the real promotion code from the real en.1 2026-27
 * document: open betting on one event, place N single bets and M doubles (real `placeBet`), apply a
 * confirmed result with the scraper's real `applyConfirmedResult`, then settle every bet with the real
 * `settlePlacedBet` (one transaction per bet, as the worker's settlement task does it), sequentially
 * and with 2 lanes (the worker's default concurrency). No servers, no queues: the outbox dispatch
 * interval (1 s) and the BullMQ hop are NOT measured here, they are taken from the code.
 *
 *   pnpm --filter @vamos/scraper-app exec tsx src/eval/speed-settle.ts <snapshot.json> <archiveDir> <dump> <out.json> [bets]
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  listBetIdsForEvent,
  listBetsToSettle,
  loadGameSettings,
  placeBet,
  setEventBettingOpen,
  settlePlacedBet,
} from '@vamos/db';
import { birr } from '@vamos/core';
import { applyConfirmedResult } from '../pipeline/promote-results';
import { runDueSources } from '../tasks/scheduler';
import { runPromotion } from '../tasks/promote';
import { createUser, fund } from '../../../../packages/db/test/helpers';
import { HOUR, MINUTE, etagOf, openEval, openfootballSource, resetDatabase } from './speed-lib';

const URL_EN1 =
  'https://raw.githubusercontent.com/openfootball/football.json/master/2026-27/en.1.json';
const START = new Date('2026-10-01T10:00:00Z');

const q = (sorted: number[], p: number): number =>
  sorted.length === 0
    ? NaN
    : (sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? NaN);
const r1 = (n: number): number => Math.round(n * 10) / 10;
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return {
    n: s.length,
    medianMs: r1(q(s, 0.5)),
    p90Ms: r1(q(s, 0.9)),
    maxMs: r1(s[s.length - 1] ?? NaN),
  };
};

async function main(): Promise<void> {
  const [snapshot, archiveDir, dump, out, betsArg] = process.argv.slice(2);
  if (!snapshot || !archiveDir || !dump || !out) {
    process.stderr.write(
      'usage: speed-settle.ts <snapshot.json> <archiveDir> <dump> <out.json> [bets]\n',
    );
    process.exit(2);
  }
  const singles = Number(betsArg ?? 100);
  const doubles = Math.floor(singles / 5);
  resetDatabase(dump);
  const h = await openEval({ archiveDir, start: START });
  const doc = readFileSync(snapshot, 'utf8');
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
  await runDueSources(h.ctx, { random: () => 0 });
  await runPromotion(h.ctx);
  const events = await h.rows<{ id: string; feed_ref: string; start_time: Date }>(
    "select id, feed_ref, start_time from events where feed_provider = 'scraped' order by start_time, id limit 2",
  );
  const [first, second] = events;
  if (first === undefined || second === undefined)
    throw new Error('no scraped events were created');
  for (const e of events)
    await h.handle.db.transaction((tx) => setEventBettingOpen(tx, e.id, true));
  const sel = async (eventId: string) =>
    h.rows<{ id: string; code: string; odds_milli: number }>(
      `select s.id, s.code, s.odds_milli from selections s join markets m on m.id = s.market_id
       where m.event_id = $1 and m.type = '1x2' order by s.code`,
      [eventId],
    );
  const s1 = await sel(first.id);
  const s2 = await sel(second.id);
  const settings = await loadGameSettings(h.handle.db);

  // Place bets (timed, for the record).
  const placeMs: number[] = [];
  const place = async (legs: Array<{ id: string; odds_milli: number }>) => {
    const userId = await createUser(h.handle.db);
    await fund(h.handle.db, userId, birr(10_000));
    const t = performance.now();
    await h.handle.db.transaction((tx) =>
      placeBet(tx, {
        userId,
        legs: legs.map((l) => ({ selectionId: l.id, oddsMilli: l.odds_milli })),
        stake: birr(10),
        policy: 'none',
        idempotencyKey: `eval-${randomBytes(8).toString('hex')}`,
        now: h.now(),
        settings,
        randomBytes: (n) => randomBytes(n),
      }),
    );
    placeMs.push(performance.now() - t);
  };
  for (let i = 0; i < singles; i += 1) await place([s1[i % s1.length]!]);
  for (let i = 0; i < doubles; i += 1) await place([s1[i % s1.length]!, s2[(i + 1) % s2.length]!]);

  // Apply the confirmed result with the scraper's own function.
  h.at(new Date(new Date(first.start_time).getTime() + 2 * HOUR));
  const t0 = performance.now();
  const applied = await applyConfirmedResult(h.ctx, {
    eventId: first.id,
    feedRef: first.feed_ref,
    score: { home: 2, away: 1, htHome: 1, htAway: 0 },
    upstreams: ['openfootball'],
    sources: ['of-en1'],
    observations: [],
    via: 'staff',
  });
  const applyMs = performance.now() - t0;
  const outbox = await h.count(
    "select count(*) as n from outbox_events where type = 'event.resulted'",
  );
  const ids = await listBetIdsForEvent(h.handle.db, first.id);

  const settleOne = async (id: string): Promise<number> => {
    const t = performance.now();
    await h.handle.db.transaction((tx) => settlePlacedBet(tx, id, h.now()));
    return performance.now() - t;
  };
  const half = Math.ceil(ids.length / 2);
  // Lane run (2 lanes = worker default concurrency) on the first half, sequential on the second half.
  const laneStart = performance.now();
  const perBetLanes: number[] = [];
  const lane = async (list: string[]) => {
    for (const id of list) perBetLanes.push(await settleOne(id));
  };
  await Promise.all([
    lane(ids.slice(0, half).filter((_x, i) => i % 2 === 0)),
    lane(ids.slice(0, half).filter((_x, i) => i % 2 === 1)),
  ]);
  const lanesMs = performance.now() - laneStart;
  const seqStart = performance.now();
  const perBetSeq: number[] = [];
  for (const id of ids.slice(half)) perBetSeq.push(await settleOne(id));
  const seqMs = performance.now() - seqStart;

  const t1 = performance.now();
  const sweep = await listBetsToSettle(h.handle.db, h.now(), {
    graceMs: 60_000,
    lookbackMs: 7 * 24 * HOUR,
    limit: 200,
  });
  const sweepQueryMs = performance.now() - t1;
  const settled = await h.count(
    "select count(*) as n from bets b where b.status::text <> 'open' and exists (select 1 from bet_legs l where l.bet_id = b.id and l.event_id = $1)",
    [first.id],
  );
  const result = {
    betsOnEvent: ids.length,
    singles,
    doubles,
    placeBetMs: stats(placeMs),
    applyConfirmedResultMs: r1(applyMs),
    applied: applied.applied,
    outboxEventResultedRows: outbox,
    settlePlacedBet: {
      twoLanes: { bets: perBetLanes.length, wallMs: r1(lanesMs), perBet: stats(perBetLanes) },
      sequential: { bets: perBetSeq.length, wallMs: r1(seqMs), perBet: stats(perBetSeq) },
    },
    projectedWallSecondsFor: {
      '100 bets (2 lanes)': r1((lanesMs / Math.max(1, perBetLanes.length)) * 100) / 1000,
      '1000 bets (2 lanes)': r1((lanesMs / Math.max(1, perBetLanes.length)) * 1000) / 1000,
      '10000 bets (2 lanes)': r1((lanesMs / Math.max(1, perBetLanes.length)) * 10000) / 1000,
    },
    sweepQueryMs: r1(sweepQueryMs),
    sweepFoundAfterSettlement: sweep.length,
    betsSettledOrFinal: settled,
  };
  void MINUTE;
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  await h.close();
  process.exit(0);
}

void main();
