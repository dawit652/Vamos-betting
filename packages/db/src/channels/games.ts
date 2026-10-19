import {
  parseGameId,
  pickSelection,
  picksForSport,
  type ChannelLocale,
  type ChannelRefusal,
  type PickCode,
  type PickSelectionRef,
  type TextBetLeg,
  type UnavailablePickReason,
  type UssdGame,
  type UssdGameOption,
} from '@vamos/core';
import { and, eq, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  loadSelectionSnapshots,
  unavailableReason,
  type UnavailableReason,
} from '../betting/selections';
import type { DbExecutor } from '../ledger/types';
import { events, markets, selections, teams, type LocalizedName } from '../schema/catalog';

/** A leg of a channel bet resolved to its selection, priced now. */
export interface ChannelLeg {
  gameId: number;
  pick: PickCode;
  selectionId: string;
  eventId: string;
  /** The current price (milli): text bets take the odds at receipt. */
  oddsMilli: number;
  /** The event is in play (the bet will wait for live acceptance). */
  live: boolean;
}

export type ResolveLegsResult =
  { ok: true; legs: ChannelLeg[] } | { ok: false; refusal: ChannelRefusal };

/** The reason shown to the player for a selection that cannot be bet on. */
export function channelUnavailableReason(
  reason: Exclude<UnavailableReason, 'not_found'>,
): UnavailablePickReason {
  // A sport or competition switched off reads as the game being closed.
  return reason === 'inactive' ? 'event_closed' : reason;
}

/** The name in the reply language (Amharic falls back to English). */
export function channelName(name: LocalizedName, locale: ChannelLocale): string {
  return locale === 'am' ? (name.am ?? name.en) : name.en;
}

interface EventRow {
  eventId: string;
  gameId: number;
  sportId: string;
}

const isGameId = (gameId: number) => parseGameId(String(gameId)) === gameId;

async function loadEventsByGameId(
  exec: DbExecutor,
  gameIds: readonly number[],
): Promise<Map<number, EventRow>> {
  const ids = [...new Set(gameIds.filter(isGameId))];
  const found = new Map<number, EventRow>();
  if (ids.length === 0) return found;
  const rows = await exec
    .select({ eventId: events.id, gameId: events.gameId, sportId: events.sportId })
    .from(events)
    .where(inArray(events.gameId, ids));
  for (const row of rows) found.set(row.gameId, row);
  return found;
}

const pickKey = (eventId: string, ref: PickSelectionRef) =>
  `${eventId}|${ref.marketKey}|${ref.code}`;

/** Selection ids of the given (event, market key, code) picks, keyed by pickKey. */
async function loadPickSelectionIds(
  exec: DbExecutor,
  wanted: ReadonlyArray<{ eventId: string; ref: PickSelectionRef }>,
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (wanted.length === 0) return found;
  const eventIds = [...new Set(wanted.map((w) => w.eventId))];
  const keys = [...new Set(wanted.map((w) => w.ref.marketKey))];
  const rows = await exec
    .select({
      eventId: markets.eventId,
      marketKey: markets.key,
      code: selections.code,
      selectionId: selections.id,
    })
    .from(selections)
    .innerJoin(markets, eq(markets.id, selections.marketId))
    .where(and(inArray(markets.eventId, eventIds), inArray(markets.key, keys)));
  for (const row of rows) {
    found.set(pickKey(row.eventId, { marketKey: row.marketKey, code: row.code }), row.selectionId);
  }
  return found;
}

/**
 * Resolves the legs of a text bet (Game ID + pick) to selections priced
 * now. The first leg, in text order, that cannot be bet on gives the
 * refusal: `game_not_found`, `pick_not_offered` (the sport or the event has
 * no such market) or `pick_unavailable` with the reason. With
 * `lock: 'share'` the selections are locked FOR SHARE (as placeBet does), so
 * the prices read here hold until the transaction ends: take the player's
 * lock (lockUser) first to keep placeBet's lock order.
 */
export async function resolveTextBetLegs(
  exec: DbExecutor,
  legs: readonly TextBetLeg[],
  now: Date,
  options: { lock?: 'share' } = {},
): Promise<ResolveLegsResult> {
  const eventsByGame = await loadEventsByGameId(
    exec,
    legs.map((leg) => leg.gameId),
  );
  const refs = legs.map((leg) => {
    const event = eventsByGame.get(leg.gameId);
    const ref = event === undefined ? null : pickSelection(event.sportId, leg.pick);
    return { leg, event, ref };
  });
  const ids = await loadPickSelectionIds(
    exec,
    refs.flatMap(({ event, ref }) =>
      event === undefined || ref === null ? [] : [{ eventId: event.eventId, ref }],
    ),
  );
  // Only the legs' own selections (the lookup above can return more: it
  // matches every market key on every event of the bet).
  const wanted = refs.flatMap(({ event, ref }) => {
    const id =
      event === undefined || ref === null ? undefined : ids.get(pickKey(event.eventId, ref));
    return id === undefined ? [] : [id];
  });
  const snapshots = await loadSelectionSnapshots(
    exec,
    wanted,
    options.lock === 'share' ? { lock: 'share' } : {},
  );

  const resolved: ChannelLeg[] = [];
  for (const { leg, event, ref } of refs) {
    const { gameId, pick } = leg;
    if (event === undefined) return { ok: false, refusal: { code: 'game_not_found', gameId } };
    const selectionId = ref === null ? undefined : ids.get(pickKey(event.eventId, ref));
    const snapshot = selectionId === undefined ? undefined : snapshots.get(selectionId);
    if (selectionId === undefined || snapshot === undefined) {
      return { ok: false, refusal: { code: 'pick_not_offered', gameId, pick } };
    }
    const reason = unavailableReason(snapshot, now);
    if (reason === 'not_found') {
      return { ok: false, refusal: { code: 'pick_not_offered', gameId, pick } };
    }
    if (reason !== null) {
      return {
        ok: false,
        refusal: {
          code: 'pick_unavailable',
          gameId,
          pick,
          reason: channelUnavailableReason(reason),
        },
      };
    }
    resolved.push({
      gameId,
      pick,
      selectionId,
      eventId: snapshot.eventId,
      oddsMilli: snapshot.oddsMilli,
      live: snapshot.eventStatus === 'live',
    });
  }
  return { ok: true, legs: resolved };
}

const homeTeams = alias(teams, 'channel_home_team');
const awayTeams = alias(teams, 'channel_away_team');

/**
 * An event as the USSD menus show it: teams (in the reply language, with
 * short codes), whether it is in play, and the picks of its main markets
 * (PICK_CODES order) with their current odds and whether each can be bet on
 * now. null for an unknown Game ID. Reads only; locks nothing.
 */
export async function loadChannelGame(
  exec: DbExecutor,
  gameId: number,
  now: Date,
  locale: ChannelLocale,
): Promise<UssdGame | null> {
  if (!isGameId(gameId)) return null;
  const [event] = await exec
    .select({
      eventId: events.id,
      gameId: events.gameId,
      sportId: events.sportId,
      status: events.status,
      homeName: homeTeams.name,
      homeShort: homeTeams.shortName,
      awayName: awayTeams.name,
      awayShort: awayTeams.shortName,
    })
    .from(events)
    .innerJoin(homeTeams, eq(homeTeams.id, events.homeTeamId))
    .innerJoin(awayTeams, eq(awayTeams.id, events.awayTeamId))
    .where(eq(events.gameId, gameId))
    .limit(1);
  if (event === undefined) return null;

  const picks = picksForSport(event.sportId).flatMap((pick) => {
    const ref = pickSelection(event.sportId, pick);
    return ref === null ? [] : [{ pick, ref }];
  });
  const ids = await loadPickSelectionIds(
    exec,
    picks.map(({ ref }) => ({ eventId: event.eventId, ref })),
  );
  const snapshots = await loadSelectionSnapshots(exec, [...ids.values()]);
  const options: UssdGameOption[] = [];
  for (const { pick, ref } of picks) {
    const selectionId = ids.get(pickKey(event.eventId, ref));
    const snapshot = selectionId === undefined ? undefined : snapshots.get(selectionId);
    if (selectionId === undefined || snapshot === undefined) continue;
    options.push({
      pick,
      selectionId,
      oddsMilli: snapshot.oddsMilli,
      available: unavailableReason(snapshot, now) === null,
    });
  }
  return {
    gameId: event.gameId,
    home: { name: channelName(event.homeName, locale), short: event.homeShort },
    away: { name: channelName(event.awayName, locale), short: event.awayShort },
    live: event.status === 'live',
    options,
  };
}
