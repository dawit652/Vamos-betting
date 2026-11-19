import {
  STAFF_CSRF_HEADER,
  STAFF_ROLES,
  STAFF_SESSION_COOKIE,
  StaffSessionResponse,
} from '@vamos/contracts';
import { seedDemoStaff, type StaffRole } from '@vamos/db';
import { DEMO_STAFF_PASSWORD, DEMO_STAFF_TOTP_SECRET } from '@vamos/db/demo-staff';
import { base32Decode, totpCode } from '@vamos/db/totp';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { apiPasswordHasher } from '../src/plugins/staff-session';
import type { TestContext } from './helpers';

export const DEMO_TOTP_SECRET = base32Decode(DEMO_STAFF_TOTP_SECRET);

export const staffEmail = (role: StaffRole) => `${role}@demo.vamos.test`;

/** Creates the demo staff accounts (one per role, known password and TOTP secret). */
export async function seedStaff(ctx: TestContext): Promise<void> {
  const result = await seedDemoStaff(
    {
      db: ctx.deps.db,
      clock: ctx.deps.clock,
      totpKey: ctx.deps.config.admin.totpKey,
      passwords: apiPasswordHasher(ctx.deps.config),
    },
    { mode: 'demo', nodeEnv: 'test' },
  );
  if (result.skipped !== null) throw new Error(`demo staff not seeded: ${result.skipped}`);
}

/** The TOTP code of the demo secret at the test clock's time (`offsetMs` later). */
export function demoCode(ctx: TestContext, offsetMs = 0): string {
  return totpCode(DEMO_TOTP_SECRET, ctx.clock.now.getTime() + offsetMs);
}

export interface StaffSession {
  role: StaffRole;
  id: string;
  /** The raw session token (the cookie value). */
  token: string;
  /** Cookie header carrying the staff session. */
  cookie: string;
  csrfToken: string;
}

export function staffLoginRequest(
  ctx: TestContext,
  payload: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return ctx.app.inject({ method: 'POST', url: '/admin/auth/login', payload });
}

/**
 * Signs a demo staff member in. A code is accepted once per account and
 * 30-second step, so the clock moves on a step first (a second sign-in of
 * the same account in a test file then needs no care).
 */
export async function staffLogin(ctx: TestContext, role: StaffRole): Promise<StaffSession> {
  ctx.clock.advance(30_000);
  const response = await staffLoginRequest(ctx, {
    email: staffEmail(role),
    password: DEMO_STAFF_PASSWORD,
    code: demoCode(ctx),
  });
  if (response.statusCode !== 200) {
    throw new Error(`staff login failed: ${response.statusCode} ${response.body}`);
  }
  const body = StaffSessionResponse.parse(response.json());
  const cookie = response.cookies.find((c) => c.name === STAFF_SESSION_COOKIE);
  if (cookie === undefined) throw new Error('no staff cookie');
  return {
    role,
    id: body.staff.id,
    token: cookie.value,
    cookie: `${STAFF_SESSION_COOKIE}=${cookie.value}`,
    csrfToken: body.csrfToken,
  };
}

/** A request as a signed-in staff member (cookie and CSRF header). */
export function asStaff(
  ctx: TestContext,
  staff: StaffSession,
  method: InjectOptions['method'],
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  return ctx.app.inject({
    method,
    url,
    headers: { cookie: staff.cookie, [STAFF_CSRF_HEADER]: staff.csrfToken, ...headers },
    ...(payload === undefined ? {} : { payload: payload as InjectOptions['payload'] }),
  });
}

/** Every role that signs in to the back office: all but the agent owner (the shop app only). */
export const BACK_OFFICE_ROLES = STAFF_ROLES.filter(
  (role): role is Exclude<StaffRole, 'agent_owner'> => role !== 'agent_owner',
);
