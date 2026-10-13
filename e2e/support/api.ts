import type { APIRequestContext } from '@playwright/test';
import type {
  BetView,
  EventListResponse,
  EventSummary,
  MyBetsResponse,
  WalletResponse,
} from '@vamos/contracts';
import { API_URL } from './env';

/**
 * Read-only API helpers for assertions and for choosing fixtures. They run
 * through a Playwright request context: pass `page.request` to act as the
 * signed-in player (it shares the browser's cookies; GETs need no CSRF).
 */

const SPORTS = ['football', 'basketball', 'tennis', 'volleyball'] as const;

async function getJson<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(`${API_URL}${path}`);
  if (!response.ok()) {
    throw new Error(`GET ${path} failed: ${response.status()} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

export function getWallet(request: APIRequestContext): Promise<WalletResponse> {
  return getJson(request, '/wallet');
}

export async function myBets(
  request: APIRequestContext,
  status: 'open' | 'settled',
): Promise<BetView[]> {
  return (await getJson<MyBetsResponse>(request, `/me/bets?status=${status}`)).items;
}

export function getBet(request: APIRequestContext, id: string): Promise<BetView> {
  return getJson(request, `/me/bets/${encodeURIComponent(id)}`);
}

/** Scheduled events of every sport starting within 72 h, soonest first. */
export async function upcomingEvents(request: APIRequestContext): Promise<EventSummary[]> {
  const lists = await Promise.all(
    SPORTS.map((sport) =>
      getJson<EventListResponse>(request, `/events?sport=${sport}&filter=upcoming&limit=50`),
    ),
  );
  return lists
    .flatMap((list) => list.items)
    .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
}

/** True when every selection of the event's main market can be backed now. */
function mainMarketOpen(event: EventSummary): boolean {
  const market = event.mainMarket;
  return (
    event.status === 'scheduled' &&
    market !== null &&
    market.status === 'open' &&
    market.selections.length > 0 &&
    market.selections.every((selection) => selection.open)
  );
}

/**
 * The `count` soonest scheduled events (any sport) that kick off at least
 * `minLeadMs` from now and whose main market is open. With the fast
 * simulator (FEED_ROLLING_EVERY_MINUTES=1) a rolling fixture starts every
 * minute, so these all kick off and finish within a few minutes. Waits up to
 * `timeoutMs` for the feed to offer enough of them.
 */
export async function soonestEvents(
  request: APIRequestContext,
  count: number,
  options: { minLeadMs: number; maxLeadMs: number; timeoutMs?: number },
): Promise<EventSummary[]> {
  const deadline = Date.now() + (options.timeoutMs ?? 90_000);
  for (;;) {
    const now = Date.now();
    const picked = (await upcomingEvents(request)).filter((event) => {
      const lead = Date.parse(event.startTime) - now;
      return lead >= options.minLeadMs && lead <= options.maxLeadMs && mainMarketOpen(event);
    });
    if (picked.length >= count) return picked.slice(0, count);
    if (Date.now() > deadline) {
      throw new Error(
        `only ${picked.length} of ${count} events kick off within ${options.maxLeadMs / 1000} s; ` +
          'is the worker running with FEED_ROLLING_EVERY_MINUTES=1?',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

/** Everything a signed-in player's POST needs besides the body: the CSRF echo (cookie sessions). */
async function csrfHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const state = await request.storageState();
  const csrf = state.cookies.find((cookie) => cookie.name === 'vamos_csrf')?.value;
  return csrf === undefined ? {} : { 'x-csrf-token': csrf };
}

/**
 * Places a bet through the API as the signed-in player (`page.request`) and
 * returns it. For setup that is not what the spec is about: the UI betslip is
 * covered by bet-flow.spec.ts.
 */
export async function placeBetApi(
  request: APIRequestContext,
  legs: { selectionId: string; oddsMilli: number }[],
  stake: string,
): Promise<BetView> {
  const response = await request.post(`${API_URL}/bets`, {
    headers: { ...(await csrfHeaders(request)), 'idempotency-key': crypto.randomUUID() },
    data: { legs, stake, oddsChangePolicy: 'any' },
  });
  if (!response.ok()) {
    throw new Error(`POST /bets failed: ${response.status()} ${await response.text()}`);
  }
  return (await response.json()) as BetView;
}
