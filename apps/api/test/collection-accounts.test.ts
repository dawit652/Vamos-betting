import { randomUUID } from 'node:crypto';
import {
  ApiErrorSchema,
  CollectionAccountListResponse,
  CollectionAccountResponse,
  DepositView,
  PaymentOptionsResponse,
} from '@vamos/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asStaff, seedStaff, staffLogin, type StaffSession } from './admin-helpers';
import {
  createTestContext,
  registerAndLogin,
  type LoggedInUser,
  type TestContext,
} from './helpers';

/** The SMS rail's collection accounts, managed in the back office. */

let ctx: TestContext;
let admin: StaffSession;
let finance: StaffSession;
let support: StaffSession;
let player: LoggedInUser;

beforeAll(async () => {
  ctx = await createTestContext({ PAYMENT_PROVIDERS: 'mock,sms' });
  await seedStaff(ctx);
  admin = await staffLogin(ctx, 'admin');
  finance = await staffLogin(ctx, 'finance');
  support = await staffLogin(ctx, 'support');
  player = await registerAndLogin(ctx);
});

afterAll(async () => {
  await ctx?.close();
});

const code = (body: string) => ApiErrorSchema.parse(JSON.parse(body)).error.code;

async function railMethods() {
  const response = await ctx.app.inject({ method: 'GET', url: '/payments/options' });
  return PaymentOptionsResponse.parse(response.json()).smsRail?.methods ?? [];
}

function deposit(institution?: string) {
  return ctx.app.inject({
    method: 'POST',
    url: '/payments/deposits',
    payload: { amount: '10000', provider: 'sms', ...(institution ? { institution } : {}) },
    headers: { authorization: `Bearer ${player.sessionToken}`, 'idempotency-key': randomUUID() },
  });
}

describe('collection accounts in the back office', () => {
  let added: string;

  it('lists the configured accounts, filled into the empty list', async () => {
    const response = await asStaff(ctx, admin, 'GET', '/admin/collection-accounts');
    expect(response.statusCode, response.body).toBe(200);
    const body = CollectionAccountListResponse.parse(response.json());
    expect(body.accounts.map((a) => a.accountId).sort()).toEqual([
      'cbe:1000000000000',
      'telebirr:0900000000',
    ]);
    expect(body.accounts.every((a) => a.status === 'active' && a.createdBy === null)).toBe(true);
    expect(body).toMatchObject({ requiredName: null, railEnabled: true, operatingMode: 'demo' });
    expect(body.institutions.map((i) => i.id)).toContain('awash');
    expect((await asStaff(ctx, support, 'GET', '/admin/collection-accounts')).statusCode).toBe(403);
  });

  it('an admin adds one; players see it once finance approves it', async () => {
    expect(
      (
        await asStaff(ctx, finance, 'POST', '/admin/collection-accounts', {
          institution: 'awash',
          account: '01320000001',
          name: 'Vamos Demo',
        })
      ).statusCode,
    ).toBe(403);
    const created = await asStaff(ctx, admin, 'POST', '/admin/collection-accounts', {
      institution: 'awash',
      account: '0132 0000 0001',
      name: 'Vamos Demo',
      hint: 'Any branch',
    });
    expect(created.statusCode, created.body).toBe(201);
    const { account } = CollectionAccountResponse.parse(created.json());
    expect(account).toMatchObject({
      status: 'pending',
      accountId: 'awash:013200000001',
      institutionName: 'Awash Bank',
      createdByName: 'Demo Admin',
    });
    added = account.id;
    expect((await railMethods()).map((m) => m.institution)).not.toContain('awash');
    expect((await deposit('awash')).statusCode).toBe(400);

    const own = await asStaff(ctx, admin, 'POST', `/admin/collection-accounts/${added}/approve`);
    expect(own.statusCode).toBe(409);
    expect(code(own.body)).toBe('four_eyes');
    const approved = await asStaff(
      ctx,
      finance,
      'POST',
      `/admin/collection-accounts/${added}/approve`,
    );
    expect(approved.statusCode, approved.body).toBe(200);
    expect(CollectionAccountResponse.parse(approved.json())).toMatchObject({
      changed: true,
      account: { status: 'active', decidedByName: 'Demo Finance' },
    });
    const awash = (await railMethods()).find((m) => m.institution === 'awash');
    expect(awash?.accounts).toEqual([
      { account: '013200000001', name: 'Vamos Demo', hint: 'Any branch' },
    ]);
    const made = await deposit('awash');
    expect(made.statusCode, made.body).toBe(201);
    expect(DepositView.parse(made.json()).transfer?.account).toMatchObject({
      institution: 'awash',
      account: '013200000001',
    });
  });

  it('the admin edits the hint; the number stays; a duplicate is refused', async () => {
    const edited = await asStaff(ctx, admin, 'PATCH', `/admin/collection-accounts/${added}`, {
      hint: 'Reason: deposit',
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(CollectionAccountResponse.parse(edited.json()).account).toMatchObject({
      hint: 'Reason: deposit',
      account: '013200000001',
    });
    expect((await railMethods()).find((m) => m.institution === 'awash')?.accounts[0]?.hint).toBe(
      'Reason: deposit',
    );
    expect(
      (
        await asStaff(ctx, admin, 'PATCH', `/admin/collection-accounts/${added}`, {
          account: '999999999',
        })
      ).statusCode,
    ).toBe(400);
    const duplicate = await asStaff(ctx, admin, 'POST', '/admin/collection-accounts', {
      institution: 'awash',
      account: '013200000001',
      name: 'Vamos Demo',
    });
    expect(duplicate.statusCode).toBe(409);
    expect(code(duplicate.body)).toBe('collection_account_exists');
  });

  it('a deleted account takes no new deposit; an open deposit on it still shows it', async () => {
    const open = DepositView.parse((await deposit('awash')).json());
    const deleted = await asStaff(ctx, admin, 'DELETE', `/admin/collection-accounts/${added}`);
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(CollectionAccountResponse.parse(deleted.json()).account.status).toBe('deleted');
    expect((await railMethods()).map((m) => m.institution)).not.toContain('awash');
    expect((await deposit('awash')).statusCode).toBe(400);
    const shown = await ctx.app.inject({
      method: 'GET',
      url: `/payments/deposits/${open.id}`,
      headers: { authorization: `Bearer ${player.sessionToken}` },
    });
    expect(DepositView.parse(shown.json()).transfer?.account?.account).toBe('013200000001');
  });

  it('with every account deleted, SMS deposits pause', async () => {
    const list = CollectionAccountListResponse.parse(
      (await asStaff(ctx, admin, 'GET', '/admin/collection-accounts')).json(),
    );
    for (const account of list.accounts.filter((a) => a.status === 'active')) {
      const response = await asStaff(
        ctx,
        admin,
        'DELETE',
        `/admin/collection-accounts/${account.id}`,
      );
      expect(response.statusCode, response.body).toBe(200);
    }
    expect(await railMethods()).toEqual([]);
    const paused = await deposit();
    expect(paused.statusCode).toBe(409);
    expect(code(paused.body)).toBe('no_collection_account');
  });
});
