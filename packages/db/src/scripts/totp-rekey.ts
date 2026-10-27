/**
 * Re-encrypts the staff TOTP secrets after ADMIN_TOTP_KEY is rotated, so
 * nobody has to re-enrol (docs/runbooks/rotating-secrets.md):
 *
 *   ADMIN_TOTP_KEY_PREVIOUS=<old key> ADMIN_TOTP_KEY=<new key> pnpm admin:totp-rekey
 *
 * Both keys are 32 bytes written as 64 hex characters or base64. Every secret
 * moves in one transaction or none does; a repeated run changes nothing.
 * Audited as `staff.totp_rekeyed` (via cli). Uses DATABASE_URL from the
 * environment / .env.
 */
import { loadConfig, loadDotEnv, parseAdminTotpKey } from '@vamos/config';
import { TotpSecretError } from '../backoffice/secret-box';
import { rekeyStaffTotpSecrets } from '../backoffice/totp-rekey';
import { createDb } from '../client';

loadDotEnv();
const previous = process.env.ADMIN_TOTP_KEY_PREVIOUS;
const oldKey = previous === undefined ? null : parseAdminTotpKey(previous);
if (oldKey === null) {
  console.error(
    'set ADMIN_TOTP_KEY_PREVIOUS to the old key (32 bytes as 64 hex characters or base64) and ADMIN_TOTP_KEY to the new one',
  );
  process.exit(2);
}
const config = loadConfig();
const handle = createDb(config.databaseUrl, { max: 1 });
try {
  const result = await rekeyStaffTotpSecrets(handle.db, {
    oldKey,
    newKey: config.admin.totpKey,
    via: 'cli',
  });
  console.warn(
    `re-encrypted ${result.rekeyed} TOTP secret(s) under the new key; ${result.alreadyNew} already used it`,
  );
} catch (error) {
  if (!(error instanceof TotpSecretError) && !(error instanceof RangeError)) throw error;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await handle.close();
}
