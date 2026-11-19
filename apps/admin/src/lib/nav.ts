/**
 * The back office navigation. Each entry names the permission that shows it; the API enforces
 * the same permissions (the matrix lives in @vamos/contracts), so this is only about not
 * offering what a role cannot use.
 */
export interface NavItem {
  href: string;
  label: string;
  permission: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/', label: 'Dashboard', permission: 'dashboard.view' },
  { href: '/users', label: 'Players', permission: 'users.view' },
  { href: '/kyc', label: 'KYC queue', permission: 'kyc.review' },
  { href: '/trading', label: 'Trading', permission: 'trading.view' },
  { href: '/feed', label: 'Feed', permission: 'trading.view' },
  { href: '/risk', label: 'Risk', permission: 'risk.view' },
  { href: '/bets', label: 'Bets', permission: 'bets.view' },
  { href: '/withdrawals', label: 'Withdrawals', permission: 'withdrawals.view' },
  { href: '/manual-payouts', label: 'Manual payouts', permission: 'payouts.settle_manual' },
  { href: '/cashier', label: 'Cashier desk', permission: 'cashier.desk' },
  { href: '/cashier/shifts', label: 'Cash shifts', permission: 'cashier.reports' },
  { href: '/agents', label: 'Agents', permission: 'agents.view' },
  { href: '/sms', label: 'SMS rail', permission: 'sms.review' },
  { href: '/jackpots', label: 'Jackpots', permission: 'jackpots.view' },
  { href: '/compliance/reconciliation', label: 'Reconciliation', permission: 'reports.view' },
  { href: '/compliance/aml', label: 'AML flags', permission: 'aml.review' },
  { href: '/staff', label: 'Staff', permission: 'staff.manage' },
  { href: '/settings', label: 'Settings', permission: 'settings.view' },
  { href: '/channels', label: 'Channels', permission: 'settings.view' },
  { href: '/audit', label: 'Audit log', permission: 'audit.view' },
];

/** The entries a staff member with `permissions` sees. */
export function navFor(permissions: readonly string[]): NavItem[] {
  const held = new Set(permissions);
  return NAV_ITEMS.filter((item) => held.has(item.permission));
}

/** The permission a path needs (the longest matching nav entry); null for an unlisted path. */
export function permissionForPath(pathname: string): string | null {
  const matches = NAV_ITEMS.filter((item) =>
    item.href === '/'
      ? pathname === '/'
      : pathname === item.href || pathname.startsWith(`${item.href}/`),
  );
  matches.sort((a, b) => b.href.length - a.href.length);
  return matches[0]?.permission ?? null;
}

/** Whether `pathname` may be shown to someone holding `permissions`. */
export function canView(permissions: readonly string[], pathname: string): boolean {
  const needed = permissionForPath(pathname);
  return needed === null || permissions.includes(needed);
}

/** Where a staff member lands after sign-in: the first page they can see, else their account. */
export function homeFor(permissions: readonly string[]): string {
  return navFor(permissions)[0]?.href ?? '/account';
}
