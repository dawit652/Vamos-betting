import type { PlaceBetRequest } from '@vamos/contracts';
import { isApiClientError } from '@/lib/api/errors';

/**
 * The idempotency key of the next bet placement, kept with the slip (not in
 * the drawer) so a retry can never place a bet twice.
 *
 * The API stores a bet under its key. Sent again with the same body, the key
 * replays the stored bet; with another body it answers 422
 * `idempotency_key_reused` and writes nothing; unused, it places the body.
 * So the slip keeps ONE key until a bet comes back for it, whatever happens
 * in between (timeouts, 5xx, refusals, odds moving, the player editing the
 * slip, the drawer closing, a reload): every attempt reuses it, and a second
 * bet is impossible. Bodies sent with the key that got no answer (timeout,
 * network error, 5xx) are remembered: when the API later says the key is
 * taken, one of them was placed, and replaying it returns that bet.
 *
 * Pure (no React, no storage) so it is unit tested; BetslipProvider keeps it
 * in state and in sessionStorage.
 */
export interface PendingPlacement {
  key: string;
  /** Bodies sent with `key` whose outcome is unknown, oldest first. */
  unresolved: PlaceBetRequest[];
}

export const PLACEMENT_STORAGE_KEY = 'vamos_betslip_placement_v1';

/** Bodies remembered per key (a player retrying more often than this is very unlikely). */
export const MAX_UNRESOLVED = 5;

/** The pending placement to use for the next attempt: the kept one, or a new one with `newKey`. */
export function placementFor(
  pending: PendingPlacement | null,
  newKey: () => string,
): PendingPlacement {
  return pending ?? { key: newKey(), unresolved: [] };
}

/**
 * True when a failed POST /bets may still have placed the bet: no answer
 * (status 0: timeout, network error) or a server error (5xx, also from a
 * proxy) that may have come after the commit. Any other answer is a refusal.
 */
export function isAmbiguousFailure(status: number): boolean {
  return status === 0 || status >= 500;
}

/** The same request, ignoring nothing: legs (with odds), stake and policy. */
export function sameBody(a: PlaceBetRequest, b: PlaceBetRequest): boolean {
  return (
    a.stake === b.stake &&
    a.oddsChangePolicy === b.oddsChangePolicy &&
    a.legs.length === b.legs.length &&
    a.legs.every((leg, i) => {
      const other = b.legs[i];
      return (
        other !== undefined &&
        other.selectionId === leg.selectionId &&
        other.oddsMilli === leg.oddsMilli
      );
    })
  );
}

/** Records a body whose attempt got no clear answer (kept once, newest last, capped). */
export function withUnresolved(pending: PendingPlacement, body: PlaceBetRequest): PendingPlacement {
  const others = pending.unresolved.filter((b) => !sameBody(b, body));
  const unresolved = [...others, body];
  // Drop the newest-but-one rather than the oldest: the oldest is the likeliest to have been placed.
  while (unresolved.length > MAX_UNRESOLVED) unresolved.splice(unresolved.length - 2, 1);
  return { key: pending.key, unresolved };
}

/** True when the slip still holds exactly the selections and stake of `body`. */
export function sameSelections(
  body: PlaceBetRequest,
  legs: readonly { selectionId: string }[],
  stake: string,
): boolean {
  if (body.stake !== stake || body.legs.length !== legs.length) return false;
  const ids = new Set(legs.map((leg) => leg.selectionId));
  return body.legs.every((leg) => ids.has(leg.selectionId));
}

export type PlacementResult<B> =
  /** A bet came back: this attempt's, or (`earlier` set) one an unanswered attempt placed. */
  | { kind: 'placed'; bet: B; earlier: PlaceBetRequest | null }
  /** The key is taken by a bet none of the remembered bodies match (storage was lost). */
  | { kind: 'placedEarlier' }
  /** No bet for this attempt; `error` says why (a refusal, or no answer). */
  | { kind: 'failed'; error: unknown };

/**
 * One tap on Place: sends `body` with the kept key (or a new one), saving the
 * pending placement BEFORE the request goes out and updating it after:
 * cleared once a bet comes back, extended with `body` when there was no clear
 * answer, kept as it is after a refusal (no bet exists for the key then, so
 * the next attempt may use it for any body).
 */
export async function placeOnce<B>(input: {
  body: PlaceBetRequest;
  pending: PendingPlacement | null;
  newKey: () => string;
  send: (body: PlaceBetRequest, key: string) => Promise<B>;
  save: (pending: PendingPlacement | null) => void;
}): Promise<PlacementResult<B>> {
  const { body, send, save } = input;
  const pending = placementFor(input.pending, input.newKey);
  save(pending);
  try {
    const bet = await send(body, pending.key);
    save(null);
    return { kind: 'placed', bet, earlier: null };
  } catch (error) {
    if (!isApiClientError(error)) return { kind: 'failed', error };
    if (error.code !== 'idempotency_key_reused') {
      if (isAmbiguousFailure(error.status)) save(withUnresolved(pending, body));
      return { kind: 'failed', error };
    }
  }
  // The key is taken: an earlier, unanswered attempt was placed. Its body replays it.
  for (const earlier of pending.unresolved) {
    try {
      const bet = await send(earlier, pending.key);
      save(null);
      return { kind: 'placed', bet, earlier };
    } catch (error) {
      if (isApiClientError(error) && error.code === 'idempotency_key_reused') continue;
      // No clear answer again: everything is kept for the next tap.
      return { kind: 'failed', error };
    }
  }
  save(null);
  return { kind: 'placedEarlier' };
}

// ---- persistence (sessionStorage) -------------------------------------------------------------

const KEY_PATTERN = /^[\x21-\x7e]{8,100}$/;
const POLICIES: readonly string[] = ['none', 'higher', 'any'];

function parseBody(raw: unknown): PlaceBetRequest | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.stake !== 'string' || !/^\d{1,15}$/.test(r.stake)) return null;
  if (typeof r.oddsChangePolicy !== 'string' || !POLICIES.includes(r.oddsChangePolicy)) return null;
  if (!Array.isArray(r.legs) || r.legs.length === 0 || r.legs.length > 40) return null;
  const legs: PlaceBetRequest['legs'] = [];
  for (const leg of r.legs as unknown[]) {
    if (leg === null || typeof leg !== 'object') return null;
    const { selectionId, oddsMilli } = leg as Record<string, unknown>;
    if (typeof selectionId !== 'string' || selectionId.length === 0 || selectionId.length > 64) {
      return null;
    }
    if (typeof oddsMilli !== 'number' || !Number.isInteger(oddsMilli)) return null;
    legs.push({ selectionId, oddsMilli });
  }
  return {
    legs,
    stake: r.stake,
    oddsChangePolicy: r.oddsChangePolicy as PlaceBetRequest['oddsChangePolicy'],
  };
}

/** Restores what `serializePlacement` stored; null for nothing or garbage. */
export function parseStoredPlacement(json: string | null): PendingPlacement | null {
  if (json === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.key !== 'string' || !KEY_PATTERN.test(r.key)) return null;
  const unresolved = Array.isArray(r.unresolved)
    ? r.unresolved
        .map(parseBody)
        .filter((b): b is PlaceBetRequest => b !== null)
        .slice(0, MAX_UNRESOLVED)
    : [];
  return { key: r.key, unresolved };
}

export function serializePlacement(pending: PendingPlacement): string {
  return JSON.stringify(pending);
}
