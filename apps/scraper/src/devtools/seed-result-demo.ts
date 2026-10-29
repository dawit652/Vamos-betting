import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  baseLoggerOptions,
  loadConfig,
  loadDotEnv,
  scraperUserAgent,
  type AppConfig,
} from '@vamos/config';
import { birr, marketKey } from '@vamos/core';
import {
  createDb,
  getSource,
  listCompetitionPolicies,
  listCurrentObservations,
  loadGameSettings,
  placeBet,
  schema,
  setCompetitionPolicy,
  setSourceEnabled,
  setTeamRatings,
  upsertSource,
  withTxRetry,
  type Database,
} from '@vamos/db';
import { and, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { pino, type Logger } from 'pino';
import { decideFixture, FileRawArchive, PoliteFetcher, type FetchLike } from '@vamos/scraper';
import { createScraperContext, type ScraperContext } from '../context';
import { toResolved } from '../pipeline/common';
import { applyCreate, pricingFor } from '../pipeline/promote-fixtures';
import { runSource } from '../pipeline/run-source';

/**
 * DEMO ONLY: puts ONE finished football match into the DEMO database in the state a real result is in
 * the moment before a trader confirms it, so the owner can watch the whole result path work: the
 * scraper applies the confirmed score, the event becomes `finished` and the worker settles the bets.
 *
 *   pnpm --filter @vamos/scraper-app seed:result-demo [tag] [--player <phone>]
 *
 * (`tag` defaults to `demo`; running it again with the same tag changes nothing, except that
 * `--player` places the player's two bets if they were not placed yet.) It prints the ids as one
 * JSON object on stdout. Refuses outside OPERATING_MODE=demo.
 *
 * Nothing is faked except the network. The match is made by the real code, with the clock set to the
 * moments it is describing:
 *
 *   1. a demo competition with two demo teams (rated, so the model can price them), a policy that
 *      lets events be created and opened by themselves, and one ENABLED source (`generic-json`,
 *      results polling) whose upstream is a host that does not exist (`results.demo.invalid`);
 *   2. the real `runSource` reads that source three times through the real `PoliteFetcher`, whose
 *      transport is replaced by a function that serves one small JSON page: three days before kickoff
 *      (match listed as scheduled), one hour before kickoff (still scheduled), and now (the final
 *      score, 2-1 with 1-0 at half time). Raw pages are archived, observations stored and names
 *      resolved by the scraper's own code;
 *   3. after the first read the event is created by the scraper's own gate (`decideFixture`, then
 *      `applyCreate`, the code the promotion pass uses): feed provider `scraped`, status `scheduled`,
 *      markets priced by the model, betting open. Only this one fixture is decided: no promotion pass
 *      runs with a past clock, so nothing else in the database is touched;
 *   4. with `--player`, two bets are placed with the real `placeBet` as of two hours before kickoff
 *      (the only time betting was possible): ETB 100 on the home side and ETB 50 on the away side.
 *      The player signs up and adds play money first (ETB 150 is enough).
 *
 * The kickoff is 9 hours before the moment the command runs. That is on purpose: with one source the
 * scraper only asks a trader to confirm a result 7 h 45 min after kickoff (rule R6), so a match that
 * ended less than that ago would just wait. No code of the scraper is shortened for the demo.
 *
 * Afterwards the running scraper's next promotion pass (within a minute) opens a `result_unverified`
 * item (Feed, Review). A trader presses "Apply this result"; the next pass applies the score and the
 * worker settles the bets.
 *
 * The source is enabled because a source that is off does not count (rule S4), and a trader's
 * confirmation needs a current result from an enabled source. The scheduler would poll it again about
 * an hour after the last read (results polling, no match in its hot window); that read fails
 * (the host does not exist), is recorded as a failed run, changes no event and opens no review item.
 * Only an event nobody has resulted by then gets a `fixture_missing` flag, which is the honest
 * description of a source that has stopped answering.
 */

const HOUR = 3_600_000;
const MINUTE = 60_000;
const DAY = 24 * HOUR;
const actor = { system: 'seed-result-demo' };

/** The match ended this long ago when the command runs (see above for why not less). */
export const KICKOFF_AGO_MS = 9 * HOUR;
export const DEMO_SCORE = { home: 2, away: 1, htHome: 1, htAway: 0 } as const;
const HOME_STAKE = birr(100);
const AWAY_STAKE = birr(50);

export interface ResultDemoDeps {
  config: AppConfig;
  db: Database;
  redis: Redis;
  /** Default: the real clock. */
  now?: () => Date;
  logger?: Logger;
}

export interface SeededBet {
  shortId: string;
  pick: 'home' | 'away';
  stake: string;
  oddsMilli: number;
}

export interface SeededResultDemo {
  tag: string;
  sourceId: string;
  competition: { id: string; name: string };
  teams: { home: string; away: string };
  names: { home: string; away: string };
  eventId: string;
  feedRef: string;
  kickoff: string;
  score: typeof DEMO_SCORE;
  /** The upstream's id for the match (the key its result observation is stored under). */
  upstreamId: string;
  bets: SeededBet[];
}

export function demoNames(tag: string) {
  return {
    competition: `Result Demo ${tag} League`,
    home: `Rovers ${tag} FC`,
    away: `Athletic ${tag} United`,
  };
}

function assertTag(tag: string): void {
  if (!/^[a-z0-9]{1,16}$/i.test(tag)) {
    throw new Error('the tag must be 1 to 16 letters or digits');
  }
}

/** The page the demo upstream serves: the match, scheduled or with its final score. */
function pageOf(tag: string, kickoff: Date, finished: boolean): string {
  const names = demoNames(tag);
  const empty = { home: null, away: null, htHome: null, htAway: null };
  return JSON.stringify({
    matches: [
      {
        id: `demo-${tag}`,
        league: names.competition,
        home: names.home,
        away: names.away,
        kickoff: kickoff.toISOString(),
        status: finished ? 'finished' : 'scheduled',
        score: finished ? DEMO_SCORE : empty,
      },
    ],
  });
}

export function demoSourceConfig(tag: string): Record<string, unknown> {
  return {
    allowedHosts: ['results.demo.invalid'],
    requests: [{ url: `https://results.demo.invalid/${tag}/matches.json`, purpose: 'results' }],
    sport: 'football',
    recordsPath: 'matches[*]',
    fields: {
      home: 'home',
      away: 'away',
      competition: { path: 'league' },
      kickoff: { path: 'kickoff', format: 'iso' },
      externalRef: 'id',
      status: { path: 'status', map: { scheduled: 'scheduled', finished: 'finished' } },
      score: {
        homePath: 'score.home',
        awayPath: 'score.away',
        htHomePath: 'score.htHome',
        htAwayPath: 'score.htAway',
      },
    },
    scoreBasis: 'regular_time',
  };
}

export async function seedResultDemo(
  deps: ResultDemoDeps,
  tag: string,
  options: { playerPhone?: string } = {},
): Promise<SeededResultDemo> {
  const { config, db } = deps;
  if (config.mode !== 'demo') throw new Error('seed-result-demo runs in OPERATING_MODE=demo only');
  assertTag(tag);
  const realNow = (deps.now ?? (() => new Date()))();
  const names = demoNames(tag);
  const sourceId = `result-demo-${tag}`;
  const upstreamId = `demo-${tag}`;
  const sportId = 'football';

  // 1. Catalogue rows, ratings, policy, source: each found or created, so a second run adds nothing.
  const [category] = await db
    .insert(schema.categories)
    .values({
      sportId,
      slug: `result-demo-${tag}`,
      name: { en: `Result demo ${tag}` },
      sortOrder: 900,
    })
    .onConflictDoNothing()
    .returning({ id: schema.categories.id });
  const categoryId =
    category?.id ??
    (
      await db
        .select({ id: schema.categories.id })
        .from(schema.categories)
        .where(
          and(
            eq(schema.categories.sportId, sportId),
            eq(schema.categories.slug, `result-demo-${tag}`),
          ),
        )
    )[0]!.id;
  const competitionSlug = `result-demo-${tag}-league`;
  await db
    .insert(schema.competitions)
    .values({ sportId, categoryId, slug: competitionSlug, name: { en: names.competition } })
    .onConflictDoNothing();
  const [competition] = await db
    .select({ id: schema.competitions.id })
    .from(schema.competitions)
    .where(
      and(eq(schema.competitions.sportId, sportId), eq(schema.competitions.slug, competitionSlug)),
    );
  const team = async (short: string, name: string): Promise<string> => {
    await db
      .insert(schema.teams)
      .values({ sportId, shortName: short, name: { en: name } })
      .onConflictDoNothing();
    const [row] = await db
      .select({ id: schema.teams.id })
      .from(schema.teams)
      .where(and(eq(schema.teams.sportId, sportId), eq(schema.teams.shortName, short)));
    return row!.id;
  };
  const homeTeam = await team(`RD-H-${tag}`, names.home);
  const awayTeam = await team(`RD-A-${tag}`, names.away);
  const competitionId = competition!.id;

  await db.transaction(async (tx) => {
    // Reviewed ratings from enough matches (rule O1): the model may price the match by itself.
    await setTeamRatings(tx, homeTeam, { attack: 1.3, defence: 0.85, matches: 10 }, actor);
    await setTeamRatings(tx, awayTeam, { attack: 1.0, defence: 1.05, matches: 10 }, actor);
    // The competition may create events and open them; results are never automatic here.
    await setCompetitionPolicy(
      tx,
      competitionId,
      { enabled: true, autoOpen: true, autoResults: false, extraTime: false },
      actor,
    );
    await upsertSource(
      tx,
      {
        id: sourceId,
        name: `Result demo ${tag} (offline)`,
        adapter: 'generic-json',
        upstream: sourceId,
        config: demoSourceConfig(tag),
      },
      actor,
    );
    await setSourceEnabled(tx, sourceId, true, actor);
  });

  // The kickoff of an already seeded match is read back, never moved.
  const [seededEvent] = await db
    .select({
      id: schema.events.id,
      feedRef: schema.events.feedRef,
      startTime: schema.events.startTime,
    })
    .from(schema.events)
    .where(
      and(eq(schema.events.competitionId, competitionId), eq(schema.events.homeTeamId, homeTeam)),
    );
  const kickoff =
    seededEvent?.startTime ??
    new Date(Math.floor((realNow.getTime() - KICKOFF_AGO_MS) / MINUTE) * MINUTE);

  // The only fake: what the network answers, and the clock the scraper reads.
  let clock = realNow;
  let served = pageOf(tag, kickoff, false);
  const fetchImpl: FetchLike = () =>
    Promise.resolve(
      new Response(served, { status: 200, headers: { 'content-type': 'application/json' } }),
    );
  const logger = deps.logger ?? pino({ level: 'silent' });
  const ctx: ScraperContext = createScraperContext({
    config,
    db,
    redis: deps.redis,
    logger,
    clock: () => new Date(clock.getTime()),
    fetcher: new PoliteFetcher({
      userAgent: scraperUserAgent(config.scraper),
      robots: 'off',
      minIntervalMs: 0,
      jitterFraction: 0,
      maxAttempts: 1,
      now: () => clock.getTime(),
      sleep: () => Promise.resolve(),
      fetchImpl,
    }),
    archive: new FileRawArchive(config.scraper.archiveDir, {
      now: () => new Date(clock.getTime()),
    }),
  });
  const readSource = async (at: Date, finished: boolean): Promise<void> => {
    clock = at;
    served = pageOf(tag, kickoff, finished);
    const source = await getSource(db, sourceId);
    const run = await runSource(ctx, source!, { trigger: 'manual' });
    if (run.status !== 'ok') throw new Error(`reading the demo source ended ${run.status}`);
  };

  // 2 and 3. The match is listed three days ahead; the scraper's gate creates the event.
  let eventId = seededEvent?.id;
  let feedRef = seededEvent?.feedRef ?? '';
  if (eventId === undefined) {
    const listedAt = new Date(kickoff.getTime() - 3 * DAY);
    await readSource(listedAt, false);
    const slugs = new Map(
      (await listCompetitionPolicies(db, { sportId })).map((row) => [row.competitionId, row.slug]),
    );
    const observations = (
      await listCurrentObservations(db, {
        kind: 'fixture',
        resolvedOnly: true,
        sourceIds: [sourceId],
        limit: 10,
      })
    ).flatMap((row) => {
      const resolved = toResolved(row, slugs);
      return resolved !== null && resolved.obs.kind === 'fixture' ? [resolved] : [];
    });
    const pricing = await pricingFor(ctx, homeTeam, awayTeam);
    const decision = decideFixture({
      observations: observations as Parameters<typeof decideFixture>[0]['observations'],
      candidates: [],
      policy: {
        competitionId,
        enabled: true,
        autoOpen: true,
        autoResults: false,
        extraTime: false,
      },
      now: listedAt,
      calibrated: pricing.calibrated,
      pricesSane: pricing.pricesSane,
    });
    if (decision.action !== 'create') {
      throw new Error(`the scraper's gate did not create the event (${decision.action})`);
    }
    const created = await applyCreate(ctx, decision, pricing, listedAt);
    if (!created.created) throw new Error('the event was not created');
    feedRef = decision.feedRef;
    const [row] = await db
      .select({ id: schema.events.id })
      .from(schema.events)
      .where(eq(schema.events.feedRef, feedRef));
    eventId = row!.id;
    // Still listed, as scheduled, an hour before kickoff.
    await readSource(new Date(kickoff.getTime() - HOUR), false);
  }

  // 4. The player's bets, placed as of two hours before kickoff (see the doc comment).
  const bets: SeededBet[] = [];
  if (options.playerPhone !== undefined) {
    const [user] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.phone, options.playerPhone));
    if (user === undefined) {
      throw new Error(
        `no player has the phone ${options.playerPhone}: sign up in the web app first`,
      );
    }
    const key = marketKey('1x2', null);
    const picks = await db
      .select({
        id: schema.selections.id,
        code: schema.selections.code,
        oddsMilli: schema.selections.oddsMilli,
      })
      .from(schema.selections)
      .innerJoin(schema.markets, eq(schema.markets.id, schema.selections.marketId))
      .where(and(eq(schema.markets.eventId, eventId!), eq(schema.markets.key, key)));
    const placedAt = new Date(kickoff.getTime() - 2 * HOUR);
    for (const [pick, code, stake] of [
      ['home', '1', HOME_STAKE],
      ['away', '2', AWAY_STAKE],
    ] as const) {
      const selection = picks.find((p) => p.code === code);
      if (selection === undefined) throw new Error(`the event has no ${code} selection`);
      const { result } = await withTxRetry(db, async (tx) => ({
        result: await placeBet(tx, {
          userId: user.id,
          legs: [{ selectionId: selection.id, oddsMilli: selection.oddsMilli }],
          stake,
          policy: 'any',
          idempotencyKey: `result-demo-${tag}-${pick}`,
          now: placedAt,
          settings: await loadGameSettings(tx),
          randomBytes: (size) => randomBytes(size),
        }),
      }));
      bets.push({
        shortId: result.bet.shortId,
        pick,
        stake: stake.toString(),
        oddsMilli: Number(result.bet.totalOddsMilli),
      });
    }
  }

  // 2 (last read). The final score appears in the upstream just now.
  const [resultSeen] = await db
    .select({ id: schema.scrapeObservations.id })
    .from(schema.scrapeObservations)
    .where(
      and(
        eq(schema.scrapeObservations.sourceId, sourceId),
        eq(schema.scrapeObservations.kind, 'result'),
      ),
    );
  if (resultSeen === undefined) await readSource(realNow, true);

  return {
    tag,
    sourceId,
    competition: { id: competitionId, name: names.competition },
    teams: { home: homeTeam, away: awayTeam },
    names: { home: names.home, away: names.away },
    eventId: eventId!,
    feedRef,
    kickoff: kickoff.toISOString(),
    score: DEMO_SCORE,
    upstreamId,
    bets,
  };
}

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  if (config.mode !== 'demo') throw new Error('seed-result-demo runs in OPERATING_MODE=demo only');
  const args = process.argv.slice(2);
  const playerAt = args.indexOf('--player');
  const playerPhone = playerAt >= 0 ? args[playerAt + 1] : undefined;
  if (playerAt >= 0 && (playerPhone === undefined || playerPhone.startsWith('--'))) {
    throw new Error('--player needs the phone number the player signed up with (+2519...)');
  }
  const tag = args.find((a, i) => !a.startsWith('--') && i !== playerAt + 1) ?? 'demo';
  const handle = createDb(config.databaseUrl, { max: 4 });
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 3 });
  try {
    const logger = pino(baseLoggerOptions({ level: 'warn', service: 'seed-result-demo' }));
    const seeded = await seedResultDemo(
      { config, db: handle.db, redis, logger },
      tag,
      playerPhone === undefined ? {} : { playerPhone },
    );
    process.stdout.write(`${JSON.stringify(seeded)}\n`);
  } finally {
    await Promise.allSettled([redis.quit(), handle.close()]);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
