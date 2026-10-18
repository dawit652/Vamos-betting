/**
 * Lifts the sign-in lockouts of a back-office staff account (out-of-band
 * recovery when no admin can sign in to do it from the back office).
 *
 *   pnpm admin:unlock --email ops@example.et
 *
 * Clears the account-wide delay and every address's lockout. Audited as
 * `staff.unlocked` (via cli). Uses DATABASE_URL from the environment / .env.
 */
import { parseArgs } from 'node:util';
import { loadConfig, loadDotEnv } from '@vamos/config';
import { unlockStaffUserByEmail } from '../backoffice/staff-auth';
import { createDb } from '../client';

const USAGE = 'usage: pnpm admin:unlock --email <email>';

const { values } = parseArgs({
  options: { email: { type: 'string' }, help: { type: 'boolean' } },
  strict: true,
});
if (values.help) {
  console.warn(USAGE);
  process.exit(0);
}
if (!values.email) {
  console.error(USAGE);
  process.exit(2);
}

loadDotEnv();
const config = loadConfig();
const handle = createDb(config.databaseUrl, { max: 1 });
try {
  const user = await unlockStaffUserByEmail(handle.db, {
    email: values.email,
    actor: { type: 'system', via: 'cli' },
    now: new Date(),
  });
  if (user === null) {
    console.error(`no staff account with the email ${values.email}`);
    process.exitCode = 1;
  } else {
    console.warn(`unlocked: ${user.email} (${user.role}, id ${user.id})`);
  }
} finally {
  await handle.close();
}
