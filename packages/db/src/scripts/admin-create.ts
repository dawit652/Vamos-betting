/**
 * Creates a back-office staff account and prints its TOTP enrolment.
 *
 *   pnpm admin:create --email ops@example.et --name "Abebe K." --role admin
 *
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
import { argon2PasswordHasher } from '../backoffice/argon2';
import { createStaffUser, STAFF_ROLES, type StaffRole } from '../backoffice/staff-auth';
import { createDb } from '../client';
import { DomainError } from '../errors';

const USAGE =
  'usage: pnpm admin:create --email <email> --name <display name> --role <' +
  `${STAFF_ROLES.join('|')}>  (password: ADMIN_PASSWORD env, else generated)`;

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    role: { type: 'string' },
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

loadDotEnv();
const config = loadConfig();
const handle = createDb(config.databaseUrl, { max: 1 });
try {
  const password = process.env.ADMIN_PASSWORD?.trim() ? process.env.ADMIN_PASSWORD : undefined;
  const result = await createStaffUser(
    {
      db: handle.db,
      clock: () => new Date(),
      randomBytes,
      totpKey: config.admin.totpKey,
      passwords: argon2PasswordHasher,
    },
    {
      email: values.email,
      displayName: values.name,
      role: values.role as StaffRole,
      ...(password === undefined ? {} : { password }),
      requirePasswordChange: password === undefined,
      actor: { type: 'system', via: 'cli' },
    },
  );
  const lines = [
    `staff account created: ${result.user.email} (${result.user.role}, id ${result.user.id})`,
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
