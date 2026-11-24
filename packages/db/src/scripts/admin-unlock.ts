/**
 * Lifts the sign-in lockouts of a back-office staff account (out-of-band
 * recovery when no admin can sign in to do it from the back office).
 *
 *   pnpm admin:unlock --email ops@example.et [--account staff|agent_owner|cashier]
 *
 * One email may hold a back-office, an agent owner's and a cashier's account (GS8): `--account`
 * picks one (default the back-office account).
 *
 * Clears the account-wide delay and every address's lockout. Audited as
 * `staff.unlocked` (via cli). Uses DATABASE_URL from the environment / .env.
 */
import { parseArgs } from 'node:util';
import { loadConfig, loadDotEnv } from '@vamos/config';
import { unlockStaffUserByEmail, type StaffAccountKind } from '../backoffice/staff-auth';
import { createDb } from '../client';

const USAGE = 'usage: pnpm admin:unlock --email <email> [--account staff|agent_owner|cashier]';
const KINDS: readonly StaffAccountKind[] = ['staff', 'agent_owner', 'cashier'];

const { values } = parseArgs({
  options: { email: { type: 'string' }, account: { type: 'string' }, help: { type: 'boolean' } },
  strict: true,
});
if (values.help) {
  console.warn(USAGE);
  process.exit(0);
}
const kind = (values.account ?? 'staff') as StaffAccountKind;
if (!values.email || !KINDS.includes(kind)) {
  console.error(USAGE);
  process.exit(2);
}

loadDotEnv();
const config = loadConfig();
const handle = createDb(config.databaseUrl, { max: 1 });
try {
  const user = await unlockStaffUserByEmail(handle.db, {
    email: values.email,
    kind,
    actor: { type: 'system', via: 'cli' },
    now: new Date(),
  });
  if (user === null) {
    console.error(`no ${kind} account with the email ${values.email}`);
    process.exitCode = 1;
  } else {
    console.warn(`unlocked: ${user.email} (${user.role}, id ${user.id})`);
  }
} finally {
  await handle.close();
}
