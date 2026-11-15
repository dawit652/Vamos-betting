import { pathToFileURL } from 'node:url';
import { loadConfig, loadDotEnv } from '@vamos/config';
import {
  addTeamAlias,
  createDb,
  finishRun,
  openReviewItem,
  schema,
  setCompetitionPolicy,
  setSourceEnabled,
  setTeamRatings,
  startRun,
  upsertSource,
  type Database,
} from '@vamos/db';
import { marketKey, type MarketTypeCode } from '@vamos/core';
import { normalizeName, ratingsKey, REPRICE_SUBJECT_SUFFIX } from '@vamos/scraper';

/**
 * DEMO/E2E ONLY: fills the back office's feed pages with realistic data in the DEMO database:
 * two sources with runs, two competitions, teams, events with a 1x2 market, an alias, and one OPEN
 * review item of every kind in the payload shape the contract documents. Everything carries the
 * `tag` (default: a random one), so a second run adds a second, independent set.
 *
 *   pnpm --filter @vamos/scraper-app seed:review [tag]
 *
 * Prints the ids as one JSON object on stdout. Refuses outside OPERATING_MODE=demo.
 */

const HOUR = 3_600_000;
const MINUTE = 60_000;
const actor = { system: 'seed-review-queue' };

export interface SeededReviewQueue {
  tag: string;
  sourceIds: { ok: string; broken: string };
  competitions: { league: string; cup: string };
  teams: { home: string; away: string; spare: string; other: string };
  alias: { raw: string; teamId: string };
  items: Record<string, string>;
  events: Record<string, string>;
  names: { home: string; away: string };
}

export async function seedReviewQueue(db: Database, tag: string): Promise<SeededReviewQueue> {
  const now = new Date();
  const names = { home: `Alpha ${tag} FC`, away: `Beta ${tag} United` };

  const [sport] = await db.select().from(schema.sports).limit(1);
  if (sport === undefined) throw new Error('no sports: run pnpm db:seed first');
  const sportId = 'football';
  const [category] = await db
    .insert(schema.categories)
    .values({ sportId, slug: `feed-${tag}`, name: { en: `Feed ${tag}` }, sortOrder: 900 })
    .returning({ id: schema.categories.id });
  const competition = async (slug: string, name: string) =>
    (
      await db
        .insert(schema.competitions)
        .values({ sportId, categoryId: category!.id, slug: `${slug}-${tag}`, name: { en: name } })
        .returning({ id: schema.competitions.id })
    )[0]!.id;
  const league = await competition('league', `Feed League ${tag}`);
  const cup = await competition('cup', `Feed Cup ${tag}`);
  const team = async (short: string, name: string) =>
    (
      await db
        .insert(schema.teams)
        .values({ sportId, shortName: short, name: { en: name } })
        .returning({ id: schema.teams.id })
    )[0]!.id;
  const home = await team('ALP-' + tag, names.home);
  const away = await team('BET-' + tag, names.away);
  const spare = await team('GAM-' + tag, `Gamma ${tag} Town`);
  const other = await team('DEL-' + tag, `Delta ${tag} Rovers`);

  const RATINGS = { attack: 1.2, defence: 0.9, matches: 10 };
  await db.transaction(async (tx) => {
    await setTeamRatings(tx, home, RATINGS, actor);
    await setTeamRatings(tx, away, RATINGS, actor);
    await setCompetitionPolicy(
      tx,
      league,
      { enabled: true, autoOpen: false, autoResults: true, extraTime: false },
      actor,
    );
  });

  const sourceIds = { ok: `seed-ok-${tag}`, broken: `seed-broken-${tag}` };
  await db.transaction(async (tx) => {
    await upsertSource(
      tx,
      {
        id: sourceIds.ok,
        name: `Seed fixtures ${tag}`,
        adapter: 'openfootball',
        upstream: `https://example.test/${tag}/fixtures.json`,
        config: {},
      },
      actor,
    );
    await setSourceEnabled(tx, sourceIds.ok, true, actor);
    await upsertSource(
      tx,
      {
        id: sourceIds.broken,
        name: `Seed results ${tag}`,
        adapter: 'generic-json',
        upstream: `https://example.test/${tag}/results.json`,
        config: {},
      },
      actor,
    );
    await setSourceEnabled(tx, sourceIds.broken, true, actor);
  });
  for (let i = 3; i >= 1; i -= 1) {
    const startedAt = new Date(now.getTime() - (10 + i * 20) * MINUTE);
    const run = await startRun(db, { sourceId: sourceIds.ok, startedAt });
    await finishRun(db, run.id, {
      status: 'ok',
      recordsSeen: 40,
      recordsAccepted: 38,
      finishedAt: new Date(startedAt.getTime() + 2000),
    });
  }
  const brokenRun = await startRun(db, {
    sourceId: sourceIds.broken,
    startedAt: new Date(now.getTime() - 5 * MINUTE),
  });
  await finishRun(db, brokenRun.id, {
    status: 'broken',
    recordsSeen: 3,
    recordsAccepted: 0,
    finishedAt: new Date(now.getTime() - 4 * MINUTE),
  });

  const alias = { raw: `Alpha ${tag} F.C.`, teamId: home };
  await db.transaction((tx) =>
    addTeamAlias(
      tx,
      { sportId, aliasNorm: normalizeName(alias.raw), sourceId: null, teamId: home },
      actor,
    ),
  );

  let gameId = 7000 + Math.floor(Math.random() * 1000);
  const events: Record<string, string> = {};
  const newEvent = async (
    key: string,
    startsInMs: number,
    extra: { status?: 'scheduled' | 'live'; bettingOpen?: boolean; withMarket?: boolean } = {},
  ) => {
    const startTime = new Date(now.getTime() + startsInMs);
    const [event] = await db
      .insert(schema.events)
      .values({
        gameId: (gameId += 1),
        sportId,
        competitionId: league,
        homeTeamId: home,
        awayTeamId: away,
        startTime,
        status: extra.status ?? 'scheduled',
        bettingOpen: extra.bettingOpen ?? true,
        feedProvider: 'seed',
        feedRef: `seed-${tag}-${key}`,
      })
      .returning({ id: schema.events.id, gameId: schema.events.gameId });
    if (extra.withMarket !== false) {
      const type = '1x2' as MarketTypeCode;
      const [market] = await db
        .insert(schema.markets)
        .values({
          eventId: event!.id,
          type,
          line: null,
          key: marketKey(type, null),
          status: 'open',
        })
        .returning({ id: schema.markets.id });
      await db.insert(schema.selections).values(
        [
          ['1', 1850],
          ['X', 3400],
          ['2', 4200],
        ].map(([code, oddsMilli]) => ({
          marketId: market!.id,
          code: code as string,
          oddsMilli: oddsMilli as number,
          status: 'open' as const,
        })),
      );
    }
    events[key] = event!.id;
    const ref = {
      eventId: event!.id,
      gameId: String(event!.gameId),
      home: names.home,
      away: names.away,
      kickoff: startTime.toISOString(),
    };
    return { id: event!.id, startTime, ref };
  };

  const items: Record<string, string> = {};
  let age = 0;
  const open = async (
    key: string,
    kind: Parameters<typeof openReviewItem>[1]['kind'],
    payload: Record<string, unknown>,
    options: { severity?: 'info' | 'warning' | 'critical'; subject?: string; title?: string } = {},
  ) => {
    age += 1;
    const { item } = await db.transaction((tx) =>
      openReviewItem(tx, {
        kind,
        subjectKey: options.subject ?? `seed-${tag}-${key}`,
        severity: options.severity ?? 'warning',
        title: options.title ?? `${kind.replaceAll('_', ' ')} [${tag}]`,
        payload,
        now: new Date(now.getTime() - (30 - age) * MINUTE),
      }),
    );
    items[key] = item.id;
  };

  const unknownTeam = (
    raw: string,
    suggestions: { id: string; name: string; score: number }[],
  ) => ({
    sport: 'football',
    raw,
    competition: `Feed League ${tag}`,
    sourceId: sourceIds.ok,
    suggestions,
  });
  await open(
    'unknown_team',
    'unknown_team',
    unknownTeam(`Gamma ${tag} T.`, [
      { id: spare, name: `Gamma ${tag} Town`, score: 0.91 },
      { id: other, name: `Delta ${tag} Rovers`, score: 0.42 },
    ]),
  );
  await open('unknown_team_dismiss', 'unknown_team', unknownTeam(`Nobody ${tag} XI`, []), {
    severity: 'info',
  });
  await open('unknown_competition', 'unknown_competition', {
    sport: 'football',
    raw: `Feed Lig ${tag}`,
    sourceId: sourceIds.ok,
    suggestions: [{ id: league, name: `Feed League ${tag}`, score: 0.8 }],
  });

  const oddsEvent = await newEvent('odds', 3 * HOUR, { bettingOpen: false });
  await open('odds_approval', 'odds_approval', {
    ...oddsEvent.ref,
    reason: 'auto_open_off',
    markets: [
      {
        market: '1x2',
        selections: [
          { name: names.home, oddsMilli: 1850 },
          { name: 'Draw', oddsMilli: 3400 },
          { name: names.away, oddsMilli: 4200 },
        ],
      },
    ],
  });

  const repriceEvent = await newEvent('reprice', 4 * HOUR);
  const feedRef = `seed-${tag}-reprice`;
  await open(
    'reprice',
    'odds_approval',
    {
      ...repriceEvent.ref,
      reason: 'price_move_too_large 1x2 1 1850 to 2400',
      markets: [
        {
          market: '1x2',
          selections: [
            { name: names.home, oddsMilli: 2400, previousOddsMilli: 1850 },
            { name: 'Draw', oddsMilli: 3400, previousOddsMilli: 3400 },
            { name: names.away, oddsMilli: 3000, previousOddsMilli: 4200 },
          ],
        },
      ],
      proposal: [
        {
          type: '1x2',
          line: null,
          selections: [
            { code: '1', oddsMilli: 2400 },
            { code: 'X', oddsMilli: 3400 },
            { code: '2', oddsMilli: 3000 },
          ],
        },
      ],
      ratingsKey: ratingsKey(RATINGS, RATINGS),
    },
    { subject: `${feedRef}${REPRICE_SUBJECT_SUFFIX}` },
  );

  const kickoffEvent = await newEvent('kickoff', 5 * HOUR);
  await open('kickoff_change', 'kickoff_change', {
    eventId: kickoffEvent.id,
    currentKickoff: kickoffEvent.startTime.toISOString(),
    proposedKickoff: new Date(kickoffEvent.startTime.getTime() + 2 * HOUR).toISOString(),
    sources: [
      {
        sourceId: sourceIds.ok,
        upstream: `fx-${tag}`,
        changedAt: new Date(now.getTime() - 20 * MINUTE).toISOString(),
      },
    ],
    hasBets: false,
  });

  const resultEvent = await newEvent('result', -3 * HOUR, { status: 'live' });
  const vote = {
    sourceId: sourceIds.ok,
    upstream: `fx-${tag}`,
    changedAt: new Date(now.getTime() - 15 * MINUTE).toISOString(),
  };
  const resultPayload = {
    ...resultEvent.ref,
    score: { home: 2, away: 1, htHome: 1, htAway: 0 },
    sources: [vote, { ...vote, sourceId: sourceIds.broken }],
    exposure: { openBets: 3, totalStake: '450000' },
  };
  await open('result_ready', 'result_ready', resultPayload);
  const unverifiedEvent = await newEvent('result_unverified', -4 * HOUR, { status: 'live' });
  await open('result_unverified', 'result_unverified', {
    ...resultPayload,
    ...unverifiedEvent.ref,
    score: { home: 0, away: 0, htHome: null, htAway: null },
    sources: [vote],
  });
  const disputeEvent = await newEvent('dispute', -5 * HOUR, { status: 'live' });
  const observation = (sourceId: string, h: number, a: number) => ({
    sourceId,
    upstream: `fx-${tag}`,
    status: 'finished',
    score: { home: h, away: a, htHome: null, htAway: null },
    scoreBasis: 'regular_time',
    changedAt: vote.changedAt,
  });
  await open('result_conflict', 'result_conflict', {
    ...disputeEvent.ref,
    appliedScore: null,
    observations: [observation(sourceIds.ok, 2, 1), observation(sourceIds.broken, 1, 1)],
    exposure: { openBets: 1, totalStake: '10000' },
  });
  await open('result_correction', 'result_correction', {
    ...disputeEvent.ref,
    appliedScore: { home: 2, away: 1, htHome: null, htAway: null },
    observations: [observation(sourceIds.ok, 2, 2)],
  });
  await open(
    'ratings_uncalibrated',
    'ratings_uncalibrated',
    {
      ...oddsEvent.ref,
      reason: `${names.home} has 3 rated matches`,
      markets: [],
    },
    { subject: `seed-${tag}-ratings` },
  );

  await open('fixture_conflict', 'fixture_conflict', { detail: `Two sources disagree on ${tag}` });
  await open('fixture_missing', 'fixture_missing', { detail: `A fixture of ${tag} vanished` });
  await open('cancellation_proposed', 'cancellation_proposed', { detail: `Cancelled? ${tag}` });
  await open('score_basis_unknown', 'score_basis_unknown', { detail: `Basis unclear ${tag}` });
  await open(
    'source_broken',
    'source_broken',
    {
      sourceId: sourceIds.broken,
      runId: brokenRun.id,
      reason: 'yield dropped to 0 against a usual 38',
      recordsAccepted: 0,
      baseline: 38,
    },
    { severity: 'critical' },
  );

  return {
    tag,
    sourceIds,
    competitions: { league, cup },
    teams: { home, away, spare, other },
    alias,
    items,
    events,
    names,
  };
}

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  if (config.mode !== 'demo') throw new Error('seed-review-queue runs in OPERATING_MODE=demo only');
  const tag = process.argv[2] ?? Math.random().toString(36).slice(2, 8);
  const handle = createDb(config.databaseUrl, { max: 2 });
  try {
    const seeded = await seedReviewQueue(handle.db, tag);
    process.stdout.write(`${JSON.stringify(seeded)}\n`);
  } finally {
    await handle.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
