import { readFileSync } from 'node:fs';
import { setSourceEnabled, upsertSource } from '@vamos/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { catalogDatabase, cliHarness, OPENFOOTBALL_SOURCE } from './cli-helpers';
import { SETUP_TIMEOUT } from './helpers';

let db: Awaited<ReturnType<typeof catalogDatabase>>;
let cli: ReturnType<typeof cliHarness>;
const actor = { system: 'test' };

const dataFile = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../../../docs/scraper-plan/data/${name}`, import.meta.url), 'utf8'),
  ) as {
    id: string;
    name: string;
    adapter: never;
    upstream: string;
    config: Record<string, unknown>;
  };

beforeAll(async () => {
  db = await catalogDatabase();
  cli = cliHarness({ db: db.db });
}, SETUP_TIMEOUT);
afterAll(async () => {
  await db?.drop();
}, SETUP_TIMEOUT);

describe('sources coverage', () => {
  it('says so when no source is enabled', async () => {
    expect(await cli.run('sources', 'coverage')).toMatchObject({
      code: 0,
      stdout: 'no enabled sources',
    });
  });

  it('prints the matrix per competition and flags a single result upstream', async () => {
    const footballData = dataFile('source-footballdata-en1.json');
    const scores = dataFile('source-theoddsapi-scores-en1.json');
    const prices = dataFile('source-theoddsapi-en1.json');
    const sources = [
      // Premier League: football-data.org (FT + HT), openfootball (FT + HT), The Odds API prices
      // with fixtures, and its scores source (same upstream as the prices).
      {
        ...footballData,
        config: {
          ...footballData.config,
          fields: {
            ...(footballData.config.fields as object),
            competition: { fixed: 'Premier League' },
          },
        },
      },
      OPENFOOTBALL_SOURCE,
      { ...prices, config: { ...prices.config, competition: 'Premier League' } },
      { ...scores, config: { ...scores.config, competition: 'Premier League' } },
      // Championship: openfootball alone.
      {
        ...OPENFOOTBALL_SOURCE,
        id: 'of-champ',
        config: {
          ...OPENFOOTBALL_SOURCE.config,
          requests: [
            {
              url: 'https://raw.githubusercontent.com/test/en2.json',
              competition: 'EFL Championship',
            },
          ],
        },
      },
      // Switched off: not counted.
      {
        ...scores,
        id: 'scores-off',
        config: { ...scores.config, competition: 'EFL Championship' },
      },
    ];
    await db.db.transaction(async (tx) => {
      for (const source of sources) {
        await upsertSource(tx, source as never, actor);
        if (source.id !== 'scores-off') await setSourceEnabled(tx, source.id, true, actor);
      }
    });

    const text = await cli.run('sources', 'coverage');
    expect(text.code).toBe(0);
    const lines = text.stdout.split('\n');
    expect(lines[0]).toMatch(
      /^competition\s+sources\s+upstreams\s+fixtures\s+FT\s+HT\s+basis known\s+flags$/,
    );
    expect(lines.find((l) => l.startsWith('premier-league'))).toMatch(
      /^premier-league\s+4\s+3\s+3\s+3\s+2\s+yes\s*$/,
    );
    expect(lines.find((l) => l.startsWith('championship'))).toMatch(
      /^championship\s+1\s+1\s+1\s+1\s+1\s+yes\s+single-result-upstream$/,
    );

    const json = await cli.run('sources', 'coverage', '--json');
    expect(JSON.parse(json.stdout)).toEqual({
      skipped: [],
      competitions: [
        {
          competition: 'championship',
          sources: 1,
          upstreams: 1,
          fixtureUpstreams: 1,
          fullTimeUpstreams: 1,
          halfTimeUpstreams: 1,
          basisUpstreams: 1,
          basisKnown: true,
          singleResultUpstream: true,
          flags: ['single-result-upstream'],
        },
        {
          competition: 'premier-league',
          sources: 4,
          upstreams: 3,
          fixtureUpstreams: 3,
          fullTimeUpstreams: 3,
          halfTimeUpstreams: 2,
          basisUpstreams: 3,
          basisKnown: true,
          singleResultUpstream: false,
          flags: [],
        },
      ],
    });
  });

  it('takes no arguments', async () => {
    expect((await cli.run('sources', 'coverage', 'extra')).code).toBe(2);
  });
});
