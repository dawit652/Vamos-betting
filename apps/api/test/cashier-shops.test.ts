import { ApiErrorSchema } from '@vamos/contracts';
import { auditLog, kycProfiles } from '@vamos/db/schema';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asStaff, seedStaff, staffLogin, type StaffSession } from './admin-helpers';
import { idNumberHash } from '../src/modules/kyc/service';
import { createTestContext, post, registerAndLogin, type TestContext } from './helpers';

/**
 * Many shops (the owner runs more than 40): with more than one active shop a cashier must be
 * assigned to a shop by settings.edit, sees only that shop at the desk and opens shifts only there;
 * supervisors open shifts anywhere.
 */

let ctx: TestContext;
let cashier: StaffSession;
let finance: StaffSession;
let admin: StaffSession;

beforeAll(async () => {
  // The desk PIN reset is off by default (review of 18 Nov); this file tests it switched on.
  ctx = await createTestContext({ CASHIER_PIN_RESET: 'on' });
  await seedStaff(ctx);
  cashier = await staffLogin(ctx, 'cashier');
  finance = await staffLogin(ctx, 'finance');
  admin = await staffLogin(ctx, 'admin');
});

afterAll(async () => {
  await ctx?.close();
});

const errorCode = (body: string) => ApiErrorSchema.parse(JSON.parse(body)).error.code;

async function deskShops(staff: StaffSession): Promise<Array<{ id: string; code: string }>> {
  const response = await asStaff(ctx, staff, 'GET', '/admin/cashier/desk');
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ shops: Array<{ id: string; code: string }> }>().shops;
}

const open = (staff: StaffSession, shopId: string) =>
  asStaff(ctx, staff, 'POST', '/admin/cashier/shifts', { shopId, openingFloat: '0' });

describe('cashiers and their shops', () => {
  it('a second shop needs the cashier assigned; then only that shop, and supervisors anywhere', async () => {
    const [main] = await deskShops(admin);
    const created = await asStaff(ctx, admin, 'POST', '/admin/cashier/shops', {
      code: 'merkato-01',
      name: 'Nahubet Merkato',
      address: 'Merkato',
      receiptWidthMm: 80,
      approvalThreshold: '1000000',
    });
    expect(created.statusCode, created.body).toBe(201);
    const merkato = created.json<{ shop: { id: string } }>().shop;

    // Two active shops and no assignment: the cashier cannot open a shift.
    const refused = await open(cashier, main!.id);
    expect(refused.statusCode).toBe(403);
    expect(errorCode(refused.body)).toBe('shop_assignment_required');

    // Only settings.edit lists and assigns cashiers.
    expect((await asStaff(ctx, finance, 'GET', '/admin/cashier/staff')).statusCode).toBe(403);
    const staff = await asStaff(ctx, admin, 'GET', '/admin/cashier/staff');
    expect(staff.statusCode).toBe(200);
    const [person] = staff.json<{ staff: Array<{ id: string; shopId: string | null }> }>().staff;
    expect(person).toMatchObject({ shopId: null });
    expect(
      (
        await asStaff(ctx, finance, 'PUT', `/admin/cashier/staff/${person!.id}/shop`, {
          shopId: merkato.id,
        })
      ).statusCode,
    ).toBe(403);
    const assigned = await asStaff(ctx, admin, 'PUT', `/admin/cashier/staff/${person!.id}/shop`, {
      shopId: merkato.id,
    });
    expect(assigned.statusCode, assigned.body).toBe(200);
    expect(assigned.json()).toMatchObject({ staff: [{ id: person!.id, shopId: merkato.id }] });

    // The desk shows the cashier only their shop; another shop is refused, theirs opens.
    expect((await deskShops(cashier)).map((shop) => shop.code)).toEqual(['merkato-01']);
    const wrong = await open(cashier, main!.id);
    expect(wrong.statusCode).toBe(403);
    expect(errorCode(wrong.body)).toBe('shop_not_assigned');
    const opened = await open(cashier, merkato.id);
    expect(opened.statusCode, opened.body).toBeLessThan(300);

    // A supervisor is not assigned and opens a shift at any shop.
    const supervisor = await open(finance, main!.id);
    expect(supervisor.statusCode, supervisor.body).toBeLessThan(300);

    // Only cashier accounts are assigned.
    const notCashier = await asStaff(ctx, admin, 'GET', '/admin/cashier/staff');
    expect(notCashier.json<{ staff: unknown[] }>().staff).toHaveLength(1);
  });

  it('every shop on one day in one table, for reports staff only', async () => {
    expect((await asStaff(ctx, cashier, 'GET', '/admin/cashier/shops/summary')).statusCode).toBe(
      403,
    );
    const today = await asStaff(ctx, finance, 'GET', '/admin/cashier/shops/summary');
    expect(today.statusCode, today.body).toBe(200);
    const body = today.json<{
      day: string;
      shops: Array<{ code: string; openShifts: number; net: string; deposits: { count: number } }>;
    }>();
    expect(body.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Both shops, by code; the shifts opened in the test before are counted where they are open.
    expect(body.shops.map((shop) => shop.code)).toEqual(['main', 'merkato-01']);
    expect(body.shops.find((shop) => shop.code === 'merkato-01')).toMatchObject({
      openShifts: 1,
      net: '0',
      deposits: { count: 0 },
    });
    const past = await asStaff(ctx, finance, 'GET', '/admin/cashier/shops/summary?day=2026-01-01');
    expect(past.json()).toMatchObject({ day: '2026-01-01' });
    expect(
      (await asStaff(ctx, finance, 'GET', '/admin/cashier/shops/summary?day=nope')).statusCode,
    ).toBe(400);
  });

  it("a supervisor books a closed shift's difference once; the cashier cannot", async () => {
    // The cashier's shift at Merkato (opened above with a float of 0) closes 25 birr over.
    const desk = await asStaff(ctx, cashier, 'GET', '/admin/cashier/desk');
    const shiftId = desk.json<{ shift: { id: string } }>().shift.id;
    const closed = await asStaff(ctx, cashier, 'POST', `/admin/cashier/shifts/${shiftId}/close`, {
      countedCash: '2500',
    });
    expect(closed.statusCode, closed.body).toBeLessThan(300);
    const path = `/admin/cashier/shifts/${shiftId}/variance`;
    expect((await asStaff(ctx, cashier, 'POST', path)).statusCode).toBe(403);
    const booked = await asStaff(ctx, finance, 'POST', path);
    expect(booked.statusCode, booked.body).toBe(200);
    expect(booked.json()).toMatchObject({ variancePosting: { amount: '2500' } });
    const again = await asStaff(ctx, finance, 'POST', path);
    expect(again.statusCode).toBe(409);
    expect(errorCode(again.body)).toBe('variance_already_posted');
    const detail = await asStaff(ctx, finance, 'GET', `/admin/cashier/shifts/${shiftId}`);
    expect(detail.json()).toMatchObject({ variancePosting: { amount: '2500' } });
  });

  it('a PIN reset at the desk: the ID checked, a supervisor approves, the desk prints the code, the player resets', async () => {
    const player = await registerAndLogin(ctx);
    await ctx.deps.db.insert(kycProfiles).values({
      userId: player.userId,
      status: 'verified',
      provider: 'mock',
      idNumberLast4: '9012',
      idNumberHash: idNumberHash(ctx.deps.config.sessionSecret, '123456789012'),
      verifiedName: 'Abebe Kebede',
      submittedAt: ctx.clock.now,
    });
    const ask = (idNumber: string) =>
      asStaff(ctx, cashier, 'POST', `/admin/cashier/players/${player.userId}/pin-reset`, {
        idNumber,
      });
    // Only at a shop: without an open shift the desk cannot ask (review finding 5).
    expect(errorCode((await ask('1234 5678 9012')).body)).toBe('shift_not_open');
    const deskNow = await asStaff(ctx, cashier, 'GET', '/admin/cashier/desk');
    expect(deskNow.json()).toMatchObject({ pinResetEnabled: true });
    const [myShop] = await deskShops(cashier);
    expect((await open(cashier, myShop!.id)).statusCode).toBeLessThan(300);

    // A wrong ID number: refused and on record.
    const wrong = await ask('1111 2222 3333');
    expect(wrong.statusCode).toBe(422);
    expect(errorCode(wrong.body)).toBe('id_mismatch');
    const audits = await ctx.deps.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, player.userId));
    expect(audits.map((a) => a.action)).toContain('cashier.pin_reset_id_mismatch');

    const asked = await ask('1234 5678 9012');
    expect(asked.statusCode, asked.body).toBe(200);
    const resetId = asked.json<{ reset: { id: string; status: string } }>().reset.id;
    expect(asked.json()).toMatchObject({ reset: { status: 'requested' } });
    const issue = () => asStaff(ctx, cashier, 'POST', `/admin/cashier/pin-resets/${resetId}/issue`);
    expect(errorCode((await issue()).body)).toBe('pin_reset_not_approved');

    // Supervisors with users.status decide; finance has no say; the cashier cannot.
    const decide = (staff: StaffSession) =>
      asStaff(ctx, staff, 'POST', `/admin/cashier/pin-resets/${resetId}/decision`, {
        approve: true,
      });
    expect((await decide(finance)).statusCode).toBe(403);
    expect((await decide(cashier)).statusCode).toBe(403);
    const list = await asStaff(ctx, admin, 'GET', '/admin/cashier/pin-resets');
    expect(list.json<{ resets: Array<{ id: string }> }>().resets.map((r) => r.id)).toContain(
      resetId,
    );
    const approved = await decide(admin);
    expect(approved.statusCode, approved.body).toBe(200);

    // The desk issues the code once; the player sets a new PIN with it on "Forgot PIN".
    const issued = await issue();
    expect(issued.statusCode, issued.body).toBe(200);
    const { code } = issued.json<{ code: string }>();
    expect(code).toMatch(/^\d{6}$/);
    expect(errorCode((await issue()).body)).toBe('pin_reset_not_approved');
    const reset = await post(ctx, '/auth/password/reset', {
      phone: player.phone,
      code,
      newPassword: '5739',
    });
    expect(reset.statusCode, reset.body).toBeLessThan(300);
    const login = await post(ctx, '/auth/login', { phone: player.phone, password: '5739' });
    expect(login.statusCode, login.body).toBe(200);
  });
});
