import { randomBytes } from 'node:crypto';
import { ApiErrorSchema, KycResponse, MeResponse } from '@vamos/contracts';
import { auditLog, kycProfiles, outboxEvents, users } from '@vamos/db/schema';
import { and, asc, eq, like } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { hmacSha256Hex } from '../src/lib/crypto';
import { KYC_SUBMISSIONS_PER_HOUR } from '../src/modules/kyc/routes';
import { idNumberHash, nameKey, namesMatch } from '../src/modules/kyc/service';
import type {
  KycVerificationRequest,
  KycVerificationResult,
  KycVerifier,
} from '../src/providers/kyc';
import {
  ADULT_DOB,
  createTestContext,
  dobForAge,
  registerAndLogin,
  type LoggedInUser,
  type TestContext,
} from './helpers';

const bearer = (player: LoggedInUser) => ({ authorization: `Bearer ${player.sessionToken}` });

function apiError(response: LightMyRequestResponse) {
  return ApiErrorSchema.parse(response.json()).error;
}

/** A KYC provider whose answer each test scripts. */
class ScriptedKyc implements KycVerifier {
  readonly name = 'scripted';
  readonly calls: KycVerificationRequest[] = [];
  respond: (request: KycVerificationRequest) => Promise<KycVerificationResult> = async (
    request,
  ) => ({
    status: 'verified',
    verifiedName: request.fullName,
    verifiedDateOfBirth: request.dateOfBirth,
    reference: 'scripted-ref',
  });

  async verify(request: KycVerificationRequest): Promise<KycVerificationResult> {
    this.calls.push(request);
    return this.respond(request);
  }
}

describe('KYC: GET/POST /me/kyc', () => {
  let ctx: TestContext;
  let scripted: ScriptedKyc;
  /** Same database and clock, but with the scripted provider. */
  let scriptedApp: FastifyInstance;
  let idCounter = 10_000_000;

  beforeAll(async () => {
    ctx = await createTestContext();
    scripted = new ScriptedKyc();
    scriptedApp = buildApp(
      { ...ctx.deps, kyc: scripted },
      { logger: false, rateLimitNameSpace: `kyc-scripted-${randomBytes(4).toString('hex')}:` },
    );
    await scriptedApp.ready();
  });

  afterAll(async () => {
    await scriptedApp?.close();
    await ctx?.close();
  });

  /** A fresh 12-digit FIN ending in `suffix` (mock: 0000 = rejected, 9999 = pending). */
  function freshFin(suffix = '1234'): string {
    idCounter += 1;
    return `${String(idCounter).padStart(8, '0')}${suffix}`;
  }

  function submit(
    player: LoggedInUser,
    payload: Record<string, unknown>,
    app: FastifyInstance = ctx.app,
  ) {
    return app.inject({ method: 'POST', url: '/me/kyc', payload, headers: bearer(player) });
  }

  const kycPayload = (idNumber: string, overrides: Record<string, unknown> = {}) => ({
    idNumber,
    fullName: 'Abebe Bikila',
    dateOfBirth: ADULT_DOB,
    ...overrides,
  });

  async function profileOf(userId: string) {
    const [row] = await ctx.db.db.select().from(kycProfiles).where(eq(kycProfiles.userId, userId));
    return row;
  }

  async function userOf(userId: string) {
    const [row] = await ctx.db.db.select().from(users).where(eq(users.id, userId));
    return row!;
  }

  async function kycAudits(userId: string) {
    return ctx.db.db
      .select({ action: auditLog.action, metadata: auditLog.metadata })
      .from(auditLog)
      .where(and(eq(auditLog.actorId, userId), like(auditLog.action, 'kyc.%')))
      .orderBy(asc(auditLog.id));
  }

  async function kycEvents(userId: string) {
    return ctx.db.db
      .select({ type: outboxEvents.type, payload: outboxEvents.payload })
      .from(outboxEvents)
      .where(and(eq(outboxEvents.aggregateId, userId), eq(outboxEvents.type, 'kyc.status_changed')))
      .orderBy(asc(outboxEvents.id));
  }

  it('requires a session', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/me/kyc' })).statusCode).toBe(401);
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/me/kyc',
      payload: kycPayload(freshFin()),
    });
    expect(post.statusCode).toBe(401);
    expect(apiError(post).code).toBe('unauthorized');
  });

  it('reports unverified before any submission', async () => {
    const player = await registerAndLogin(ctx);
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/me/kyc',
      headers: bearer(player),
    });
    expect(response.statusCode).toBe(200);
    expect(KycResponse.parse(response.json())).toEqual({
      status: 'unverified',
      idNumberLast4: null,
      rejectionReason: null,
    });
  });

  it('verifies a FIN, storing only its keyed hash and last 4 digits', async () => {
    const player = await registerAndLogin(ctx);
    const fin = freshFin('9012');
    const formatted = `${fin.slice(0, 4)} ${fin.slice(4, 8)}-${fin.slice(8)}`;
    const response = await submit(player, kycPayload(formatted));
    expect(response.statusCode).toBe(200);
    expect(KycResponse.parse(response.json())).toEqual({
      status: 'verified',
      idNumberLast4: '9012',
      rejectionReason: null,
    });

    const profile = await profileOf(player.userId);
    const secret = ctx.deps.config.sessionSecret;
    expect(profile).toMatchObject({
      status: 'verified',
      provider: 'mock',
      idNumberHash: hmacSha256Hex(secret, `fayda:${fin}`),
      idNumberLast4: '9012',
      verifiedName: 'Abebe Bikila',
      verifiedDateOfBirth: ADULT_DOB,
      providerReference: 'mock-9012',
      rejectionReason: null,
      submittedAt: ctx.clock.now,
      reviewedAt: ctx.clock.now,
    });
    expect(JSON.stringify(profile)).not.toContain(fin);

    // The profile now carries the verified identity.
    expect(await userOf(player.userId)).toMatchObject({
      fullName: 'Abebe Bikila',
      dateOfBirth: ADULT_DOB,
    });

    const audits = await kycAudits(player.userId);
    expect(audits).toEqual([
      {
        action: 'kyc.submitted',
        metadata: { provider: 'mock', idNumberLast4: '9012', previousStatus: 'unverified' },
      },
      {
        action: 'kyc.verified',
        metadata: {
          provider: 'mock',
          reference: 'mock-9012',
          reason: null,
          profileUpdated: { fullName: true, dateOfBirth: false },
        },
      },
    ]);
    expect(await kycEvents(player.userId)).toEqual([
      {
        type: 'kyc.status_changed',
        payload: {
          userId: player.userId,
          status: 'verified',
          previousStatus: 'unverified',
          provider: 'mock',
          reference: 'mock-9012',
          reason: null,
        },
      },
    ]);

    const kyc = await ctx.app.inject({ method: 'GET', url: '/me/kyc', headers: bearer(player) });
    expect(KycResponse.parse(kyc.json())).toEqual({
      status: 'verified',
      idNumberLast4: '9012',
      rejectionReason: null,
    });
    const me = await ctx.app.inject({ method: 'GET', url: '/me', headers: bearer(player) });
    expect(MeResponse.parse(me.json())).toMatchObject({
      fullName: 'Abebe Bikila',
      kyc: { status: 'verified', idNumberLast4: '9012' },
    });
  });

  it('accepts a 16-digit FAN', async () => {
    const player = await registerAndLogin(ctx);
    const fan = `1234${freshFin('5678')}`;
    expect(fan).toHaveLength(16);
    const response = await submit(player, kycPayload(fan));
    expect(response.statusCode).toBe(200);
    expect(KycResponse.parse(response.json())).toMatchObject({
      status: 'verified',
      idNumberLast4: '5678',
    });
  });

  it('refuses a new submission once verified, without calling the provider', async () => {
    const player = await registerAndLogin(ctx);
    expect((await submit(player, kycPayload(freshFin()), scriptedApp)).statusCode).toBe(200);
    const calls = scripted.calls.length;

    const again = await submit(player, kycPayload(freshFin()), scriptedApp);
    expect(again.statusCode).toBe(409);
    expect(apiError(again).code).toBe('kyc_already_verified');
    expect(scripted.calls).toHaveLength(calls);
    expect((await profileOf(player.userId))!.providerReference).toBe('scripted-ref');
  });

  it('stores a registry rejection and lets the player try again', async () => {
    const player = await registerAndLogin(ctx);
    const rejected = await submit(player, kycPayload(freshFin('0000')));
    expect(rejected.statusCode).toBe(200);
    expect(KycResponse.parse(rejected.json())).toEqual({
      status: 'rejected',
      idNumberLast4: '0000',
      rejectionReason: 'ID not found in the Fayda registry (mock)',
    });
    expect(await profileOf(player.userId)).toMatchObject({
      status: 'rejected',
      providerReference: null,
      verifiedName: null,
      reviewedAt: ctx.clock.now,
    });
    // A rejection does not touch the profile.
    expect((await userOf(player.userId)).fullName).toBe('Test Player');

    const verified = await submit(player, kycPayload(freshFin('4444')));
    expect(verified.statusCode).toBe(200);
    expect(KycResponse.parse(verified.json())).toEqual({
      status: 'verified',
      idNumberLast4: '4444',
      rejectionReason: null,
    });
    const events = await kycEvents(player.userId);
    expect(events.map((event) => event.payload)).toEqual([
      expect.objectContaining({ status: 'rejected', previousStatus: 'unverified' }),
      expect.objectContaining({ status: 'verified', previousStatus: 'rejected' }),
    ]);
    expect((await kycAudits(player.userId)).map((row) => row.action)).toEqual([
      'kyc.submitted',
      'kyc.rejected',
      'kyc.submitted',
      'kyc.verified',
    ]);
  });

  it('keeps a submission that needs manual review pending', async () => {
    const player = await registerAndLogin(ctx);
    const response = await submit(player, kycPayload(freshFin('9999')));
    expect(response.statusCode).toBe(200);
    expect(KycResponse.parse(response.json())).toEqual({
      status: 'pending',
      idNumberLast4: '9999',
      rejectionReason: null,
    });
    expect(await profileOf(player.userId)).toMatchObject({
      status: 'pending',
      providerReference: 'mock-9999',
      submittedAt: ctx.clock.now,
      reviewedAt: null,
    });
    expect((await userOf(player.userId)).fullName).toBe('Test Player');
    expect((await kycAudits(player.userId)).map((row) => row.action)).toEqual([
      'kyc.submitted',
      'kyc.pending',
    ]);

    // A pending submission can be replaced.
    const replaced = await submit(player, kycPayload(freshFin('2468')));
    expect(KycResponse.parse(replaced.json()).status).toBe('verified');
  });

  it('allows one account per ID: 409 id_already_used while another account holds it', async () => {
    const holder = await registerAndLogin(ctx);
    const fin = freshFin('3333');
    expect((await submit(holder, kycPayload(fin))).statusCode).toBe(200);

    const other = await registerAndLogin(ctx);
    const calls = scripted.calls.length;
    const formatted = `${fin.slice(0, 6)} ${fin.slice(6)}`;
    const duplicate = await submit(other, kycPayload(formatted), scriptedApp);
    expect(duplicate.statusCode).toBe(409);
    expect(apiError(duplicate).code).toBe('id_already_used');
    expect(scripted.calls).toHaveLength(calls);
    expect(await profileOf(other.userId)).toBeUndefined();

    // A pending review holds the ID too.
    const reviewing = await registerAndLogin(ctx);
    const pendingFin = freshFin('9999');
    expect((await submit(reviewing, kycPayload(pendingFin))).statusCode).toBe(200);
    const second = await registerAndLogin(ctx);
    const blocked = await submit(second, kycPayload(pendingFin));
    expect(blocked.statusCode).toBe(409);
    expect(apiError(blocked).code).toBe('id_already_used');
  });

  it('does not let a rejected submission block the ID for someone else', async () => {
    const first = await registerAndLogin(ctx);
    const fin = freshFin('7777');
    await ctx.db.db.insert(kycProfiles).values({
      userId: first.userId,
      status: 'rejected',
      provider: 'mock',
      idNumberHash: idNumberHash(ctx.deps.config.sessionSecret, fin),
      idNumberLast4: '7777',
      rejectionReason: 'name_mismatch',
    });
    const second = await registerAndLogin(ctx);
    const response = await submit(second, kycPayload(fin));
    expect(response.statusCode).toBe(200);
    expect(KycResponse.parse(response.json()).status).toBe('verified');
  });

  it('rejects an identity under 21 with 422 underage and records the rejection', async () => {
    const player = await registerAndLogin(ctx);
    const dob = dobForAge(ctx.clock.now, 21, 1);
    const response = await submit(player, kycPayload(freshFin(), { dateOfBirth: dob }));
    expect(response.statusCode).toBe(422);
    expect(apiError(response)).toMatchObject({ code: 'underage', details: { minAge: 21 } });

    expect(await profileOf(player.userId)).toMatchObject({
      status: 'rejected',
      rejectionReason: 'underage',
      verifiedDateOfBirth: dob,
      reviewedAt: ctx.clock.now,
    });
    expect(await userOf(player.userId)).toMatchObject({
      fullName: 'Test Player',
      dateOfBirth: ADULT_DOB,
    });
    const audits = await kycAudits(player.userId);
    expect(audits.at(-1)).toMatchObject({
      action: 'kyc.rejected',
      metadata: { reason: 'underage' },
    });
    expect((await kycEvents(player.userId))[0]!.payload).toMatchObject({
      status: 'rejected',
      reason: 'underage',
    });
    const kyc = await ctx.app.inject({ method: 'GET', url: '/me/kyc', headers: bearer(player) });
    expect(KycResponse.parse(kyc.json())).toMatchObject({
      status: 'rejected',
      rejectionReason: 'underage',
    });
  });

  it('verifies someone who turns 21 today and syncs the date of birth', async () => {
    const player = await registerAndLogin(ctx);
    const dob = dobForAge(ctx.clock.now, 21);
    const response = await submit(player, kycPayload(freshFin(), { dateOfBirth: dob }));
    expect(response.statusCode).toBe(200);
    expect(KycResponse.parse(response.json()).status).toBe('verified');
    expect((await userOf(player.userId)).dateOfBirth).toBe(dob);
    expect((await kycAudits(player.userId)).at(-1)!.metadata).toMatchObject({
      profileUpdated: { fullName: true, dateOfBirth: true },
    });
  });

  it('rejects a verified identity whose name does not match (name_mismatch)', async () => {
    const player = await registerAndLogin(ctx);
    scripted.respond = async (request) => ({
      status: 'verified',
      verifiedName: 'Kenenisa Bekele',
      verifiedDateOfBirth: request.dateOfBirth,
      reference: 'ref-mismatch',
    });
    try {
      const response = await submit(player, kycPayload(freshFin()), scriptedApp);
      expect(response.statusCode).toBe(200);
      expect(KycResponse.parse(response.json())).toMatchObject({
        status: 'rejected',
        rejectionReason: 'name_mismatch',
      });
      expect(await profileOf(player.userId)).toMatchObject({
        status: 'rejected',
        provider: 'scripted',
        verifiedName: 'Kenenisa Bekele',
        providerReference: 'ref-mismatch',
      });
      expect((await userOf(player.userId)).fullName).toBe('Test Player');
    } finally {
      scripted.respond = new ScriptedKyc().respond;
    }
  });

  it('matches names ignoring case and spacing, keeping the registry spelling', async () => {
    const player = await registerAndLogin(ctx);
    scripted.respond = async (request) => ({
      status: 'verified',
      verifiedName: 'ABEBE   BIKILA',
      verifiedDateOfBirth: request.dateOfBirth,
      reference: 'ref-loose',
    });
    try {
      const response = await submit(
        player,
        kycPayload(freshFin(), { fullName: 'abebe bikila' }),
        scriptedApp,
      );
      expect(KycResponse.parse(response.json()).status).toBe('verified');
      expect((await userOf(player.userId)).fullName).toBe('ABEBE   BIKILA');
    } finally {
      scripted.respond = new ScriptedKyc().respond;
    }
  });

  it('returns 503 kyc_unavailable and stores nothing when the provider fails', async () => {
    const player = await registerAndLogin(ctx);
    const failures: Array<ScriptedKyc['respond']> = [
      async () => {
        throw new Error('registry timeout');
      },
      async (request) => ({
        status: 'verified',
        verifiedName: request.fullName,
        verifiedDateOfBirth: 'not-a-date',
        reference: 'ref-bad',
      }),
    ];
    try {
      for (const failure of failures) {
        scripted.respond = failure;
        const response = await submit(player, kycPayload(freshFin()), scriptedApp);
        expect(response.statusCode).toBe(503);
        expect(apiError(response).code).toBe('kyc_unavailable');
      }
    } finally {
      scripted.respond = new ScriptedKyc().respond;
    }
    expect(await profileOf(player.userId)).toBeUndefined();
    expect(await kycAudits(player.userId)).toHaveLength(0);
    expect(await kycEvents(player.userId)).toHaveLength(0);
  });

  it('turns a lost race for the same ID into 409 id_already_used', async () => {
    const player = await registerAndLogin(ctx);
    const rival = await registerAndLogin(ctx);
    const fin = freshFin('5555');
    scripted.respond = async (request) => {
      // Another account is verified with the same ID while the registry call is in flight.
      await ctx.db.db.insert(kycProfiles).values({
        userId: rival.userId,
        status: 'verified',
        provider: 'scripted',
        idNumberHash: idNumberHash(ctx.deps.config.sessionSecret, request.idNumber),
        idNumberLast4: '5555',
      });
      return {
        status: 'verified',
        verifiedName: request.fullName,
        verifiedDateOfBirth: request.dateOfBirth,
        reference: 'ref-race',
      };
    };
    try {
      const response = await submit(player, kycPayload(fin), scriptedApp);
      expect(response.statusCode).toBe(409);
      expect(apiError(response).code).toBe('id_already_used');
    } finally {
      scripted.respond = new ScriptedKyc().respond;
    }
    expect(await profileOf(player.userId)).toBeUndefined();
    expect(await kycAudits(player.userId)).toHaveLength(0);
  });

  it('validates the body before calling the provider', async () => {
    const player = await registerAndLogin(ctx);
    const calls = scripted.calls.length;
    for (const payload of [
      kycPayload('12345'),
      kycPayload('1234567890123'),
      kycPayload('abcd12345678'),
      kycPayload(freshFin(), { fullName: 'A' }),
      kycPayload(freshFin(), { dateOfBirth: '17/05/1990' }),
      { idNumber: freshFin() },
    ]) {
      const response = await submit(player, payload, scriptedApp);
      expect(response.statusCode).toBe(400);
      expect(apiError(response).code).toBe('validation_error');
    }
    const impossible = await submit(
      player,
      kycPayload(freshFin(), { dateOfBirth: '1990-02-30' }),
      scriptedApp,
    );
    expect(impossible.statusCode).toBe(400);
    expect(apiError(impossible).code).toBe('invalid_date_of_birth');
    expect(scripted.calls).toHaveLength(calls);
    expect(await profileOf(player.userId)).toBeUndefined();
  });

  it('requires the CSRF header with cookie authentication', async () => {
    const player = await registerAndLogin(ctx);
    const forged = await ctx.app.inject({
      method: 'POST',
      url: '/me/kyc',
      payload: kycPayload(freshFin()),
      headers: { cookie: player.cookie },
    });
    expect(forged.statusCode).toBe(403);
    expect(apiError(forged).code).toBe('csrf_invalid');
    const ok = await ctx.app.inject({
      method: 'POST',
      url: '/me/kyc',
      payload: kycPayload(freshFin()),
      headers: { cookie: player.cookie, 'x-csrf-token': player.csrfToken },
    });
    expect(ok.statusCode).toBe(200);
  });

  it(`limits submissions to ${KYC_SUBMISSIONS_PER_HOUR} an hour per player`, async () => {
    const player = await registerAndLogin(ctx);
    // The mock registry rejects IDs ending in 0000, so every attempt reaches it.
    for (let i = 0; i < KYC_SUBMISSIONS_PER_HOUR; i += 1) {
      const response = await submit(player, kycPayload(freshFin('0000')));
      expect(response.statusCode).toBe(200);
    }
    const limited = await submit(player, kycPayload(freshFin('0000')));
    expect(limited.statusCode).toBe(429);
    expect(apiError(limited).code).toBe('rate_limited');

    const other = await registerAndLogin(ctx);
    expect((await submit(other, kycPayload(freshFin()))).statusCode).toBe(200);
  });

  describe('helpers', () => {
    it('hashes ID numbers with the server secret', () => {
      const hash = idNumberHash('secret-a', '123456789012');
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(hash).toBe(hmacSha256Hex('secret-a', 'fayda:123456789012'));
      expect(idNumberHash('secret-b', '123456789012')).not.toBe(hash);
      expect(idNumberHash('secret-a', '123456789013')).not.toBe(hash);
    });

    it('compares names ignoring case and whitespace', () => {
      expect(namesMatch('Abebe Bikila', 'abebe bikila')).toBe(true);
      expect(namesMatch(' Abebe\tBikila ', 'ABEBEBIKILA')).toBe(true);
      expect(namesMatch('አበበ ቢቂላ', 'አበበ፡ቢቂላ')).toBe(true);
      expect(namesMatch('Abebe Bikila', 'Abebe Bekele')).toBe(false);
      expect(nameKey('Ｔｉｒｕｎｅｓｈ  Dibaba')).toBe('tirunesh' + 'dibaba');
    });
  });
});
