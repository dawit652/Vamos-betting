/**
 * Recovers or retires a back-office staff account from the server, without signing in (the out-of-band
 * recovery for a lost password or authenticator, and the way to disable an account: the back office has
 * no screen for it).
 *
 *   ADMIN_PASSWORD='<12+ characters>' pnpm admin:reset --email ops@example.et --action password
 *   pnpm admin:reset --email ops@example.et --action totp
 *   pnpm admin:reset --email ops@example.et --action disable
 *   pnpm admin:reset --email ops@example.et --action enable
 *
 * password  sets the password from ADMIN_PASSWORD, lifts the lockouts and signs the account out
 * totp      issues a new authenticator secret (shown once; the old one stops working), signs the account out
 * disable   disables the account and signs it out; refused for the only enabled admin
 * enable    enables it again
 *
 * Every action is audited (via cli). Uses DATABASE_URL from the environment / .env.
 */
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { loadConfig, loadDotEnv } from '@vamos/config';
import { createPasswordHasher } from '../backoffice/argon2';
import {
  findStaffUserByEmail,
  resetStaffPassword,
  resetStaffTotp,
  setStaffDisabled,
} from '../backoffice/staff-auth';
import { createDb } from '../client';
import { DomainError } from '../errors';

const ACTIONS = ['password', 'totp', 'disable', 'enable'] as const;
type Action = (typeof ACTIONS)[number];

const USAGE =
  'usage: [ADMIN_PASSWORD=<12+ characters>] pnpm admin:reset --email <email> --action <' +
  ACTIONS.join('|') +
  '>';

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const { values } = parseArgs({
  options: { email: { type: 'string' }, action: { type: 'string' }, help: { type: 'boolean' } },
  strict: true,
});
if (values.help) {
  console.warn(USAGE);
  process.exit(0);
}
if (!values.email || !values.action) fail(USAGE);
if (!(ACTIONS as readonly string[]).includes(values.action)) fail(USAGE);
const action = values.action as Action;
const password = process.env.ADMIN_PASSWORD?.trim() ? process.env.ADMIN_PASSWORD : undefined;
if (action === 'password' && password === undefined) {
  fail('set ADMIN_PASSWORD (12+ characters) to the new password.\n' + USAGE);
}

loadDotEnv();
const config = loadConfig();
const handle = createDb(config.databaseUrl, { max: 1 });
const actor = { type: 'system', via: 'cli' } as const;
try {
  const user = await findStaffUserByEmail(handle.db, values.email);
  if (user === null) {
    console.error(`no staff account with the email ${values.email}`);
    process.exitCode = 1;
  } else {
    const authDeps = {
      db: handle.db,
      clock: () => new Date(),
      randomBytes,
      totpKey: config.admin.totpKey,
      passwords: createPasswordHasher(config.passwordPepper),
    };
    const who = `${user.email} (${user.role}, id ${user.id})`;
    if (action === 'password') {
      await resetStaffPassword(authDeps, { adminUserId: user.id, password: password ?? '', actor });
      console.warn(`password reset: ${who}. Every session was signed out.`);
    } else if (action === 'totp') {
      const enrolment = await handle.db.transaction((tx) =>
        resetStaffTotp(tx, authDeps, { adminUserId: user.id, actor, now: new Date() }),
      );
      console.warn(
        [
          `authenticator reset: ${who}. Every session was signed out.`,
          `TOTP secret (shown once): ${enrolment.secret}`,
          `otpauth URI (scan as a QR code): ${enrolment.uri}`,
        ].join('\n'),
      );
    } else {
      const disabled = action === 'disable';
      await handle.db.transaction((tx) =>
        setStaffDisabled(tx, { adminUserId: user.id, disabled, actor, now: new Date() }),
      );
      console.warn(`${disabled ? 'disabled' : 'enabled'}: ${who}`);
    }
  }
} catch (error) {
  if (error instanceof DomainError) fail(`refused: ${error.code}: ${error.message}`);
  throw error;
} finally {
  await handle.close();
}
