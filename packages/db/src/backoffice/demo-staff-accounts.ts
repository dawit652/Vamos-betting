/**
 * DEMO ONLY: the back-office accounts `pnpm db:seed` creates in demo mode
 * outside production (seedDemoStaff), one per role, all with the same
 * published password and TOTP secret so local development and the e2e
 * suite can sign in. They are never created in licensed mode or with
 * NODE_ENV=production.
 *
 * This module has no imports, so e2e can use it (`@vamos/db/demo-staff`)
 * together with `@vamos/db/totp` to compute the sign-in code:
 *   totpCode(base32Decode(DEMO_STAFF_TOTP_SECRET), Date.now())
 * A code is accepted once per account and 30-second step (replay guard):
 * a second sign-in of the same account within the same step needs the next code.
 */

/** Password of every demo staff account. */
export const DEMO_STAFF_PASSWORD = 'vamos-demo-staff';

/** Base32 TOTP secret of every demo staff account (SHA-1, 6 digits, 30 s). */
export const DEMO_STAFF_TOTP_SECRET = 'OZQW233TFVSGK3LPFVZXIYLGMYWW65DQ';

export interface DemoStaffAccount {
  email: string;
  role: 'admin' | 'trader' | 'finance' | 'kyc' | 'support' | 'compliance' | 'cashier';
  displayName: string;
}

/** One demo account per staff role. */
export const DEMO_STAFF_ACCOUNTS: readonly DemoStaffAccount[] = [
  { email: 'admin@demo.vamos.test', role: 'admin', displayName: 'Demo Admin' },
  { email: 'trader@demo.vamos.test', role: 'trader', displayName: 'Demo Trader' },
  { email: 'finance@demo.vamos.test', role: 'finance', displayName: 'Demo Finance' },
  { email: 'kyc@demo.vamos.test', role: 'kyc', displayName: 'Demo KYC' },
  { email: 'support@demo.vamos.test', role: 'support', displayName: 'Demo Support' },
  { email: 'compliance@demo.vamos.test', role: 'compliance', displayName: 'Demo Compliance' },
  { email: 'cashier@demo.vamos.test', role: 'cashier', displayName: 'Demo Cashier' },
];
