import { randomUUID } from 'node:crypto';
import { marketKey, type MarketTypeCode } from '@vamos/core';
import type { Database } from '@vamos/db';
import {
  categories,
  competitions,
  events,
  markets,
  selections,
  sports,
  teams,
} from '@vamos/db/schema';

/**
 * Catalogue fixture inserters shared by the API tests: rows are written
 * straight to the test database.
 */

export type Name = { en: string; am?: string };
export type EventStatus = (typeof events.$inferInsert)['status'];
export type MarketStatus = (typeof markets.$inferInsert)['status'];
export type SelectionStatus = (typeof selections.$inferInsert)['status'];

export async function insertSport(
  db: Database,
  id: string,
  name: Name,
  sortOrder: number,
  active = true,
) {
  await db.insert(sports).values({ id, name, sortOrder, active });
}

export async function insertCategory(
  db: Database,
  sportId: string,
  slug: string,
  name: Name,
  sortOrder: number,
): Promise<string> {
  const [row] = await db
    .insert(categories)
    .values({ sportId, slug, name, sortOrder })
    .returning({ id: categories.id });
  return row!.id;
}

export async function insertCompetition(
  db: Database,
  values: {
    sportId: string;
    categoryId: string;
    slug: string;
    name: Name;
    featured?: boolean;
    active?: boolean;
    sortOrder?: number;
  },
): Promise<string> {
  const [row] = await db.insert(competitions).values(values).returning({ id: competitions.id });
  return row!.id;
}

export async function insertTeam(db: Database, sportId: string, shortName: string, name: Name) {
  const [row] = await db
    .insert(teams)
    .values({ sportId, shortName, name })
    .returning({ id: teams.id });
  return row!.id;
}

let nextGameId = 1000;

export interface EventFixture {
  sportId: string;
  competitionId: string;
  homeTeamId: string;
  awayTeamId: string;
  startTime: Date;
  status?: EventStatus;
  bettingOpen?: boolean;
  liveMinute?: number | null;
  period?: string | null;
  score?: [number, number] | null;
  htScore?: [number, number] | null;
  gameId?: number;
}

export async function insertEvent(db: Database, fixture: EventFixture) {
  const gameId = fixture.gameId ?? nextGameId++;
  const [row] = await db
    .insert(events)
    .values({
      gameId,
      sportId: fixture.sportId,
      competitionId: fixture.competitionId,
      homeTeamId: fixture.homeTeamId,
      awayTeamId: fixture.awayTeamId,
      startTime: fixture.startTime,
      status: fixture.status ?? 'scheduled',
      bettingOpen: fixture.bettingOpen ?? true,
      liveMinute: fixture.liveMinute ?? null,
      period: fixture.period ?? null,
      scoreHome: fixture.score?.[0] ?? null,
      scoreAway: fixture.score?.[1] ?? null,
      htScoreHome: fixture.htScore?.[0] ?? null,
      htScoreAway: fixture.htScore?.[1] ?? null,
      feedProvider: 'test',
      feedRef: randomUUID(),
    })
    .returning({ id: events.id });
  return { id: row!.id, gameId };
}

export type SelectionFixture = [code: string, oddsMilli: number, status?: SelectionStatus];

export async function insertMarket(
  db: Database,
  eventId: string,
  type: string,
  line: string | null,
  selectionRows: readonly SelectionFixture[],
  status: MarketStatus = 'open',
) {
  let key: string;
  try {
    key = marketKey(type as MarketTypeCode, line);
  } catch {
    key = line === null ? type : `${type}:${line}`;
  }
  const [market] = await db
    .insert(markets)
    .values({ eventId, type, line, key, status })
    .returning({ id: markets.id });
  const selectionIds: Record<string, string> = {};
  if (selectionRows.length > 0) {
    const rows = await db
      .insert(selections)
      .values(
        selectionRows.map(([code, oddsMilli, selectionStatus]) => ({
          marketId: market!.id,
          code,
          oddsMilli,
          status: selectionStatus ?? 'open',
        })),
      )
      .returning({ id: selections.id, code: selections.code });
    for (const row of rows) selectionIds[row.code] = row.id;
  }
  return { id: market!.id, selectionIds };
}

export const ONE_X_TWO: SelectionFixture[] = [
  ['2', 4200],
  ['1', 1850],
  ['X', 3400],
];
