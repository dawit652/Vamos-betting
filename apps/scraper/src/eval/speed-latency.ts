/**
 * P3 (simulated part) of docs/scraper-evaluation/02-speed-and-resilience.md: the timeline from "the final
 * score becomes visible at the source" to "result applied", through the REAL scheduler (cadence, poll
 * phase), fetcher, adapters, gates and promotion code, with an injected clock ticking every 30 s
 * (the scheduler's period) and a promotion pass every 60 s (the promote task's period).
 *
 * The documents are synthetic (one Arsenal v Chelsea fixture): they are the INPUT of a latency
 * simulation, not data about the world. Scenarios:
 *   A  two independent upstreams show the same score at the same instant, competition on auto results
 *      (no human): latency from visibility to applied, over 15 poll phases (score appears 0..14 min
 *      after kickoff + 105 min, in 1-minute steps);
 *   B  one upstream only, a trader who answers `apply_result` the moment the item opens (best case for
 *      the human): when does the item open, and when is the result applied;
 *   C  as A but the competition is not on auto results (`result_ready`) and a trader confirms at once.
 *
 *   pnpm --filter @vamos/scraper-app exec tsx src/eval/speed-latency.ts <archiveDir> <dump> <out.json>
 */
import { writeFileSync } from 'node:fs';
import { resolveReviewItem } from '@vamos/db';
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

const URL_A = 'https://raw.githubusercontent.com/eval/en1.json';
const URL_B = 'https://api.example.com/events';
const KICKOFF = new Date('2026-11-14T15:00:00Z');
const T0 = new Date(KICKOFF.getTime() - 3 * DAY);

const ofDoc = (score: [number, number] | null): string =>
  JSON.stringify({
    name: 'eval league',
    matches: [
      {
        round: 'Matchday 1',
        date: '2026-11-14',
        time: '15:00',
        team1: 'Arsenal FC',
        team2: 'Chelsea FC',
        ...(score === null ? {} : { score: { ht: [1, 0], ft: score } }),
      },
    ],
  });
const jsonDoc = (score: [number, number] | null): string =>
  JSON.stringify({
    data: {
      events: [
        {
          id: 1,
          league: 'Premier League',
          kick: '2026-11-14T15:00:00Z',
          h: 'Arsenal',
          a: 'Chelsea',
          st: score === null ? 'NS' : 'FT',
          hs: score === null ? null : String(score[0]),
          as: score === null ? null : String(score[1]),
          hth: score === null ? null : '1',
          hta: score === null ? null : '0',
        },
      ],
    },
  });

async function setup(
  archiveDir: string,
  dump: string,
  twoSources: boolean,
  autoResults: boolean,
): Promise<EvalHarness> {
  resetDatabase(dump);
  const h = await openEval({ archiveDir, start: T0 });
  await h.addSource(openfootballSource('src-a', URL_A, 'Premier League', 'Europe/London'));
  if (twoSources) {
    await h.addSource({
      id: 'src-b',
      name: 'json api',
      adapter: 'generic-json',
      upstream: 'example-api',
      config: {
        allowedHosts: ['api.example.com'],
        requests: [{ url: URL_B, purpose: 'both' }],
        sport: 'football',
        recordsPath: 'data.events[*]',
        fields: {
          home: 'h',
          away: 'a',
          competition: { path: 'league' },
          kickoff: { path: 'kick', format: 'iso' },
          externalRef: 'id',
          status: { path: 'st', map: { FT: 'finished', NS: 'scheduled', PST: 'postponed' } },
          score: { homePath: 'hs', awayPath: 'as', htHomePath: 'hth', htAwayPath: 'hta' },
        },
        scoreBasis: 'regular_time',
      },
    });
  }
  await h.enableCompetition('premier-league', { autoResults });
  await h.reviewRatings(['Arsenal', 'Chelsea']);
  serve(h, null, twoSources, null);
  return h;
}

/** Serves the documents; `visibleAt` is when the score shows up (documents switch at that instant). */
function serve(
  h: EvalHarness,
  score: [number, number] | null,
  two: boolean,
  visibleAt: Date | null,
): void {
  const pick = (): [number, number] | null =>
    score !== null && visibleAt !== null && h.now().getTime() >= visibleAt.getTime() ? score : null;
  h.net.handle(URL_A, () => {
    const body = ofDoc(pick());
    return { status: 200, body, headers: { etag: etagOf(body) } };
  });
  if (two) {
    h.net.handle(URL_B, () => {
      const body = jsonDoc(pick());
      return { status: 200, body, headers: { etag: etagOf(body) } };
    });
  }
}

interface Trial {
  scenario: string;
  visibleAfterKickoffMin: number;
  firstSeenSec: number | null;
  itemOpenSec: number | null;
  appliedSec: number | null;
}

/** Ticks 30 s at a time from `from` to `to`; promotion on every second tick. */
async function runTrial(
  h: EvalHarness,
  scenario: string,
  visibleAt: Date,
  until: Date,
  trader: 'none' | 'instant',
): Promise<Trial> {
  serve(h, [2, 1], scenario !== 'B one upstream + instant trader', visibleAt);
  const trial: Trial = {
    scenario,
    visibleAfterKickoffMin: (visibleAt.getTime() - KICKOFF.getTime()) / MINUTE,
    firstSeenSec: null,
    itemOpenSec: null,
    appliedSec: null,
  };
  // Warm up: events are created 3 days ahead, polling runs on its normal cadence until the match.
  h.at(new Date(KICKOFF.getTime() - 2 * HOUR));
  let promoteToggle = false;
  for (let t = h.now().getTime(); t <= until.getTime(); t += 30_000) {
    h.at(new Date(t));
    await runDueSources(h.ctx, { random: () => 0 });
    promoteToggle = !promoteToggle;
    if (promoteToggle) await runPromotion(h.ctx);
    const sec = (t - visibleAt.getTime()) / 1000;
    if (trial.firstSeenSec === null && t >= visibleAt.getTime()) {
      const n = await h.count(
        "select count(*) as n from scrape_observations where kind = 'result'",
      );
      if (n > 0) trial.firstSeenSec = sec;
    }
    if (trial.itemOpenSec === null) {
      const n = await h.count(
        "select count(*) as n from scrape_review_items where kind in ('result_ready','result_unverified')",
      );
      if (n > 0) trial.itemOpenSec = sec;
    }
    if (trader === 'instant') {
      const open = await h.rows<{ id: string }>(
        "select id from scrape_review_items where kind in ('result_ready','result_unverified') and status = 'open'",
      );
      for (const item of open) {
        await h.handle.db.transaction((tx) =>
          resolveReviewItem(tx, item.id, {
            status: 'resolved',
            resolution: JSON.stringify({ decision: 'apply_result' }),
            actor: { system: 'eval-trader' },
            now: h.now(),
          }),
        );
      }
    }
    if (trial.appliedSec === null) {
      const n = await h.count("select count(*) as n from events where status = 'finished'");
      if (n > 0) {
        trial.appliedSec = sec;
        break;
      }
    }
  }
  return trial;
}

const q = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? NaN : (s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN);
};
const summary = (xs: Array<number | null>) => {
  const v = xs.filter((x): x is number => x !== null);
  return {
    n: v.length,
    ofTrials: xs.length,
    bestMin: Math.round(Math.min(...v) / 6) / 10,
    medianMin: Math.round(q(v, 0.5) / 6) / 10,
    p90Min: Math.round(q(v, 0.9) / 6) / 10,
    worstMin: Math.round(Math.max(...v) / 6) / 10,
  };
};

async function main(): Promise<void> {
  const [archiveDir, dump, out] = process.argv.slice(2);
  if (!archiveDir || !dump || !out) {
    process.stderr.write('usage: speed-latency.ts <archiveDir> <dump> <out.json>\n');
    process.exit(2);
  }
  const results: Record<string, unknown> = {};
  const earliestEnd = new Date(KICKOFF.getTime() + 105 * MINUTE);

  const a: Trial[] = [];
  for (let p = 0; p < 15; p += 1) {
    const h = await setup(archiveDir, dump, true, true);
    // creation pass, 3 days ahead
    await runDueSources(h.ctx, { random: () => 0 });
    await runPromotion(h.ctx);
    a.push(
      await runTrial(
        h,
        'A two upstreams, auto results, no human',
        new Date(earliestEnd.getTime() + p * MINUTE),
        new Date(earliestEnd.getTime() + 2 * HOUR),
        'none',
      ),
    );
    await h.close();
  }
  results.A = {
    trials: a,
    visibleToFirstSeenMin: summary(a.map((t) => t.firstSeenSec)),
    visibleToApplied: summary(a.map((t) => t.appliedSec)),
  };

  const c: Trial[] = [];
  for (const p of [0, 7]) {
    const h = await setup(archiveDir, dump, true, false);
    await runDueSources(h.ctx, { random: () => 0 });
    await runPromotion(h.ctx);
    c.push(
      await runTrial(
        h,
        'C two upstreams, not on auto results, instant trader',
        new Date(earliestEnd.getTime() + p * MINUTE),
        new Date(earliestEnd.getTime() + 2 * HOUR),
        'instant',
      ),
    );
    await h.close();
  }
  results.C = { trials: c };

  const b: Trial[] = [];
  for (const afterKickoffMin of [110, 24 * 60]) {
    const h = await setup(archiveDir, dump, false, false);
    await runDueSources(h.ctx, { random: () => 0 });
    await runPromotion(h.ctx);
    const visible = new Date(KICKOFF.getTime() + afterKickoffMin * MINUTE);
    b.push(
      await runTrial(
        h,
        'B one upstream + instant trader',
        visible,
        new Date(Math.max(visible.getTime(), earliestEnd.getTime()) + 8 * HOUR + 30 * MINUTE),
        'instant',
      ),
    );
    await h.close();
  }
  results.B = { trials: b };
  writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  process.exit(0);
}

void main();
