/**
 * Creates a back-office staff account and prints its TOTP enrolment.
 *
 *   pnpm admin:create --email ops@example.et --name "Abebe K." --role admin
 *   pnpm admin:create --email desk1@example.et --name "Hana T." --role cashier --shop 1001-01 \
 *     --phone 0911223344
 *
 * `--shop <code>` (cashiers only) assigns the new cashier to that shop at once (the owner runs more
 * than 40 shops; a cashier opens shifts only at their shop). The shop must exist and be active: it is
 * checked before the account is created; a shop's printed number (`1001-01`) or its code works.
 * `--phone <mobile>`: the staff member's mobile number, required for a cashier (owner, 19 Nov 2026:
 * every agent's people have a name and a phone number).
 * Roles: admin, trader, finance, kyc, support, compliance. The password comes
 * from the ADMIN_PASSWORD environment variable (at least 12 characters);
 * without it a random one is generated and printed once, and must be
 * changed at the first sign-in (Account page). Scan the printed
 * otpauth:// URI (or type the secret) into an authenticator app: sign-in
 * needs its 6-digit code. Uses DATABASE_URL and ADMIN_TOTP_KEY from the
 * environment / .env, like the API.
 */
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { loadConfig, loadDotEnv } from '@vamos/config';
import { createPasswordHasher } from '../backoffice/argon2';
import { createStaffUser, STAFF_ROLES, type StaffRole } from '../backoffice/staff-auth';
import { createDb } from '../client';
import { DomainError } from '../errors';
import { writeAudit } from '../platform/audit';
import { cashierShops, cashierStaffShops } from '../schema/cashier';
import { agents } from '../schema/retail';
import { parseShopLabel } from '@vamos/core';
import { and, eq, or } from 'drizzle-orm';

const USAGE =
  'usage: pnpm admin:create --email <email> --name <display name> --role <' +
  `${STAFF_ROLES.join('|')}> [--shop <shop number or code>] [--phone <mobile>]  ` +
  '(--phone is required for a cashier; password: ADMIN_PASSWORD env, else generated)';

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    role: { type: 'string' },
    shop: { type: 'string' },
    phone: { type: 'string' },
    help: { type: 'boolean' },
  },
  strict: true,
});
if (values.help) {
  console.warn(USAGE);
  process.exit(0);
}
if (!values.email || !values.name || !values.role) fail(USAGE);
if (!(STAFF_ROLES as readonly string[]).includes(values.role)) fail(USAGE);
if (values.shop !== undefined && values.role !== 'cashier')
  fail('--shop is for --role cashier only');
if (values.role === 'cashier' && !values.phone?.trim()) fail('a cashier needs --phone <mobile>');

loadDotEnv();
const config = loadConfig();
const handle = createDb(config.databaseUrl, { max: 1 });
try {
  // The shop first: a wrong code must not leave a cashier account without its shop.
  let shopId: string | null = null;
  if (values.shop !== undefined) {
    const wanted = values.shop.trim().toLowerCase();
    const label = parseShopLabel(wanted);
    const [shop] = await handle.db
      .select({ id: cashierShops.id, active: cashierShops.active })
      .from(cashierShops)
      .innerJoin(agents, eq(agents.id, cashierShops.agentId))
      .where(
        label === null
          ? eq(cashierShops.code, wanted)
          : or(
              eq(cashierShops.code, wanted),
              and(eq(agents.number, label.agentNumber), eq(cashierShops.number, label.shopNumber)),
            ),
      )
      .limit(1);
    if (!shop || !shop.active) fail(`no active shop with the code "${values.shop}"`);
    shopId = shop.id;
  }
  const password = process.env.ADMIN_PASSWORD?.trim() ? process.env.ADMIN_PASSWORD : undefined;
  const result = await createStaffUser(
    {
      db: handle.db,
      clock: () => new Date(),
      randomBytes,
      totpKey: config.admin.totpKey,
      passwords: createPasswordHasher(config.passwordPepper),
    },
    {
      email: values.email,
      displayName: values.name,
      role: values.role as StaffRole,
      ...(values.phone === undefined ? {} : { phone: values.phone }),
      ...(password === undefined ? {} : { password }),
      requirePasswordChange: password === undefined,
      actor: { type: 'system', via: 'cli' },
    },
  );
  if (shopId !== null) {
    await handle.db.transaction(async (tx) => {
      await tx
        .insert(cashierStaffShops)
        .values({ staffId: result.user.id, shopId, assignedAt: new Date() });
      await writeAudit(tx, {
        actorType: 'system',
        action: 'cashier.staff_shop_assigned',
        targetType: 'admin_user',
        targetId: result.user.id,
        metadata: { before: null, after: shopId, via: 'cli' },
      });
    });
  }
  const lines = [
    `staff account created: ${result.user.email} (${result.user.role}, id ${result.user.id})`,
    ...(shopId === null ? [] : [`works at shop: ${values.shop}`]),
    ...(result.generatedPassword === null
      ? []
      : [
          `password (shown once; you must change it at the first sign-in): ${result.generatedPassword}`,
        ]),
    `TOTP secret (shown once): ${result.totp.secret}`,
    `otpauth URI (scan as a QR code): ${result.totp.uri}`,
  ];
  console.warn(lines.join('\n'));
} catch (error) {
  if (error instanceof DomainError) fail(`refused: ${error.code}: ${error.message}`);
  throw error;
} finally {
  await handle.close();
}
