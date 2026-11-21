import { randomUUID } from 'node:crypto';
import {
  ApiErrorSchema,
  AuditLogResponse,
  BetView,
  CancelJackpotRoundResponse,
  DashboardResponse,
  DepositView,
  KycQueueResponse,
  KycReviewResponse,
  LiabilityListResponse,
  PlayerDetailView,
  PlayerListResponse,
  ResultEventResponse,
  SetOddsResponse,
  StaffBetDetailView,
  StaffBetListResponse,
  StaffDepositListResponse,
  StaffJackpotEntryListResponse,
  StaffJackpotRoundListResponse,
  StaffSettingsResponse,
  StaffWithdrawalChangeResponse,
  StaffWithdrawalListResponse,
  StaffWithdrawalView,
  TradingEventListResponse,
  TradingEventView,
  VoidResponse,
  WalletResponse,
  WithdrawalView,
} from '@vamos/contracts';
import { toWire } from '@vamos/core';
import { settleMarketBets, type Database } from '@vamos/db';
import { auditLog, kycProfiles } from '@vamos/db/schema';
import { and, eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asStaff, seedStaff, staffLogin, type StaffSession } from './admin-helpers';
import {
  insertCategory,
  insertCompetition,
  insertEvent,
  insertMarket,
  insertSport,
  insertTeam,
  ONE_X_TWO,
} from './fixtures';
import {
  createTestContext,
  registerAndLogin,
  type LoggedInUser,
  type TestContext,
} from './helpers';

let ctx: TestContext;
let db: Database;
const s = {} as Record<
  'admin' | 'trader' | 'finance' | 'kyc' | 'support' | 'compliance',
  StaffSession
>;
const HOUR = 3_600_000;
const birr = (n: number) => BigInt(n) * 100n;

const ev = {} as Record<'future' | 'past' | 'later', string>;
const mk = {} as Record<'future1x2' | 'futureOu' | 'past1x2' | 'later1x2', string>;
const sel = {} as Record<'home' | 'draw' | 'over' | 'laterHome', string>;

beforeAll(async () => {
  ctx = await createTestContext();
  db = ctx.db.db;
  await seedStaff(ctx);
  for (const role of ['admin', 'trader', 'finance', 'kyc', 'support', 'compliance'] as const) {
    s[role] = await staffLogin(ctx, role);
  }

  await insertSport(db, 'football', { en: 'Football' }, 10);
  const category = await insertCategory(db, 'football', 'ethiopia', { en: 'Ethiopia' }, 10);
  const league = await insertCompetition(db, {
    sportId: 'football',
    categoryId: category,
    slug: 'ethiopian-premier-league',
    name: { en: 'Ethiopian Premier League' },
  });
  const team = (short: string, en: string) => insertTeam(db, 'football', short, { en });
  const stGeorge = await team('STG', 'St. George');
  const fasil = await team('FAS', 'Fasil Kenema');
  const bunna = await team('BUN', 'Ethiopia Bunna');
  const sidama = await team('SID', 'Sidama Coffee');
  const base = { sportId: 'football', competitionId: league };
  const now = ctx.clock.now.getTime();

  ev.future = (
    await insertEvent(db, {
      ...base,
      homeTeamId: stGeorge,
      awayTeamId: fasil,
      startTime: new Date(now + 3 * HOUR),
    })
  ).id;
  const future1x2 = await insertMarket(db, ev.future, '1x2', null, ONE_X_TWO);
  mk.future1x2 = future1x2.id;
  sel.home = future1x2.selectionIds['1']!;
  sel.draw = future1x2.selectionIds['X']!;
  const futureOu = await insertMarket(db, ev.future, 'ou', '2.5', [
    ['over', 1950],
    ['under', 1800],
  ]);
  mk.futureOu = futureOu.id;
  sel.over = futureOu.selectionIds['over']!;

  ev.past = (
    await insertEvent(db, {
      ...base,
      homeTeamId: bunna,
      awayTeamId: sidama,
      startTime: new Date(now - 2 * HOUR),
      status: 'live',
      liveMinute: 89,
      score: [1, 0],
    })
  ).id;
  mk.past1x2 = (await insertMarket(db, ev.past, '1x2', null, ONE_X_TWO)).id;

  ev.later = (
    await insertEvent(db, {
      ...base,
      homeTeamId: fasil,
      awayTeamId: bunna,
      startTime: new Date(now + 6 * HOUR),
    })
  ).id;
  const later1x2 = await insertMarket(db, ev.later, '1x2', null, ONE_X_TWO);
  mk.later1x2 = later1x2.id;
  sel.laterHome = later1x2.selectionIds['1']!;
});

afterAll(async () => {
  await ctx?.close();
});

const apiError = (response: LightMyRequestResponse) => ApiErrorSchema.parse(response.json()).error;
const bearer = (user: LoggedInUser) => ({ authorization: `Bearer ${user.sessionToken}` });

function expectOk(response: LightMyRequestResponse, status = 200) {
  expect(response.statusCode, response.body).toBe(status);
  return response.json<unknown>();
}

async function topUp(user: LoggedInUser, amount: bigint) {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/wallet/demo-topup',
    payload: { amount: toWire(amount) },
    headers: { ...bearer(user), 'idempotency-key': randomUUID() },
  });
  expectOk(response);
}

async function cashOf(user: LoggedInUser): Promise<bigint> {
  const response = await ctx.app.inject({ method: 'GET', url: '/wallet', headers: bearer(user) });
  return BigInt(WalletResponse.parse(response.json()).cash);
}

async function placeBet(user: LoggedInUser, selectionId: string, oddsMilli: number, stake: bigint) {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/bets',
    payload: { stake: toWire(stake), legs: [{ selectionId, oddsMilli }] },
    headers: { ...bearer(user), 'idempotency-key': randomUUID() },
  });
  return BetView.parse(expectOk(response, 201));
}

/** Audit actions written by `staff` on `targetId`. */
async function staffAudit(staff: StaffSession, targetId: string): Promise<string[]> {
  const rows = await db
    .select({ action: auditLog.action })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.actorType, 'admin'),
        eq(auditLog.actorId, staff.id),
        eq(auditLog.targetId, targetId),
      ),
    )
    .orderBy(auditLog.id);
  return rows.map((row) => row.action);
}

describe('dashboard', () => {
  it('reports a window and refuses a bad one', async () => {
    const from = new Date(ctx.clock.now.getTime() - 24 * HOUR).toISOString();
    const to = new Date(ctx.clock.now.getTime() + HOUR).toISOString();
    const ok = await asStaff(ctx, s.finance, 'GET', `/admin/dashboard?from=${from}&to=${to}`);
    const body = DashboardResponse.parse(expectOk(ok));
    expect(body.from).toBe(from);
    const reversed = await asStaff(ctx, s.finance, 'GET', `/admin/dashboard?from=${to}&to=${from}`);
    expect(reversed.statusCode).toBe(422);
    expect(apiError(reversed).code).toBe('invalid_range');
    expect((await asStaff(ctx, s.finance, 'GET', '/admin/dashboard')).statusCode).toBe(400);
  });
});

describe('trading', () => {
  let player: LoggedInUser;
  let homeBet: BetView;
  let overBet: BetView;

  beforeAll(async () => {
    player = await registerAndLogin(ctx);
    await topUp(player, birr(1_000));
    homeBet = await placeBet(player, sel.home, 1850, birr(100));
    overBet = await placeBet(player, sel.over, 1950, birr(50));
  });

  it('searches events and shows their markets with open stakes', async () => {
    const list = TradingEventListResponse.parse(
      expectOk(await asStaff(ctx, s.trader, 'GET', '/admin/trading/events?q=st.%20george')),
    );
    expect(list.items.map((item) => item.id)).toEqual([ev.future]);
    expect(list.items[0]).toMatchObject({ openBets: 2, openStake: toWire(birr(150)) });

    const event = TradingEventView.parse(
      expectOk(await asStaff(ctx, s.trader, 'GET', `/admin/trading/events/${ev.future}`)),
    );
    const home = event.markets
      .flatMap((market) => market.selections)
      .find((selection) => selection.id === sel.home);
    expect(home).toMatchObject({ openBets: 1, openStake: toWire(birr(100)) });
    expect(home?.liability).toBe(homeBet.potentialGross);
    expect(
      (await asStaff(ctx, s.trader, 'GET', `/admin/trading/events/${randomUUID()}`)).statusCode,
    ).toBe(404);
  });

  it('reprices, suspends and resumes, audited with the trader', async () => {
    const odds = SetOddsResponse.parse(
      expectOk(
        await asStaff(ctx, s.trader, 'POST', `/admin/trading/selections/${sel.draw}/odds`, {
          oddsMilli: 3500,
          reason: 'sharp money',
        }),
      ),
    );
    expect(odds).toMatchObject({ changed: true, previousOddsMilli: 3400, oddsMilli: 3500 });
    expect(await staffAudit(s.trader, sel.draw)).toContain('catalog.odds.manual');

    const suspend = await asStaff(
      ctx,
      s.trader,
      'POST',
      `/admin/trading/events/${ev.future}/suspend`,
      {
        reason: 'injury news',
      },
    );
    expect(expectOk(suspend)).toEqual({ changed: true });
    const suspended = TradingEventView.parse(
      expectOk(await asStaff(ctx, s.trader, 'GET', `/admin/trading/events/${ev.future}`)),
    );
    expect(suspended.markets.every((market) => market.status === 'suspended')).toBe(true);
    expect(suspended.markets[0]?.suspendedBy).toBe('trader');
    expect(
      expectOk(
        await asStaff(ctx, s.trader, 'POST', `/admin/trading/events/${ev.future}/resume`, {}),
      ),
    ).toEqual({ changed: true });
    expect(await staffAudit(s.trader, ev.future)).toEqual(
      expect.arrayContaining(['catalog.event.suspended', 'catalog.event.resumed']),
    );

    expect(
      expectOk(
        await asStaff(ctx, s.trader, 'POST', `/admin/trading/markets/${mk.later1x2}/status`, {
          status: 'suspended',
        }),
      ),
    ).toEqual({ changed: true });
    expect(
      expectOk(
        await asStaff(ctx, s.trader, 'POST', `/admin/trading/markets/${mk.later1x2}/status`, {
          status: 'open',
        }),
      ),
    ).toEqual({ changed: true });
    expect(
      expectOk(
        await asStaff(ctx, s.trader, 'POST', `/admin/trading/events/${ev.later}/betting`, {
          open: false,
        }),
      ),
    ).toEqual({ changed: true });
    expect(
      expectOk(
        await asStaff(ctx, s.trader, 'POST', `/admin/trading/events/${ev.later}/betting`, {
          open: true,
        }),
      ),
    ).toEqual({ changed: true });

    // A support user cannot touch trading.
    const forbidden = await asStaff(
      ctx,
      s.support,
      'POST',
      `/admin/trading/events/${ev.future}/suspend`,
      {},
    );
    expect(forbidden.statusCode).toBe(403);
    expect(apiError(forbidden).code).toBe('forbidden');
  });

  it('voids a selection and a market; the bets settle void and are refunded', async () => {
    const before = await cashOf(player);
    const voided = VoidResponse.parse(
      expectOk(
        await asStaff(ctx, s.trader, 'POST', `/admin/trading/selections/${sel.over}/void`, {
          reason: 'wrong line offered',
        }),
      ),
    );
    expect(voided).toMatchObject({
      outcome: 'voided',
      marketId: mk.futureOu,
      selectionIds: [sel.over],
      affectedBets: 1,
    });
    const again = VoidResponse.parse(
      expectOk(
        await asStaff(ctx, s.trader, 'POST', `/admin/trading/selections/${sel.over}/void`, {
          reason: 'again',
        }),
      ),
    );
    expect(again.outcome).toBe('unchanged');
    expect(
      (await asStaff(ctx, s.trader, 'POST', `/admin/trading/markets/${mk.future1x2}/void`, {}))
        .statusCode,
    ).toBe(400);
    const market = VoidResponse.parse(
      expectOk(
        await asStaff(ctx, s.trader, 'POST', `/admin/trading/markets/${mk.future1x2}/void`, {
          reason: 'match fixing suspicion',
        }),
      ),
    );
    expect(market).toMatchObject({ outcome: 'voided', marketStatus: 'void', affectedBets: 1 });
    expect(await staffAudit(s.trader, mk.future1x2)).toContain('catalog.market.voided');

    // The worker's settlement step (market.resulted), run here directly.
    await db.transaction(async (tx) => {
      await settleMarketBets(tx, mk.futureOu, ctx.clock.now);
      await settleMarketBets(tx, mk.future1x2, ctx.clock.now);
    });
    for (const bet of [homeBet, overBet]) {
      const detail = StaffBetDetailView.parse(
        expectOk(await asStaff(ctx, s.support, 'GET', `/admin/bets/${bet.id}`)),
      );
      expect(detail).toMatchObject({ status: 'void', userId: player.userId, phone: player.phone });
      expect(detail.settledNet).toBe(bet.stake);
    }
    expect(await cashOf(player)).toBe(before + birr(150));
  });

  it('results an event and corrects it only with a reason', async () => {
    const url = `/admin/trading/events/${ev.past}/result`;
    const first = ResultEventResponse.parse(
      expectOk(
        await asStaff(ctx, s.trader, 'POST', url, {
          status: 'finished',
          score: { home: 2, away: 1 },
        }),
      ),
    );
    expect(first).toMatchObject({ outcome: 'resulted', status: 'finished', marketsSettled: 1 });
    // Once resulted, any further result is a correction: a reason is required, even to repeat it.
    const same = ResultEventResponse.parse(
      expectOk(
        await asStaff(ctx, s.trader, 'POST', url, {
          status: 'finished',
          score: { home: 2, away: 1 },
          reason: 'double check',
        }),
      ),
    );
    expect(same.outcome).toBe('unchanged');
    const noReason = await asStaff(ctx, s.trader, 'POST', url, {
      status: 'finished',
      score: { home: 2, away: 2 },
    });
    expect(noReason.statusCode).toBe(422);
    expect(apiError(noReason).code).toBe('correction_reason_required');
    const corrected = ResultEventResponse.parse(
      expectOk(
        await asStaff(ctx, s.trader, 'POST', url, {
          status: 'finished',
          score: { home: 2, away: 2 },
          reason: 'late equaliser missed',
        }),
      ),
    );
    expect(corrected.outcome).toBe('corrected');
    expect(await staffAudit(s.trader, ev.past)).toEqual([
      'catalog.event.resulted',
      'catalog.event.result_corrected',
    ]);
    const early = await asStaff(ctx, s.trader, 'POST', `/admin/trading/events/${ev.later}/result`, {
      status: 'finished',
      score: { home: 1, away: 0 },
    });
    expect(early.statusCode).toBe(409);
    expect(apiError(early).code).toBe('event_not_started');
  });

  it('searches bets and shows liabilities and big bets', async () => {
    const open = await placeBet(player, sel.laterHome, 1850, birr(200));
    const mine = StaffBetListResponse.parse(
      expectOk(await asStaff(ctx, s.compliance, 'GET', `/admin/bets?userId=${player.userId}`)),
    );
    expect(mine.items.map((bet) => bet.id).sort()).toEqual(
      [homeBet.id, overBet.id, open.id].sort(),
    );
    const byShortId = StaffBetListResponse.parse(
      expectOk(
        await asStaff(
          ctx,
          s.compliance,
          'GET',
          `/admin/bets?shortId=${open.shortId.toLowerCase()}`,
        ),
      ),
    );
    expect(byShortId.items.map((bet) => bet.id)).toEqual([open.id]);
    const openOnly = StaffBetListResponse.parse(
      expectOk(await asStaff(ctx, s.compliance, 'GET', '/admin/bets?status=open&limit=1')),
    );
    expect(openOnly.items.map((bet) => bet.id)).toEqual([open.id]);

    const liabilities = LiabilityListResponse.parse(
      expectOk(
        await asStaff(ctx, s.compliance, 'GET', `/admin/risk/liabilities?eventId=${ev.later}`),
      ),
    );
    expect(liabilities.items).toHaveLength(1);
    expect(liabilities.items[0]).toMatchObject({
      selectionId: sel.laterHome,
      bets: 1,
      stake: toWire(birr(200)),
      liability: open.potentialGross,
    });
    const big = StaffBetListResponse.parse(
      expectOk(await asStaff(ctx, s.trader, 'GET', `/admin/risk/big-bets?minStake=${birr(150)}`)),
    );
    expect(big.items.map((bet) => bet.id)).toEqual([open.id]);
  });
});

describe('players and KYC', () => {
  it('finds a player, shows the detail and reviews a pending KYC profile', async () => {
    const player = await registerAndLogin(ctx);
    await topUp(player, birr(100));
    const search = PlayerListResponse.parse(
      expectOk(await asStaff(ctx, s.support, 'GET', `/admin/users?q=${player.phone.slice(-8)}`)),
    );
    expect(search.items.map((item) => item.id)).toEqual([player.userId]);
    const detail = PlayerDetailView.parse(
      expectOk(await asStaff(ctx, s.support, 'GET', `/admin/users/${player.userId}`)),
    );
    expect(detail).toMatchObject({ id: player.userId, phone: player.phone });
    expect(detail.kyc.status).toBe('unverified');
    expect(detail.balances.cash).toBe(toWire(birr(100)));
    expect(detail.openBets).toEqual({ count: 0, amount: '0' });
    expect(detail.recentTransactions).toMatchObject([
      { type: 'demo_topup', amount: toWire(birr(100)), balanceAfter: toWire(birr(100)) },
    ]);
    expect((await asStaff(ctx, s.support, 'GET', `/admin/users/${randomUUID()}`)).statusCode).toBe(
      404,
    );

    await db.insert(kycProfiles).values({
      userId: player.userId,
      status: 'pending',
      provider: 'mock',
      idNumberLast4: '1234',
      verifiedName: 'Test Player',
      submittedAt: ctx.clock.now,
    });
    const queue = KycQueueResponse.parse(expectOk(await asStaff(ctx, s.kyc, 'GET', '/admin/kyc')));
    expect(queue.items.map((item) => item.userId)).toContain(player.userId);
    expect(queue.items[0]).not.toHaveProperty('idNumberHash');

    const url = `/admin/kyc/${player.userId}/review`;
    expect((await asStaff(ctx, s.kyc, 'POST', url, { decision: 'reject' })).statusCode).toBe(400);
    const approved = KycReviewResponse.parse(
      expectOk(await asStaff(ctx, s.kyc, 'POST', url, { decision: 'approve' })),
    );
    expect(approved).toMatchObject({ changed: true, profile: { status: 'verified' } });
    const reject = await asStaff(ctx, s.kyc, 'POST', url, { decision: 'reject', reason: 'late' });
    expect(reject.statusCode).toBe(409);
    expect(apiError(reject).code).toBe('kyc_not_pending');
    expect(await staffAudit(s.kyc, player.userId)).toContain('kyc.approved');
  });
});

describe('settings and withdrawals', () => {
  let player: LoggedInUser;

  it('edits settings with validation, audited', async () => {
    const view = StaffSettingsResponse.parse(
      expectOk(await asStaff(ctx, s.finance, 'GET', '/admin/settings')),
    );
    const payments = { ...view.settings.payments, autoApproveBelow: '0', wageringMultiplierBps: 0 };
    const updated = StaffSettingsResponse.parse(
      expectOk(await asStaff(ctx, s.admin, 'PUT', '/admin/settings/payments', { value: payments })),
    );
    expect(updated.settings.payments).toEqual(payments);
    expect(updated.changes.find((change) => change.key === 'payments')?.updatedBy).toBe(s.admin.id);
    expect(await staffAudit(s.admin, 'payments')).toEqual(['settings.updated']);

    const invalid = await asStaff(ctx, s.admin, 'PUT', '/admin/settings/tax', {
      value: { ...view.settings.tax, rateBps: 20_000 },
    });
    expect(invalid.statusCode).toBe(422);
    expect(apiError(invalid).code).toBe('invalid_setting');
    expect(
      (await asStaff(ctx, s.admin, 'PUT', '/admin/settings/nope', { value: 1 })).statusCode,
    ).toBe(404);
    expect(
      (await asStaff(ctx, s.finance, 'PUT', '/admin/settings/payments', { value: payments }))
        .statusCode,
    ).toBe(403);
  });

  it('edits the house liability caps: validated, audited, and no cap by default', async () => {
    const view = StaffSettingsResponse.parse(
      expectOk(await asStaff(ctx, s.finance, 'GET', '/admin/settings')),
    );
    expect(view.settings.riskLimits).toEqual({
      maxSelectionLiability: null,
      maxEventLiability: null,
    });
    const caps = { maxSelectionLiability: '50000000', maxEventLiability: '250000000' };
    const updated = StaffSettingsResponse.parse(
      expectOk(await asStaff(ctx, s.admin, 'PUT', '/admin/settings/risk_limits', { value: caps })),
    );
    expect(updated.settings.riskLimits).toEqual(caps);
    expect(await staffAudit(s.admin, 'risk_limits')).toEqual(['settings.updated']);

    for (const value of [
      { maxSelectionLiability: '0', maxEventLiability: null },
      { maxSelectionLiability: '300', maxEventLiability: '200' },
    ]) {
      const refused = await asStaff(ctx, s.admin, 'PUT', '/admin/settings/risk_limits', { value });
      expect(refused.statusCode).toBe(422);
    }
    expect(
      (await asStaff(ctx, s.finance, 'PUT', '/admin/settings/risk_limits', { value: caps }))
        .statusCode,
    ).toBe(403);

    // Back to no caps, so the rest of this file is unaffected.
    const none = { maxSelectionLiability: null, maxEventLiability: null };
    const cleared = StaffSettingsResponse.parse(
      expectOk(await asStaff(ctx, s.admin, 'PUT', '/admin/settings/risk_limits', { value: none })),
    );
    expect(cleared.settings.riskLimits).toEqual(none);
  });

  it('edits the board caps (Hulusport and Narobet matches): ETB 20,000 per match by default', async () => {
    const view = StaffSettingsResponse.parse(
      expectOk(await asStaff(ctx, s.finance, 'GET', '/admin/settings')),
    );
    const byDefault = { maxSelectionLiability: null, maxEventLiability: '2000000' };
    expect(view.settings.boardRiskLimits).toEqual(byDefault);
    const caps = { maxSelectionLiability: null, maxEventLiability: '5000000' };
    const updated = StaffSettingsResponse.parse(
      expectOk(
        await asStaff(ctx, s.admin, 'PUT', '/admin/settings/board_risk_limits', { value: caps }),
      ),
    );
    expect(updated.settings.boardRiskLimits).toEqual(caps);
    expect(await staffAudit(s.admin, 'board_risk_limits')).toEqual(['settings.updated']);
    const refused = await asStaff(ctx, s.admin, 'PUT', '/admin/settings/board_risk_limits', {
      value: { maxSelectionLiability: null, maxEventLiability: '0' },
    });
    expect(refused.statusCode).toBe(422);
    expect(
      (await asStaff(ctx, s.finance, 'PUT', '/admin/settings/board_risk_limits', { value: caps }))
        .statusCode,
    ).toBe(403);
    // Back to the default, so the rest of this file is unaffected.
    expectOk(
      await asStaff(ctx, s.admin, 'PUT', '/admin/settings/board_risk_limits', { value: byDefault }),
    );
  });

  it('edits the market families (plan task 2.5): validated, audited, today by default', async () => {
    const view = StaffSettingsResponse.parse(
      expectOk(await asStaff(ctx, s.finance, 'GET', '/admin/settings')),
    );
    const defaults = {
      marginBps: { main: 600, derivative: 700, long: 1200 },
      typeMarginBps: {},
      factoryLiabilityShareBps: 2500,
      minWeeklyStake: '10000000',
      firstHalfShare: null,
      drawCorrection: null,
    };
    expect(view.settings.marketFamilies).toEqual(defaults);
    const changed = {
      ...defaults,
      typeMarginBps: { htft: 1400 },
      factoryLiabilityShareBps: 1000,
    };
    const updated = StaffSettingsResponse.parse(
      expectOk(
        await asStaff(ctx, s.admin, 'PUT', '/admin/settings/market_families', { value: changed }),
      ),
    );
    expect(updated.settings.marketFamilies).toEqual(changed);
    expect(await staffAudit(s.admin, 'market_families')).toEqual(['settings.updated']);

    for (const value of [
      { ...defaults, marginBps: { main: 10_001, derivative: 700, long: 1200 } },
      { ...defaults, typeMarginBps: { '1x2': 500 } },
      { ...defaults, factoryLiabilityShareBps: -1 },
      { ...defaults, minWeeklyStake: '-1' },
    ]) {
      const refused = await asStaff(ctx, s.admin, 'PUT', '/admin/settings/market_families', {
        value,
      });
      expect(refused.statusCode).toBe(422);
    }
    expect(
      (await asStaff(ctx, s.finance, 'PUT', '/admin/settings/market_families', { value: changed }))
        .statusCode,
    ).toBe(403);

    const back = StaffSettingsResponse.parse(
      expectOk(
        await asStaff(ctx, s.admin, 'PUT', '/admin/settings/market_families', { value: defaults }),
      ),
    );
    expect(back.settings.marketFamilies).toEqual(defaults);
  });

  it('lets finance approve and reject withdrawals', async () => {
    player = await registerAndLogin(ctx);
    await db.insert(kycProfiles).values({
      userId: player.userId,
      status: 'verified',
      provider: 'mock',
      verifiedName: 'Test Player',
    });
    const deposit = await ctx.app.inject({
      method: 'POST',
      url: '/payments/deposits',
      payload: { amount: toWire(birr(500)) },
      headers: { ...bearer(player), 'idempotency-key': randomUUID() },
    });
    const intent = DepositView.parse(expectOk(deposit, 201));
    expectOk(
      await ctx.app.inject({
        method: 'POST',
        url: '/dev/payments/phone',
        payload: { depositId: intent.id, decision: 'approve', pin: '1234' },
        headers: bearer(player),
      }),
    );
    const withdraw = async (amount: bigint) =>
      WithdrawalView.parse(
        expectOk(
          await ctx.app.inject({
            method: 'POST',
            url: '/payments/withdrawals',
            payload: { amount: toWire(amount) },
            headers: { ...bearer(player), 'idempotency-key': randomUUID() },
          }),
          201,
        ),
      );
    const first = await withdraw(birr(200));
    expect(first.status).toBe('requested');

    const queue = StaffWithdrawalListResponse.parse(
      expectOk(await asStaff(ctx, s.finance, 'GET', '/admin/withdrawals?status=requested')),
    );
    expect(queue.items.map((item) => item.id)).toEqual([first.id]);
    expect(queue.items[0]?.player.phone).toBe(player.phone);
    StaffWithdrawalView.parse(
      expectOk(await asStaff(ctx, s.compliance, 'GET', `/admin/withdrawals/${first.id}`)),
    );
    // Compliance may look but not approve.
    expect(
      (await asStaff(ctx, s.compliance, 'POST', `/admin/withdrawals/${first.id}/approve`))
        .statusCode,
    ).toBe(403);

    const approved = StaffWithdrawalChangeResponse.parse(
      expectOk(await asStaff(ctx, s.finance, 'POST', `/admin/withdrawals/${first.id}/approve`)),
    );
    expect(approved).toMatchObject({
      changed: true,
      withdrawal: { status: 'approved', approvedBy: s.finance.id },
    });
    expect(await staffAudit(s.finance, first.id)).toContain('payment.withdrawal_approved');

    // Flag the approved payout for a closer look, then clear it (both audited).
    const flagged = StaffWithdrawalChangeResponse.parse(
      expectOk(
        await asStaff(ctx, s.finance, 'POST', `/admin/withdrawals/${first.id}/flag`, {
          note: 'check the recipient name',
        }),
      ),
    );
    expect(flagged.withdrawal.flagReason).toBe('staff_review');
    const flaggedQueue = StaffWithdrawalListResponse.parse(
      expectOk(await asStaff(ctx, s.finance, 'GET', '/admin/withdrawals?flagged=true')),
    );
    expect(flaggedQueue.items.map((item) => item.id)).toEqual([first.id]);
    const cleared = StaffWithdrawalChangeResponse.parse(
      expectOk(
        await asStaff(ctx, s.finance, 'POST', `/admin/withdrawals/${first.id}/clear-flag`, {
          note: 'name confirmed',
        }),
      ),
    );
    expect(cleared.withdrawal.flagReason).toBeNull();
    expect((await staffAudit(s.finance, first.id)).length).toBeGreaterThanOrEqual(3);

    const second = await withdraw(birr(100));
    const cashBefore = await cashOf(player);
    expect(
      (await asStaff(ctx, s.finance, 'POST', `/admin/withdrawals/${second.id}/reject`, {}))
        .statusCode,
    ).toBe(400);
    const rejected = StaffWithdrawalChangeResponse.parse(
      expectOk(
        await asStaff(ctx, s.finance, 'POST', `/admin/withdrawals/${second.id}/reject`, {
          reason: 'name mismatch',
        }),
      ),
    );
    expect(rejected.withdrawal.status).toBe('rejected');
    expect(await cashOf(player)).toBe(cashBefore + birr(100));

    StaffDepositListResponse.parse(
      expectOk(await asStaff(ctx, s.finance, 'GET', '/admin/deposits/flagged')),
    );
  });
});

describe('jackpots and audit', () => {
  it('lists and cancels a round before its first kick-off', async () => {
    const player = await registerAndLogin(ctx);
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/dev/jackpots/rounds',
      payload: { games: 1, leadSeconds: 60 },
      headers: bearer(player),
    });
    const roundId = (expectOk(created, 201) as { id: string }).id;
    const rounds = StaffJackpotRoundListResponse.parse(
      expectOk(await asStaff(ctx, s.support, 'GET', '/admin/jackpots/rounds')),
    );
    expect(rounds.items.map((round) => round.id)).toContain(roundId);
    const entries = StaffJackpotEntryListResponse.parse(
      expectOk(await asStaff(ctx, s.support, 'GET', `/admin/jackpots/rounds/${roundId}/entries`)),
    );
    expect(entries.items).toEqual([]);

    const url = `/admin/jackpots/rounds/${roundId}/cancel`;
    expect((await asStaff(ctx, s.support, 'POST', url, { reason: 'x' })).statusCode).toBe(403);
    const cancelled = CancelJackpotRoundResponse.parse(
      expectOk(await asStaff(ctx, s.trader, 'POST', url, { reason: 'fixture moved' })),
    );
    expect(cancelled).toMatchObject({ outcome: 'cancelled', status: 'cancelled', entries: 0 });
    const again = CancelJackpotRoundResponse.parse(
      expectOk(await asStaff(ctx, s.trader, 'POST', url, { reason: 'again' })),
    );
    expect(again.outcome).toBe('unchanged');
    expect((await staffAudit(s.trader, roundId)).length).toBe(1);
    await ctx.app.background.idle();
  });

  it('pages the audit log with filters', async () => {
    const first = AuditLogResponse.parse(
      expectOk(
        await asStaff(ctx, s.compliance, 'GET', `/admin/audit?actorId=${s.trader.id}&limit=2`),
      ),
    );
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = AuditLogResponse.parse(
      expectOk(
        await asStaff(
          ctx,
          s.compliance,
          'GET',
          `/admin/audit?actorId=${s.trader.id}&limit=2&cursor=${first.nextCursor}`,
        ),
      ),
    );
    expect(second.items.map((item) => item.id)).not.toContain(first.items[0]!.id);
    expect(first.items[0]).toMatchObject({
      actorType: 'admin',
      actorEmail: 'trader@demo.vamos.test',
    });

    const catalog = AuditLogResponse.parse(
      expectOk(await asStaff(ctx, s.compliance, 'GET', '/admin/audit?action=catalog.&limit=200')),
    );
    expect(catalog.items.length).toBeGreaterThan(0);
    expect(catalog.items.every((item) => item.action.startsWith('catalog.'))).toBe(true);
    expect((await asStaff(ctx, s.compliance, 'GET', '/admin/audit?cursor=bogus')).statusCode).toBe(
      400,
    );
  });
});
