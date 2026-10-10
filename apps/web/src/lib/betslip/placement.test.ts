import type { PlaceBetRequest } from '@vamos/contracts';
import { describe, expect, it } from 'vitest';
import { ApiClientError } from '@/lib/api/errors';
import {
  isAmbiguousFailure,
  MAX_UNRESOLVED,
  parseStoredPlacement,
  placeOnce,
  sameSelections,
  serializePlacement,
  withUnresolved,
  type PendingPlacement,
} from './placement';

const body = (odds: number[], stake = '5000', ids = ['a', 'b']): PlaceBetRequest => ({
  legs: ids.map((selectionId, i) => ({ selectionId, oddsMilli: odds[i] ?? 1500 })),
  stake,
  oddsChangePolicy: 'higher',
});

/**
 * POST /bets as the API behaves (packages/db placeBet): a used key replays its
 * bet for the same body and answers 422 `idempotency_key_reused` for another;
 * an unused key places the body. `next` decides what the network does to the
 * next request: deliver the answer, commit then lose the answer (timeout),
 * lose the request before the server (network error), fail before the commit
 * (503), or refuse it (409 odds_changed).
 */
type Fate = 'ok' | 'commitThenTimeout' | 'lostRequest' | 'error503' | 'refused';

function fakeApi() {
  const bets = new Map<string, { id: number; body: PlaceBetRequest }>();
  let nextId = 1;
  const fates: Fate[] = [];
  const send = (request: PlaceBetRequest, key: string): Promise<{ id: number }> => {
    const fate = fates.shift() ?? 'ok';
    if (fate === 'lostRequest') return Promise.reject(new ApiClientError(0, 'network_error', ''));
    if (fate === 'error503') return Promise.reject(new ApiClientError(503, 'http_503', ''));
    const existing = bets.get(key);
    if (existing !== undefined) {
      if (JSON.stringify(existing.body) !== JSON.stringify(request)) {
        return Promise.reject(new ApiClientError(422, 'idempotency_key_reused', ''));
      }
      if (fate === 'commitThenTimeout') return Promise.reject(new ApiClientError(0, 'timeout', ''));
      return Promise.resolve({ id: existing.id });
    }
    if (fate === 'refused') return Promise.reject(new ApiClientError(409, 'odds_changed', ''));
    const bet = { id: nextId++, body: request };
    bets.set(key, bet);
    if (fate === 'commitThenTimeout') return Promise.reject(new ApiClientError(0, 'timeout', ''));
    return Promise.resolve({ id: bet.id });
  };
  return { bets, fates, send };
}

function client(api: ReturnType<typeof fakeApi>) {
  let stored: PendingPlacement | null = null;
  let keys = 0;
  return {
    get stored() {
      return stored;
    },
    place: (request: PlaceBetRequest) =>
      placeOnce({
        body: request,
        pending: stored,
        newKey: () => `bet-key-${++keys}`,
        send: api.send,
        save: (next) => {
          stored = next === null ? null : parseStoredPlacement(serializePlacement(next));
        },
      }),
  };
}

describe('placeOnce', () => {
  it('places with a new key and forgets it once the bet is back', async () => {
    const api = fakeApi();
    const c = client(api);
    expect(await c.place(body([1500, 2000]))).toEqual({
      kind: 'placed',
      bet: { id: 1 },
      earlier: null,
    });
    expect(c.stored).toBeNull();
    await c.place(body([1500, 2000]));
    expect(api.bets.size).toBe(2); // a new intent gets a new key
  });

  it('a retry after a lost answer replays the bet instead of placing a second one', async () => {
    const api = fakeApi();
    const c = client(api);
    api.fates.push('commitThenTimeout');
    expect((await c.place(body([1500, 2000]))).kind).toBe('failed');
    expect(c.stored?.unresolved).toHaveLength(1);
    const retry = await c.place(body([1500, 2000]));
    expect(retry).toEqual({ kind: 'placed', bet: { id: 1 }, earlier: null });
    expect(api.bets.size).toBe(1);
  });

  it('odds moving after a lost answer cannot mint a new key (finding: double bet on drift)', async () => {
    const api = fakeApi();
    const c = client(api);
    api.fates.push('commitThenTimeout');
    await c.place(body([1500, 2000]));
    // The live stream moved a price; the player taps Place again.
    const retry = await c.place(body([1550, 2000]));
    expect(retry).toEqual({ kind: 'placed', bet: { id: 1 }, earlier: body([1500, 2000]) });
    expect(api.bets.size).toBe(1);
    expect(c.stored).toBeNull();
  });

  it('after a lost request (nothing placed), the edited slip is placed under the same key', async () => {
    const api = fakeApi();
    const c = client(api);
    api.fates.push('lostRequest');
    await c.place(body([1500, 2000]));
    const key = c.stored?.key;
    const retry = await c.place(body([1500, 2000], '10000'));
    expect(retry).toEqual({ kind: 'placed', bet: { id: 1 }, earlier: null });
    expect([...api.bets.keys()]).toEqual([key]);
    expect(api.bets.get(key!)?.body.stake).toBe('10000');
  });

  it('keeps the key after a refusal and after a 5xx', async () => {
    const api = fakeApi();
    const c = client(api);
    api.fates.push('refused');
    await c.place(body([1500, 2000]));
    const key = c.stored?.key;
    expect(c.stored?.unresolved).toEqual([]);
    api.fates.push('error503');
    await c.place(body([1600, 2000]));
    expect(c.stored?.key).toBe(key);
    expect(c.stored?.unresolved).toEqual([body([1600, 2000])]);
  });

  it('reports a placed earlier attempt it cannot replay (storage lost)', async () => {
    const api = fakeApi();
    const c = client(api);
    api.fates.push('commitThenTimeout');
    await c.place(body([1500, 2000]));
    // Simulates losing the remembered bodies but not the key.
    const kept = c.stored!;
    const result = await placeOnce({
      body: body([1700, 2000]),
      pending: { key: kept.key, unresolved: [] },
      newKey: () => 'never-used',
      send: api.send,
      save: () => undefined,
    });
    expect(result).toEqual({ kind: 'placedEarlier' });
    expect(api.bets.size).toBe(1);
  });

  it('never places two bets for one intent, whatever the network does (randomised)', async () => {
    const fates: Fate[] = ['ok', 'commitThenTimeout', 'lostRequest', 'error503', 'refused'];
    let seed = 42;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let run = 0; run < 300; run += 1) {
      const api = fakeApi();
      const c = client(api);
      let confirmed = 0;
      for (let tap = 0; tap < 8; tap += 1) {
        api.fates.push(fates[random(fates.length)]!);
        // The player or the stream may change odds or stake between taps.
        const request = body([1500 + random(3) * 10, 2000], random(4) === 0 ? '9000' : '5000');
        const result = await c.place(request);
        if (result.kind === 'placed' || result.kind === 'placedEarlier') confirmed += 1;
        // Every bet on the server is one the player was told about, except at
        // most one whose answer is still outstanding (the pending key's).
        const outstanding = c.stored !== null && api.bets.has(c.stored.key) ? 1 : 0;
        expect(api.bets.size).toBe(confirmed + outstanding);
      }
    }
  });
});

describe('pending placement helpers', () => {
  it('treats no answer and 5xx as ambiguous, any other answer as a refusal', () => {
    expect(isAmbiguousFailure(0)).toBe(true);
    expect(isAmbiguousFailure(500)).toBe(true);
    expect(isAmbiguousFailure(502)).toBe(true);
    expect(isAmbiguousFailure(409)).toBe(false);
    expect(isAmbiguousFailure(422)).toBe(false);
    expect(isAmbiguousFailure(429)).toBe(false);
  });

  it('remembers each unanswered body once, oldest kept, capped', () => {
    let pending: PendingPlacement = { key: 'bet-key-1', unresolved: [] };
    pending = withUnresolved(pending, body([1500, 2000]));
    pending = withUnresolved(pending, body([1500, 2000]));
    expect(pending.unresolved).toHaveLength(1);
    for (let i = 1; i <= 10; i += 1) pending = withUnresolved(pending, body([1500 + i, 2000]));
    expect(pending.unresolved).toHaveLength(MAX_UNRESOLVED);
    expect(pending.unresolved[0]).toEqual(body([1500, 2000]));
    expect(pending.unresolved.at(-1)).toEqual(body([1510, 2000]));
  });

  it('round-trips through storage and rejects garbage', () => {
    const pending = { key: 'bet-0123456789', unresolved: [body([1500, 2000])] };
    expect(parseStoredPlacement(serializePlacement(pending))).toEqual(pending);
    expect(parseStoredPlacement(null)).toBeNull();
    expect(parseStoredPlacement('{')).toBeNull();
    expect(parseStoredPlacement('{"key":"short"}')).toBeNull();
    expect(
      parseStoredPlacement(
        JSON.stringify({ key: 'bet-0123456789', unresolved: [{ legs: [], stake: '1' }, 7] }),
      ),
    ).toEqual({ key: 'bet-0123456789', unresolved: [] });
  });

  it('compares a placed body with the slip by selections and stake', () => {
    const legs = [{ selectionId: 'b' }, { selectionId: 'a' }];
    expect(sameSelections(body([1500, 2000]), legs, '5000')).toBe(true);
    expect(sameSelections(body([1500, 2000]), legs, '6000')).toBe(false);
    expect(sameSelections(body([1500, 2000]), [{ selectionId: 'a' }], '5000')).toBe(false);
  });
});
