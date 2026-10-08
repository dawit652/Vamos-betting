import { maskMsisdn } from '@vamos/core';
import { ApiErrorSchema, MeResponse } from '@vamos/contracts';
import { auditLog, kycProfiles, rgExclusions, users } from '@vamos/db/schema';
import { and, eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getMe } from '../src/modules/me/service';
import {
  ADULT_DOB,
  createTestContext,
  registerAndLogin,
  type LoggedInUser,
  type TestContext,
} from './helpers';

const DAY_MS = 24 * 60 * 60_000;

const bearer = (player: LoggedInUser) => ({ authorization: `Bearer ${player.sessionToken}` });

function apiError(response: LightMyRequestResponse) {
  return ApiErrorSchema.parse(response.json()).error;
}

describe('GET /me and PATCH /me', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const getMeRequest = (player: LoggedInUser) =>
    ctx.app.inject({ method: 'GET', url: '/me', headers: bearer(player) });

  const patchMe = (player: LoggedInUser, payload: Record<string, unknown>) =>
    ctx.app.inject({ method: 'PATCH', url: '/me', payload, headers: bearer(player) });

  async function profileAudits(userId: string) {
    return ctx.db.db
      .select({ metadata: auditLog.metadata, ip: auditLog.ip })
      .from(auditLog)
      .where(and(eq(auditLog.actorId, userId), eq(auditLog.action, 'user.profile_updated')));
  }

  it('requires a session', async () => {
    const get = await ctx.app.inject({ method: 'GET', url: '/me' });
    expect(get.statusCode).toBe(401);
    expect(apiError(get).code).toBe('unauthorized');
    const patch = await ctx.app.inject({ method: 'PATCH', url: '/me', payload: { locale: 'am' } });
    expect(patch.statusCode).toBe(401);
    const bogus = await ctx.app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: 'Bearer not-a-session' },
    });
    expect(bogus.statusCode).toBe(401);
  });

  it('returns the profile of a new player', async () => {
    const player = await registerAndLogin(ctx);
    const response = await getMeRequest(player);
    expect(response.statusCode).toBe(200);
    const me = MeResponse.parse(response.json());
    const [user] = await ctx.db.db.select().from(users).where(eq(users.id, player.userId));
    expect(me).toEqual({
      id: player.userId,
      phone: player.phone,
      phoneMasked: maskMsisdn(player.phone),
      fullName: 'Test Player',
      dateOfBirth: ADULT_DOB,
      locale: 'en',
      status: 'active',
      kyc: { status: 'unverified', idNumberLast4: null },
      exclusion: null,
      canGamble: true,
      createdAt: user!.createdAt.toISOString(),
    });
    expect(me.phoneMasked).toMatch(/^\+251 9\d \*\*\* \d{4}$/);
  });

  it('also works with the session cookie', async () => {
    const player = await registerAndLogin(ctx);
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/me',
      headers: { cookie: player.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(MeResponse.parse(response.json()).id).toBe(player.userId);
  });

  it('reports the KYC status and the last 4 digits of the ID', async () => {
    const player = await registerAndLogin(ctx);
    await ctx.db.db.insert(kycProfiles).values({
      userId: player.userId,
      status: 'pending',
      provider: 'mock',
      idNumberHash: 'a'.repeat(64),
      idNumberLast4: '4321',
    });
    expect(MeResponse.parse((await getMeRequest(player)).json()).kyc).toEqual({
      status: 'pending',
      idNumberLast4: '4321',
    });

    await ctx.db.db
      .update(kycProfiles)
      .set({ status: 'verified' })
      .where(eq(kycProfiles.userId, player.userId));
    const me = MeResponse.parse((await getMeRequest(player)).json());
    expect(me.kyc).toEqual({ status: 'verified', idNumberLast4: '4321' });
    expect(me.canGamble).toBe(true);
  });

  it('shows an active cool-off and canGamble=false until it ends', async () => {
    const player = await registerAndLogin(ctx);
    const startsAt = new Date(ctx.clock.now.getTime() - 1000);
    const endsAt = new Date(ctx.clock.now.getTime() + DAY_MS);
    await ctx.db.db
      .insert(rgExclusions)
      .values({ userId: player.userId, kind: 'cool_off', startsAt, endsAt });

    const me = MeResponse.parse((await getMeRequest(player)).json());
    expect(me.exclusion).toEqual({
      kind: 'cool_off',
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
    });
    expect(me.canGamble).toBe(false);

    // Exclusions end exactly at ends_at.
    const at = ctx.clock.now;
    ctx.clock.now = endsAt;
    try {
      const later = MeResponse.parse((await getMeRequest(player)).json());
      expect(later.exclusion).toBeNull();
      expect(later.canGamble).toBe(true);
    } finally {
      ctx.clock.now = at;
    }
  });

  it('shows a permanent self-exclusion with endsAt null', async () => {
    const player = await registerAndLogin(ctx);
    await ctx.db.db.insert(rgExclusions).values({
      userId: player.userId,
      kind: 'self_exclusion',
      startsAt: ctx.clock.now,
      endsAt: null,
    });
    // The session is still alive here because the row was inserted directly.
    const me = MeResponse.parse((await getMeRequest(player)).json());
    expect(me.exclusion).toEqual({
      kind: 'self_exclusion',
      startsAt: ctx.clock.now.toISOString(),
      endsAt: null,
    });
    expect(me.canGamble).toBe(false);
  });

  it('ignores exclusions that have ended or not started yet', async () => {
    const player = await registerAndLogin(ctx);
    const now = ctx.clock.now.getTime();
    await ctx.db.db.insert(rgExclusions).values([
      {
        userId: player.userId,
        kind: 'cool_off',
        startsAt: new Date(now - 8 * DAY_MS),
        endsAt: new Date(now - DAY_MS),
      },
      {
        userId: player.userId,
        kind: 'self_exclusion',
        startsAt: new Date(now + DAY_MS),
        endsAt: null,
      },
    ]);
    const me = MeResponse.parse((await getMeRequest(player)).json());
    expect(me.exclusion).toBeNull();
    expect(me.canGamble).toBe(true);
  });

  it('reports canGamble=false for an account that is not active', async () => {
    const player = await registerAndLogin(ctx);
    await ctx.db.db.update(users).set({ status: 'suspended' }).where(eq(users.id, player.userId));
    const me = await getMe(ctx.db.db, player.userId, ctx.clock.now);
    expect(me).toMatchObject({ status: 'suspended', canGamble: false, exclusion: null });
    // A suspended account has no usable session.
    expect((await getMeRequest(player)).statusCode).toBe(401);
  });

  it('updates the locale and the full name and audits the change', async () => {
    const player = await registerAndLogin(ctx);
    const response = await patchMe(player, { locale: 'om', fullName: '  Derartu Tulu  ' });
    expect(response.statusCode).toBe(200);
    const me = MeResponse.parse(response.json());
    expect(me).toMatchObject({ id: player.userId, locale: 'om', fullName: 'Derartu Tulu' });

    const [user] = await ctx.db.db.select().from(users).where(eq(users.id, player.userId));
    expect(user).toMatchObject({ locale: 'om', fullName: 'Derartu Tulu' });
    expect(user!.updatedAt.getTime()).toBe(ctx.clock.now.getTime());

    const audits = await profileAudits(player.userId);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toEqual({
      fields: ['locale', 'fullName'],
      locale: { from: 'en', to: 'om' },
    });
    expect(audits[0]!.ip).toBeTruthy();

    // GET reflects the change.
    expect(MeResponse.parse((await getMeRequest(player)).json()).locale).toBe('om');
  });

  it('updates a single field', async () => {
    const player = await registerAndLogin(ctx);
    const response = await patchMe(player, { fullName: 'Haile Gebrselassie' });
    expect(response.statusCode).toBe(200);
    expect(MeResponse.parse(response.json())).toMatchObject({
      fullName: 'Haile Gebrselassie',
      locale: 'en',
    });
    const audits = await profileAudits(player.userId);
    expect(audits.map((row) => row.metadata)).toEqual([{ fields: ['fullName'] }]);
  });

  it('writes nothing when the values do not change', async () => {
    const player = await registerAndLogin(ctx);
    const response = await patchMe(player, { locale: 'en', fullName: 'Test Player' });
    expect(response.statusCode).toBe(200);
    expect(MeResponse.parse(response.json())).toMatchObject({
      locale: 'en',
      fullName: 'Test Player',
    });
    expect(await profileAudits(player.userId)).toHaveLength(0);
  });

  it('validates the body with the contract', async () => {
    const player = await registerAndLogin(ctx);
    for (const payload of [
      {},
      { locale: 'fr' },
      { fullName: 'A' },
      { fullName: 'x'.repeat(121) },
    ]) {
      const response = await patchMe(player, payload);
      expect(response.statusCode).toBe(400);
      expect(apiError(response).code).toBe('validation_error');
    }
    const [user] = await ctx.db.db.select().from(users).where(eq(users.id, player.userId));
    expect(user).toMatchObject({ locale: 'en', fullName: 'Test Player' });
  });

  it('requires the CSRF header with cookie authentication', async () => {
    const player = await registerAndLogin(ctx);
    const forged = await ctx.app.inject({
      method: 'PATCH',
      url: '/me',
      payload: { locale: 'ti' },
      headers: { cookie: player.cookie },
    });
    expect(forged.statusCode).toBe(403);
    expect(apiError(forged).code).toBe('csrf_invalid');

    const ok = await ctx.app.inject({
      method: 'PATCH',
      url: '/me',
      payload: { locale: 'ti' },
      headers: { cookie: player.cookie, 'x-csrf-token': player.csrfToken },
    });
    expect(ok.statusCode).toBe(200);
    expect(MeResponse.parse(ok.json()).locale).toBe('ti');
  });

  it('locks the name once KYC is verified, but still lets the locale change', async () => {
    const player = await registerAndLogin(ctx);
    await ctx.db.db.insert(kycProfiles).values({
      userId: player.userId,
      status: 'verified',
      provider: 'mock',
      idNumberHash: 'b'.repeat(64),
      idNumberLast4: '1111',
      verifiedName: 'Test Player',
    });
    const rename = await patchMe(player, { fullName: 'Somebody Else', locale: 'am' });
    expect(rename.statusCode).toBe(409);
    expect(apiError(rename).code).toBe('name_locked');
    const [unchanged] = await ctx.db.db.select().from(users).where(eq(users.id, player.userId));
    expect(unchanged).toMatchObject({ fullName: 'Test Player', locale: 'en' });

    // Re-sending the current name is not a change.
    const locale = await patchMe(player, { fullName: 'Test Player', locale: 'am' });
    expect(locale.statusCode).toBe(200);
    expect(MeResponse.parse(locale.json())).toMatchObject({
      fullName: 'Test Player',
      locale: 'am',
    });
  });
});
