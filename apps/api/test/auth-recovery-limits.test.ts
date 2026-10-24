import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, latestOtp, post, registerAndLogin, type TestContext } from './helpers';

/**
 * Phase 12 security review: password-reset codes must not be guessable
 * without limit (A1), and a stranger must not be able to lock a player out
 * of login and recovery at once (A3).
 */
let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => ctx?.close());

const MINUTE = 60_000;
const NEW_PASSWORD = 'Haile-gebrselassie-1973';

/** A 6-digit code that is not `code`. */
const wrong = (code: string) => (code === '000000' ? '111111' : '000000');

let attacker = 0;
/** A fresh attacker address, so the per-address limits (Redis, real time) never interfere. */
const nextAttacker = () => {
  attacker += 1;
  return `203.0.${Math.floor(attacker / 250)}.${attacker % 250}`;
};

describe('password-reset code guessing (A1)', () => {
  it('stops after 10 wrong codes per number in 24 hours, even for the right code, then recovers', async () => {
    const victim = await registerAndLogin(ctx);
    const guess = async (code: string) =>
      post(
        ctx,
        '/auth/password/reset',
        { phone: victim.phone, code, newPassword: NEW_PASSWORD },
        { remoteAddress: nextAttacker() },
      );
    const forgot = (remoteAddress = nextAttacker()) =>
      post(ctx, '/auth/password/forgot', { phone: victim.phone }, { remoteAddress });

    // 5 + 4 + 1 wrong codes on three challenges: the daily budget of 10 is used up.
    for (const wrongs of [5, 4, 1]) {
      expect((await forgot()).statusCode).toBe(200);
      const code = await latestOtp(ctx, victim.phone);
      for (let i = 0; i < wrongs; i += 1) {
        const response = await guess(wrong(code));
        expect(response.statusCode).toBe(400);
        expect(response.json().error.code).toBe('otp_invalid');
      }
      ctx.clock.advance(MINUTE + 1000);
    }
    // The third challenge is still live, but no code is checked any more: not even the right one.
    const live = await latestOtp(ctx, victim.phone);
    const refused = await guess(live);
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error.code).toBe('otp_limit');
    expect(refused.json().error.details.retryAfterSeconds).toBeGreaterThan(0);
    // And no new code is issued.
    const noCode = await forgot('198.51.100.20');
    expect(noCode.statusCode).toBe(429);
    expect(noCode.json().error.code).toBe('otp_limit');
    // The password did not change.
    const oldLogin = await post(
      ctx,
      '/auth/login',
      { phone: victim.phone, password: victim.password },
      { remoteAddress: '198.51.100.20' },
    );
    expect(oldLogin.statusCode).toBe(200);

    // A day later the owner can reset again.
    ctx.clock.advance(24 * 60 * MINUTE);
    expect((await forgot('198.51.100.20')).statusCode).toBe(200);
    const code = await latestOtp(ctx, victim.phone);
    const reset = await post(
      ctx,
      '/auth/password/reset',
      { phone: victim.phone, code, newPassword: NEW_PASSWORD },
      { remoteAddress: '198.51.100.20' },
    );
    expect(reset.statusCode).toBe(200);
  }, 60_000);
});

describe('locking a player out (A3)', () => {
  it('lets the owner request codes past a stranger, reset, and log in despite the login lock', async () => {
    const victim = await registerAndLogin(ctx);
    const owner = '198.51.100.7';
    // A stranger sends 20 wrong passwords from two addresses: the per-number login lock is on.
    for (const ip of ['192.0.2.1', '192.0.2.2']) {
      for (let i = 0; i < 10; i += 1) {
        const response = await post(
          ctx,
          '/auth/login',
          { phone: victim.phone, password: 'nope-nope-nope' },
          { remoteAddress: ip },
        );
        expect(response.statusCode).toBe(401);
      }
    }
    const locked = await post(
      ctx,
      '/auth/login',
      { phone: victim.phone, password: victim.password },
      { remoteAddress: owner },
    );
    expect(locked.statusCode).toBe(429);

    // The stranger also asks for 5 reset codes for the number from one address.
    for (let i = 0; i < 5; i += 1) {
      const response = await post(
        ctx,
        '/auth/password/forgot',
        { phone: victim.phone },
        { remoteAddress: '192.0.2.3' },
      );
      expect(response.statusCode).toBe(200);
      ctx.clock.advance(MINUTE + 1000);
    }
    // Their own sixth is refused…
    const sixth = await post(
      ctx,
      '/auth/password/forgot',
      { phone: victim.phone },
      { remoteAddress: '192.0.2.3' },
    );
    expect(sixth.statusCode).toBe(429);
    // …but the owner, from their own address, still gets a code, even within a minute of the stranger's.
    await post(
      ctx,
      '/auth/password/forgot',
      { phone: victim.phone },
      { remoteAddress: '192.0.2.4' },
    );
    const forgot = await post(
      ctx,
      '/auth/password/forgot',
      { phone: victim.phone },
      { remoteAddress: owner },
    );
    expect(forgot.statusCode).toBe(200);
    const code = await latestOtp(ctx, victim.phone);
    const reset = await post(
      ctx,
      '/auth/password/reset',
      { phone: victim.phone, code, newPassword: NEW_PASSWORD },
      { remoteAddress: owner },
    );
    expect(reset.statusCode).toBe(200);
    // The reset lifts the per-number login lock: the owner gets in with the new password.
    const login = await post(
      ctx,
      '/auth/login',
      { phone: victim.phone, password: NEW_PASSWORD },
      { remoteAddress: owner },
    );
    expect(login.statusCode).toBe(200);
  }, 60_000);

  it('still caps the codes per number across addresses (15 an hour)', async () => {
    const victim = await registerAndLogin(ctx);
    // registerAndLogin used one registration code; reset codes are counted on their own.
    for (let i = 0; i < 15; i += 1) {
      const response = await post(
        ctx,
        '/auth/password/forgot',
        { phone: victim.phone },
        { remoteAddress: nextAttacker() },
      );
      expect(response.statusCode).toBe(200);
    }
    const over = await post(
      ctx,
      '/auth/password/forgot',
      { phone: victim.phone },
      { remoteAddress: nextAttacker() },
    );
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe('otp_limit');
  }, 60_000);
});
