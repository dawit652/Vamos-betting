import { STAFF_ROLES, type StaffUserView } from '@vamos/contracts';
import { formatDateTime } from './format';

export interface StaffStatus {
  label: 'Active' | 'Disabled' | 'Locked';
  /** Label with the date or time, as the table shows it. */
  text: string;
  tone: 'good' | 'warn' | 'bad';
}

/** Whether the account is locked at `now` (a lock in the past has ended). */
export function isLocked(user: Pick<StaffUserView, 'lockedUntil'>, now: Date): boolean {
  return user.lockedUntil !== null && new Date(user.lockedUntil).getTime() > now.getTime();
}

/** Disabled wins over locked: a disabled account cannot sign in either way. */
export function staffStatus(
  user: Pick<StaffUserView, 'disabledAt' | 'lockedUntil'>,
  now: Date,
): StaffStatus {
  if (user.disabledAt !== null) {
    return {
      label: 'Disabled',
      text: `Disabled ${formatDateTime(user.disabledAt)}`,
      tone: 'bad',
    };
  }
  if (isLocked(user, now)) {
    return {
      label: 'Locked',
      text: `Locked until ${formatDateTime(user.lockedUntil)}`,
      tone: 'warn',
    };
  }
  return { label: 'Active', text: 'Active', tone: 'good' };
}

/** A secret in groups of four characters, so it is easy to type from a screen. */
export function groupSecret(secret: string): string {
  return (secret.replace(/\s+/g, '').match(/.{1,4}/g) ?? []).join(' ');
}

/** Role order of the contract (admin first), then name, then email. */
export function sortStaff<T extends { role: string; displayName: string; email: string }>(
  users: readonly T[],
): T[] {
  const rank = (role: string) => {
    const index = (STAFF_ROLES as readonly string[]).indexOf(role);
    return index < 0 ? STAFF_ROLES.length : index;
  };
  return [...users].sort(
    (a, b) =>
      rank(a.role) - rank(b.role) ||
      a.displayName.localeCompare(b.displayName, 'en', { sensitivity: 'base' }) ||
      a.email.localeCompare(b.email),
  );
}

/** Keeps the accounts of `role` (all when empty) whose name or email contains `text`. */
export function filterStaff<T extends { role: string; displayName: string; email: string }>(
  users: readonly T[],
  role: string,
  text: string,
): T[] {
  const needle = text.trim().toLowerCase();
  return users.filter(
    (u) =>
      (role === '' || u.role === role) &&
      (needle === '' ||
        u.displayName.toLowerCase().includes(needle) ||
        u.email.toLowerCase().includes(needle)),
  );
}
