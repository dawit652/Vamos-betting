import { createHmac } from 'node:crypto';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import type { StaffSessionResponse } from '@vamos/contracts';
import { ADMIN_URL, API_URL } from './env';

/**
 * Back-office (staff) helpers. The demo seed (`pnpm db:seed`, demo mode only) creates one staff
 * user per role with the same password and the same TOTP secret, documented in
 * packages/db/src/backoffice/demo-staff.ts; they are repeated here on purpose so the e2e suite
 * does not depend on the db package. Never used outside demo mode.
 */

export type StaffRole =
  'admin' | 'trader' | 'finance' | 'kyc' | 'support' | 'compliance' | 'cashier';

export const DEMO_STAFF_PASSWORD = 'vamos-demo-staff';
/** Base32 TOTP secret shared by every demo staff user. */
export const DEMO_STAFF_TOTP_SECRET = 'OZQW233TFVSGK3LPFVZXIYLGMYWW65DQ';
export const STAFF_CSRF_HEADER = 'x-staff-csrf-token';

const STEP_S = 30;

export function staffEmail(role: StaffRole): string {
  return `${role}@demo.vamos.test`;
}

function base32Decode(text: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of text.replace(/=+$/, '').toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error(`not base32: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** RFC 6238 TOTP (HMAC-SHA1, 30 s, 6 digits) for the time step containing `atMs`. */
export function totpCode(secret: string, atMs: number = Date.now()): string {
  const counter = Math.floor(atMs / 1000 / STEP_S);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', base32Decode(secret)).update(message).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    (hmac[offset + 1]! << 16) |
    (hmac[offset + 2]! << 8) |
    hmac[offset + 3]!;
  return String(binary % 1_000_000).padStart(6, '0');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The server refuses a code for a time step it already accepted for that account (replay guard),
 * so a second sign-in of the same account needs the next step. This tracks the step last used per
 * account in this process and waits for the next one when needed (a previous run of the suite a
 * few seconds ago is handled by the callers' retry).
 */
const lastStepUsed = new Map<string, number>();

/** A fresh code for the account, waiting for a later step when this one was used already. */
export async function nextTotpCode(
  email: string,
  secret: string = DEMO_STAFF_TOTP_SECRET,
): Promise<string> {
  for (;;) {
    const now = Date.now();
    const step = Math.floor(now / 1000 / STEP_S);
    const msLeft = (step + 1) * STEP_S * 1000 - now;
    const used = lastStepUsed.get(email);
    // Too close to the end of the step: the code could expire in flight (the server allows
    // one step of drift, but a replay of the previous step is refused), so use the next one.
    if ((used !== undefined && used >= step) || msLeft < 1500) {
      await sleep(msLeft + 100);
      continue;
    }
    lastStepUsed.set(email, step);
    return totpCode(secret, now);
  }
}

/** Signs `role` in through the login form of the admin app and waits for the dashboard shell. */
export async function loginInBrowser(page: Page, role: StaffRole): Promise<void> {
  await loginAccountInBrowser(page, {
    email: staffEmail(role),
    password: DEMO_STAFF_PASSWORD,
    totpSecret: DEMO_STAFF_TOTP_SECRET,
    role,
  });
}

/** A staff account the tests sign in with: a demo account, or one made with `admin:create`. */
export interface StaffCredentials {
  email: string;
  password: string;
  /** The base32 TOTP secret `admin:create` printed. */
  totpSecret: string;
  /** The role the dashboard shell should show; any role when undefined. */
  role?: string;
}

/** Signs a staff account in through the login form of the admin app and waits for the shell. */
export async function loginAccountInBrowser(page: Page, account: StaffCredentials): Promise<void> {
  const { email } = account;
  // Twice at most: a run of the suite within the same 30 s step leaves the code used.
  for (let attempt = 1; ; attempt += 1) {
    await page.goto(`${ADMIN_URL}/login`);
    const code = await nextTotpCode(email, account.totpSecret);
    const emailInput = page.getByLabel('Email', { exact: true });
    // Hydration: typing before it is attached is lost, so retry until the value sticks.
    await expect(async () => {
      await emailInput.fill(email);
      await expect(emailInput).toHaveValue(email, { timeout: 1000 });
    }).toPass({ timeout: 15_000 });
    await page.getByLabel('Password', { exact: true }).fill(account.password);
    await page.getByLabel('Authenticator code').fill(code);
    await page.getByRole('button', { name: 'Sign in' }).click();
    const signedIn = page.getByTestId('staff-role');
    try {
      if (account.role === undefined) await expect(signedIn).toBeVisible({ timeout: 10_000 });
      else await expect(signedIn).toHaveText(account.role, { timeout: 10_000 });
      return;
    } catch (error) {
      if (attempt >= 2) throw error;
      lastStepUsed.set(email, Math.floor(Date.now() / 1000 / STEP_S));
    }
  }
}

/** A signed-in staff API client: the request context keeps the staff cookie. */
export interface StaffApi {
  session: StaffSessionResponse;
  get(path: string): ReturnType<APIRequestContext['get']>;
  post(path: string, data?: unknown): ReturnType<APIRequestContext['post']>;
  put(path: string, data: unknown): ReturnType<APIRequestContext['put']>;
}

/** The staff API for an already signed-in request context (a browser context's `request`). */
export async function staffApiOf(request: APIRequestContext): Promise<StaffApi> {
  const response = await request.get(`${API_URL}/admin/session`);
  if (!response.ok()) throw new Error(`GET /admin/session failed: ${response.status()}`);
  return bindStaffApi(request, (await response.json()) as StaffSessionResponse);
}

function bindStaffApi(request: APIRequestContext, session: StaffSessionResponse): StaffApi {
  return {
    session,
    get: (path) => request.get(`${API_URL}${path}`),
    post: (path, data) =>
      request.post(`${API_URL}${path}`, {
        headers: { [STAFF_CSRF_HEADER]: session.csrfToken },
        data: data ?? {},
      }),
    put: (path, data) =>
      request.put(`${API_URL}${path}`, {
        headers: { [STAFF_CSRF_HEADER]: session.csrfToken },
        data,
      }),
  };
}

/** Signs `role` in through POST /admin/auth/login on a cookie-keeping request context. */
export async function loginApi(request: APIRequestContext, role: StaffRole): Promise<StaffApi> {
  const email = staffEmail(role);
  for (let attempt = 1; ; attempt += 1) {
    const code = await nextTotpCode(email);
    const response = await request.post(`${API_URL}/admin/auth/login`, {
      data: { email, password: DEMO_STAFF_PASSWORD, code },
    });
    if (response.ok()) {
      return bindStaffApi(request, (await response.json()) as StaffSessionResponse);
    }
    if (attempt >= 2) {
      throw new Error(
        `staff login of ${role} failed: ${response.status()} ${await response.text()}`,
      );
    }
    lastStepUsed.set(email, Math.floor(Date.now() / 1000 / STEP_S));
  }
}

/**
 * Assigns the demo cashier to the HQ shop (1000-01). Other specs add shops, and while more than
 * one shop is open an unassigned cashier cannot open a shift. It stays assigned (harmless: HQ is
 * the demo cashier's shop).
 */
export async function assignDemoCashierToHq(admin: StaffApi): Promise<void> {
  const { shops } = (await (await admin.get('/admin/cashier/shops')).json()) as {
    shops: Array<{ id: string; label: string }>;
  };
  const { staff } = (await (await admin.get('/admin/cashier/staff')).json()) as {
    staff: Array<{ id: string; email: string; shopId: string | null }>;
  };
  const hq = shops.find((shop) => shop.label === '1000-01');
  const cashier = staff.find((member) => member.email === staffEmail('cashier'));
  if (hq === undefined || cashier === undefined) {
    throw new Error('the HQ shop 1000-01 or the demo cashier is missing (pnpm db:seed?)');
  }
  if (cashier.shopId === hq.id) return;
  const response = await admin.put(`/admin/cashier/staff/${cashier.id}/shop`, { shopId: hq.id });
  if (!response.ok()) {
    throw new Error(
      `assigning the demo cashier failed: ${response.status()} ${await response.text()}`,
    );
  }
}
