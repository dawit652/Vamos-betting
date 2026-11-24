import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import type { Database } from '../client';
import { writeAudit } from '../platform/audit';
import { getDatabaseOperatingMode } from '../platform/operating-mode';
import { adminUsers } from '../schema/accounts';
import {
  DEMO_STAFF_ACCOUNTS,
  DEMO_STAFF_PASSWORD,
  DEMO_STAFF_TOTP_SECRET,
} from './demo-staff-accounts';
import { encryptTotpSecret } from './secret-box';
import type { PasswordHasher } from './staff-auth';
import { base32Decode } from './totp';

export {
  DEMO_STAFF_ACCOUNTS,
  DEMO_STAFF_PASSWORD,
  DEMO_STAFF_TOTP_SECRET,
  type DemoStaffAccount,
} from './demo-staff-accounts';

export interface SeedDemoStaffResult {
  /** Accounts inserted by this run (existing ones are left as they are). */
  created: number;
  /** Why nothing was seeded, or null. */
  skipped: 'licensed' | 'production' | null;
}

/**
 * DEMO ONLY: creates the DEMO_STAFF_ACCOUNTS that do not exist yet, with
 * DEMO_STAFF_PASSWORD and DEMO_STAFF_TOTP_SECRET (encrypted with the
 * configured ADMIN_TOTP_KEY). Does nothing in licensed mode (the configured
 * mode or the database's), or with NODE_ENV=production (a public demo must
 * not have published back-office credentials). Accounts that exist keep
 * their password, secret and role. Audited as `staff.created` (via seed).
 */
export async function seedDemoStaff(
  deps: { db: Database; clock: () => Date; totpKey: Buffer; passwords: PasswordHasher },
  options: { mode: 'demo' | 'licensed'; nodeEnv: 'development' | 'test' | 'production' },
): Promise<SeedDemoStaffResult> {
  if (options.mode !== 'demo') return { created: 0, skipped: 'licensed' };
  if (options.nodeEnv === 'production') return { created: 0, skipped: 'production' };
  const secret = base32Decode(DEMO_STAFF_TOTP_SECRET);
  const passwordHash = await deps.passwords.hash(DEMO_STAFF_PASSWORD);
  const now = deps.clock();
  return deps.db.transaction(async (tx) => {
    if ((await getDatabaseOperatingMode(tx)) === 'licensed') {
      return { created: 0, skipped: 'licensed' as const };
    }
    const existing = await tx
      .select({ email: adminUsers.email })
      .from(adminUsers)
      .where(
        inArray(
          adminUsers.email,
          DEMO_STAFF_ACCOUNTS.map((account) => account.email),
        ),
      );
    const known = new Set(existing.map((row) => row.email));
    let created = 0;
    for (const account of DEMO_STAFF_ACCOUNTS) {
      if (known.has(account.email)) continue;
      const id = randomUUID();
      const rows = await tx
        .insert(adminUsers)
        .values({
          id,
          email: account.email,
          passwordHash,
          displayName: account.displayName,
          role: account.role,
          totpSecretEnc: encryptTotpSecret(deps.totpKey, secret, id),
          totpEnrolledAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: adminUsers.id });
      if (rows.length === 0) continue;
      created += 1;
      await writeAudit(tx, {
        actorType: 'system',
        action: 'staff.created',
        targetType: 'admin_user',
        targetId: id,
        metadata: { email: account.email, role: account.role, via: 'demo-seed' },
      });
    }
    return { created, skipped: null };
  });
}
