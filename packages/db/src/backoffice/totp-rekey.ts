import { isNotNull, or, eq } from 'drizzle-orm';
import type { Database } from '../client';
import { writeAudit } from '../platform/audit';
import { adminUsers } from '../schema/accounts';
import { decryptTotpSecret, encryptTotpSecret, TotpSecretError } from './secret-box';

export interface TotpRekeyResult {
  /** Secrets (current and pending enrolments) re-encrypted under the new key. */
  rekeyed: number;
  /** Secrets already under the new key: a run repeated after it succeeded. */
  alreadyNew: number;
}

/**
 * Re-encrypts every stored staff TOTP secret, the current ones and the
 * pending enrolments, from `oldKey` to `newKey` when ADMIN_TOTP_KEY is
 * rotated, so nobody has to re-enrol (ASVS 1.6.3; the CLI is
 * `admin:totp-rekey`, docs/runbooks/rotating-secrets.md).
 *
 * One transaction with the rows locked: every secret moves or none does. A
 * secret that decrypts with neither key aborts the run (TotpSecretError naming
 * the account), so nothing is left half rotated. Audited as
 * `staff.totp_rekeyed` with the counts, never a secret.
 */
export async function rekeyStaffTotpSecrets(
  db: Database,
  input: {
    oldKey: Buffer;
    newKey: Buffer;
    via: string;
    randomBytes?: (size: number) => Buffer;
  },
): Promise<TotpRekeyResult> {
  if (input.oldKey.equals(input.newKey)) {
    throw new RangeError('the old and the new TOTP key are the same');
  }
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: adminUsers.id,
        current: adminUsers.totpSecretEnc,
        pending: adminUsers.totpPendingSecretEnc,
      })
      .from(adminUsers)
      .where(or(isNotNull(adminUsers.totpSecretEnc), isNotNull(adminUsers.totpPendingSecretEnc)))
      .orderBy(adminUsers.id)
      .for('update');

    const result: TotpRekeyResult = { rekeyed: 0, alreadyNew: 0 };
    const move = (stored: string | null, adminUserId: string): string | null => {
      if (stored === null) return null;
      try {
        const secret = decryptTotpSecret(input.oldKey, stored, adminUserId);
        result.rekeyed += 1;
        return encryptTotpSecret(input.newKey, secret, adminUserId, input.randomBytes);
      } catch (error) {
        if (!(error instanceof TotpSecretError)) throw error;
      }
      try {
        decryptTotpSecret(input.newKey, stored, adminUserId);
      } catch {
        throw new TotpSecretError(
          `the TOTP secret of staff account ${adminUserId} decrypts with neither key; nothing was changed`,
        );
      }
      result.alreadyNew += 1;
      return stored;
    };

    for (const row of rows) {
      const current = move(row.current, row.id);
      const pending = move(row.pending, row.id);
      if (current === row.current && pending === row.pending) continue;
      await tx
        .update(adminUsers)
        .set({ totpSecretEnc: current, totpPendingSecretEnc: pending })
        .where(eq(adminUsers.id, row.id));
    }
    await writeAudit(tx, {
      actorType: 'system',
      action: 'staff.totp_rekeyed',
      targetType: 'admin_user',
      metadata: { ...result, via: input.via },
    });
    return result;
  });
}
