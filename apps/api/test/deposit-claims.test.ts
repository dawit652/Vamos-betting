import type { StaffRole } from '@vamos/contracts';
import {
  ApiErrorSchema,
  DepositClaimListResponse,
  DepositClaimResponse,
  MoneyNotCreditedResponse,
} from '@vamos/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BACK_OFFICE_ROLES,
  asStaff,
  seedStaff,
  staffLogin,
  type StaffSession,
} from './admin-helpers';
import { createTestContext, registerAndLogin, type TestContext } from './helpers';

/**
 * "My deposit did not arrive" and the back office's "Money not credited"
 * (docs/plans/counter-codes-and-deposit-recovery.md, G5.3 and G6).
 */

let ctx: TestContext;
const staff = new Map<StaffRole, StaffSession>();
const as = (role: StaffRole) => staff.get(role)!;

beforeAll(async () => {
  ctx = await createTestContext();
  await seedStaff(ctx);
  for (const role of BACK_OFFICE_ROLES) staff.set(role, await staffLogin(ctx, role));
}, 60_000);

afterAll(async () => {
  await ctx?.close();
});

type Player = Awaited<ReturnType<typeof registerAndLogin>>;
const asPlayer = (player: Player, method: 'GET' | 'POST', url: string, payload?: object) =>
  ctx.app.inject({
    method,
    url,
    headers: { cookie: player.cookie, 'x-csrf-token': player.csrfToken },
    ...(payload === undefined ? {} : { payload }),
  });
const code = (body: string) => ApiErrorSchema.parse(JSON.parse(body)).error.code;
const paidAt = () => new Date(ctx.clock.now.getTime() - 3_600_000).toISOString();

describe('deposit claims', () => {
  it('a player reports a payment; an admin answers it with a manual deposit, once', async () => {
    const player = await registerAndLogin(ctx);
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: '/payments/deposit-claims',
          payload: { method: 'telebirr', amount: '50000', paidAt: paidAt() },
        })
      ).statusCode,
    ).toBe(401);
    const filed = await asPlayer(player, 'POST', '/payments/deposit-claims', {
      method: 'telebirr',
      amount: '50000',
      paidAt: paidAt(),
      reference: 'CK51X2QZ',
    });
    expect(filed.statusCode, filed.body).toBe(201);
    const claim = DepositClaimResponse.parse(filed.json()).claim;
    expect(claim).toMatchObject({ status: 'open', reference: 'CK51X2QZ', amount: '50000' });
    const again = await asPlayer(player, 'POST', '/payments/deposit-claims', {
      method: 'telebirr',
      amount: '50000',
      paidAt: paidAt(),
      reference: 'ck51x2qz',
    });
    expect(again.statusCode).toBe(409);
    expect(code(again.body)).toBe('claim_exists');
    const bad = await asPlayer(player, 'POST', '/payments/deposit-claims', {
      method: 'telebirr',
      amount: '0',
      paidAt: paidAt(),
    });
    expect(bad.statusCode).toBe(400);

    // The back office: finance sees it; a cashier does not.
    const list = await asStaff(ctx, as('finance'), 'GET', '/admin/money-not-credited');
    expect(list.statusCode, list.body).toBe(200);
    const listed = MoneyNotCreditedResponse.parse(list.json()).claims.find(
      (c) => c.id === claim.id,
    );
    expect(listed).toMatchObject({ userId: player.userId, reference: 'CK51X2QZ', pairs: [] });
    expect((await asStaff(ctx, as('cashier'), 'GET', '/admin/money-not-credited')).statusCode).toBe(
      403,
    );

    // Credited by hand with the claim: the claim is answered in the same transaction.
    const credited = await asStaff(
      ctx,
      as('admin'),
      'POST',
      `/admin/users/${player.userId}/manual-deposits`,
      {
        provider: 'telebirr',
        providerTransactionId: 'CK51X2QZ',
        amount: '50000',
        reason: 'Matches the telebirr statement line',
        claimId: claim.id,
      },
    );
    expect(credited.statusCode, credited.body).toBe(200);
    const mine = DepositClaimListResponse.parse(
      (await asPlayer(player, 'GET', '/payments/deposit-claims')).json(),
    ).claims;
    expect(mine.find((c) => c.id === claim.id)).toMatchObject({ status: 'credited' });
    const after = MoneyNotCreditedResponse.parse(
      (await asStaff(ctx, as('finance'), 'GET', '/admin/money-not-credited')).json(),
    );
    expect(after.claims.some((c) => c.id === claim.id)).toBe(false);
  });

  it('a claim is closed with a note; another player’s claim cannot be credited to someone else', async () => {
    const player = await registerAndLogin(ctx);
    const other = await registerAndLogin(ctx);
    const claim = DepositClaimResponse.parse(
      (
        await asPlayer(player, 'POST', '/payments/deposit-claims', {
          method: 'cbe',
          amount: '120000',
          paidAt: paidAt(),
        })
      ).json(),
    ).claim;
    const wrong = await asStaff(
      ctx,
      as('admin'),
      'POST',
      `/admin/users/${other.userId}/manual-deposits`,
      {
        provider: 'sms',
        providerTransactionId: 'FT2611ABCD',
        amount: '120000',
        reason: 'Credited to the wrong player on purpose',
        claimId: claim.id,
      },
    );
    expect(wrong.statusCode).toBe(409);
    expect(code(wrong.body)).toBe('claim_other_player');

    const url = `/admin/deposit-claims/${claim.id}/close`;
    expect((await asStaff(ctx, as('finance'), 'POST', url, { note: 'no' })).statusCode).toBe(400);
    const closed = await asStaff(ctx, as('finance'), 'POST', url, {
      note: 'No such payment on the CBE statement',
    });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json()).toMatchObject({ status: 'closed' });
    const twice = await asStaff(ctx, as('finance'), 'POST', url, { note: 'Closed again' });
    expect(twice.statusCode).toBe(409);
    expect(code(twice.body)).toBe('claim_not_open');
    const mine = DepositClaimListResponse.parse(
      (await asPlayer(player, 'GET', '/payments/deposit-claims')).json(),
    ).claims;
    expect(mine[0]).toMatchObject({ id: claim.id, status: 'closed' });
  });
});
