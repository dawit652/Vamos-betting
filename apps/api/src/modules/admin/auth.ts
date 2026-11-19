import {
  ChangeOwnPasswordRequest,
  ConfirmTotpEnrolmentRequest,
  CreateStaffRequest,
  CreateStaffResponse,
  ResetStaffPasswordRequest,
  RevokeOwnStaffSessionsRequest,
  StaffListResponse,
  StaffOwnSessionsResponse,
  StaffLoginRequest,
  StaffUserView,
  StartTotpEnrolmentRequest,
  TotpEnrolmentView,
  UpdateStaffRequest,
  type OkResponse,
  type RevokeOwnStaffSessionsResponse,
  type StaffSessionResponse,
} from '@vamos/contracts';
import {
  changeOwnStaffPassword,
  confirmOwnStaffTotpEnrolment,
  createStaffUser,
  getStaffUser,
  listOwnStaffSessions,
  listStaffUsers,
  loginStaff,
  logoutStaff,
  normalizeStaffEmail,
  resetStaffPassword,
  resetStaffTotp,
  revokeOwnStaffSessions,
  setStaffDisabled,
  startOwnStaffTotpEnrolment,
  unlockStaffUser,
  updateStaffUser,
  warmUpStaffPasswordHashing,
  type StaffAccountActor,
} from '@vamos/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { clientAddressKey } from '../../lib/client-address';
import { notFound, parseInput } from '../../lib/errors';
import { enforceLimit } from '../../lib/rate-limits';
import {
  apiPasswordHasher,
  clearStaffCookie,
  requireStaff,
  setStaffCookie,
  staffAuthDeps,
  staffSessionBody,
} from '../../plugins/staff-session';
import { inTx, parseUuid, wire } from './common';

/** The email of a sign-in body, normalised, for the per-account rate limit. */
function bodyEmail(request: FastifyRequest): string {
  const body = request.body as { email?: unknown } | null | undefined;
  return typeof body?.email === 'string' ? normalizeStaffEmail(body.email).slice(0, 254) : '';
}

function accountActor(request: FastifyRequest): StaffAccountActor {
  return { type: 'admin', adminId: requireStaff(request).id, ip: request.ip };
}

/** Sign-in, the session, sign-out, and staff accounts (staff.manage). */
export default async function adminAuthRoutes(app: FastifyInstance): Promise<void> {
  const { deps, authLimits } = app;
  const authDeps = staffAuthDeps(deps);
  // An unknown email then costs as much as a wrong password from the first request.
  await warmUpStaffPasswordHashing(apiPasswordHasher(deps.config));

  const perClient = app.createRateLimit({
    ...authLimits.staffLoginPerClient,
    keyGenerator: (request) => `staff-login-client|${clientAddressKey(request.ip)}`,
  });
  const perEmail = app.createRateLimit({
    ...authLimits.staffLoginPerEmail,
    // Per (email, address): a stranger using up the limit must not keep the staff member out
    // from their own address (the account-wide backoff bounds guessing spread over addresses).
    keyGenerator: (request) =>
      `staff-login-email|${bodyEmail(request)}|${clientAddressKey(request.ip)}`,
  });
  const loginLimits = async (request: FastifyRequest, reply: FastifyReply) => {
    await enforceLimit(perClient, request, reply);
    if (bodyEmail(request) !== '') await enforceLimit(perEmail, request, reply);
  };
  // Self-service changes check the password (argon2) and a code: limited like sign-in.
  const perStaff = app.createRateLimit({
    ...authLimits.staffLoginPerEmail,
    keyGenerator: (request) => `staff-self|${requireStaff(request).id}`,
  });
  const selfServiceLimits = async (request: FastifyRequest, reply: FastifyReply) => {
    await enforceLimit(perClient, request, reply);
    await enforceLimit(perStaff, request, reply);
  };

  app.post(
    '/admin/auth/login',
    { config: { staff: 'public' }, preHandler: loginLimits },
    async (request, reply): Promise<StaffSessionResponse> => {
      const input = parseInput(StaffLoginRequest, request.body);
      const { staff, session } = await loginStaff(authDeps, {
        email: input.email,
        password: input.password,
        code: input.code,
        ip: request.ip,
        clientKey: clientAddressKey(request.ip),
        userAgent: request.headers['user-agent'] ?? null,
      });
      setStaffCookie(reply, deps.config, session);
      return staffSessionBody(staff);
    },
  );

  app.get(
    '/admin/session',
    { config: { staff: 'session' } },
    async (request): Promise<StaffSessionResponse> => staffSessionBody(requireStaff(request)),
  );

  app.post(
    '/admin/auth/logout',
    { config: { staff: 'session' } },
    async (request, reply): Promise<OkResponse> => {
      const staff = requireStaff(request);
      await logoutStaff(deps, {
        sessionId: staff.sessionId,
        adminUserId: staff.id,
        ip: request.ip,
      });
      clearStaffCookie(reply, deps.config);
      return { ok: true };
    },
  );

  // The signed-in staff member's own password and authenticator (any role, also while a
  // password change is required).

  app.post(
    '/admin/me/password',
    { config: { staff: 'session' }, preHandler: selfServiceLimits },
    async (request): Promise<OkResponse> => {
      const staff = requireStaff(request);
      const input = parseInput(ChangeOwnPasswordRequest, request.body);
      await changeOwnStaffPassword(authDeps, {
        adminUserId: staff.id,
        sessionId: staff.sessionId,
        currentPassword: input.currentPassword,
        code: input.code,
        newPassword: input.newPassword,
        ip: request.ip,
        clientKey: clientAddressKey(request.ip),
      });
      return { ok: true };
    },
  );

  app.post(
    '/admin/me/totp',
    { config: { staff: 'session' }, preHandler: selfServiceLimits },
    async (request) => {
      const staff = requireStaff(request);
      const input = parseInput(StartTotpEnrolmentRequest, request.body);
      const enrolment = await startOwnStaffTotpEnrolment(authDeps, {
        adminUserId: staff.id,
        password: input.password,
        code: input.code,
        ip: request.ip,
        clientKey: clientAddressKey(request.ip),
      });
      return wire(TotpEnrolmentView, enrolment);
    },
  );

  app.post(
    '/admin/me/totp/confirm',
    { config: { staff: 'session' }, preHandler: selfServiceLimits },
    async (request): Promise<OkResponse> => {
      const staff = requireStaff(request);
      const input = parseInput(ConfirmTotpEnrolmentRequest, request.body);
      await confirmOwnStaffTotpEnrolment(authDeps, {
        adminUserId: staff.id,
        sessionId: staff.sessionId,
        code: input.code,
        ip: request.ip,
      });
      return { ok: true };
    },
  );

  app.get('/admin/me/sessions', { config: { staff: 'session' } }, async (request) => {
    const staff = requireStaff(request);
    const items = await listOwnStaffSessions(deps, {
      adminUserId: staff.id,
      sessionId: staff.sessionId,
    });
    return wire(StaffOwnSessionsResponse, { items });
  });

  app.post(
    '/admin/me/sessions/revoke',
    { config: { staff: 'session' }, preHandler: selfServiceLimits },
    async (request): Promise<RevokeOwnStaffSessionsResponse> => {
      const staff = requireStaff(request);
      const input = parseInput(RevokeOwnStaffSessionsRequest, request.body);
      return revokeOwnStaffSessions(authDeps, {
        adminUserId: staff.id,
        sessionId: staff.sessionId,
        password: input.password,
        code: input.code,
        ...(input.sessionId === undefined ? {} : { targetSessionId: input.sessionId }),
        ip: request.ip,
        clientKey: clientAddressKey(request.ip),
      });
    },
  );

  // Staff accounts (staff.manage).

  app.get('/admin/staff', { config: { staff: 'staff.manage' } }, async () =>
    wire(StaffListResponse, { items: await listStaffUsers(deps.db) }),
  );

  app.post('/admin/staff', { config: { staff: 'staff.manage' } }, async (request, reply) => {
    const input = parseInput(CreateStaffRequest, request.body);
    const created = await createStaffUser(authDeps, {
      email: input.email,
      displayName: input.displayName,
      role: input.role,
      ...(input.password === undefined ? {} : { password: input.password }),
      ...(input.phone === undefined ? {} : { phone: input.phone }),
      actor: accountActor(request),
    });
    return reply.status(201).send(wire(CreateStaffResponse, created));
  });

  app.get<{ Params: { id: string } }>(
    '/admin/staff/:id',
    { config: { staff: 'staff.manage' } },
    async (request) => {
      const user = await getStaffUser(deps.db, parseUuid(request.params.id, 'Staff account'));
      if (user === null) throw notFound('Staff account');
      return wire(StaffUserView, user);
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/admin/staff/:id',
    { config: { staff: 'staff.manage' } },
    async (request) => {
      const adminUserId = parseUuid(request.params.id, 'Staff account');
      const input = parseInput(UpdateStaffRequest, request.body);
      const actor = accountActor(request);
      const now = deps.clock();
      const user = await inTx(deps, (tx) =>
        updateStaffUser(tx, {
          adminUserId,
          ...(input.role === undefined ? {} : { role: input.role }),
          ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
          ...(input.phone === undefined ? {} : { phone: input.phone }),
          actor,
          now,
        }),
      );
      return wire(StaffUserView, user);
    },
  );

  for (const [path, disabled] of [
    ['disable', true],
    ['enable', false],
  ] as const) {
    app.post<{ Params: { id: string } }>(
      `/admin/staff/:id/${path}`,
      { config: { staff: 'staff.manage' } },
      async (request) => {
        const adminUserId = parseUuid(request.params.id, 'Staff account');
        const actor = accountActor(request);
        const now = deps.clock();
        const user = await inTx(deps, (tx) =>
          setStaffDisabled(tx, { adminUserId, disabled, actor, now }),
        );
        return wire(StaffUserView, user);
      },
    );
  }

  app.post<{ Params: { id: string } }>(
    '/admin/staff/:id/unlock',
    { config: { staff: 'staff.manage' } },
    async (request) => {
      const adminUserId = parseUuid(request.params.id, 'Staff account');
      const actor = accountActor(request);
      const now = deps.clock();
      const user = await inTx(deps, (tx) => unlockStaffUser(tx, { adminUserId, actor, now }));
      return wire(StaffUserView, user);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/admin/staff/:id/reset-totp',
    { config: { staff: 'staff.manage' } },
    async (request) => {
      const adminUserId = parseUuid(request.params.id, 'Staff account');
      const actor = accountActor(request);
      const now = deps.clock();
      const enrolment = await inTx(deps, (tx) =>
        resetStaffTotp(tx, authDeps, { adminUserId, actor, now }),
      );
      return wire(TotpEnrolmentView, enrolment);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/admin/staff/:id/reset-password',
    { config: { staff: 'staff.manage' } },
    async (request) => {
      const adminUserId = parseUuid(request.params.id, 'Staff account');
      const input = parseInput(ResetStaffPasswordRequest, request.body);
      const user = await resetStaffPassword(authDeps, {
        adminUserId,
        password: input.password,
        actor: accountActor(request),
      });
      return wire(StaffUserView, user);
    },
  );
}
