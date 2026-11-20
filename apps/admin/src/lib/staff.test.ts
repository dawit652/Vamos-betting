import { describe, expect, it } from 'vitest';
import { filterStaff, groupSecret, isLocked, sortStaff, staffStatus } from './staff';

const now = new Date('2026-11-19T10:00:00Z');
const base = { disabledAt: null, lockedUntil: null };

describe('staffStatus', () => {
  it('is Active without a lock or a disable date', () => {
    expect(staffStatus(base, now)).toMatchObject({ label: 'Active', text: 'Active' });
  });

  it('is Locked while lockedUntil is in the future, Active once it has passed', () => {
    const future = { ...base, lockedUntil: '2026-11-19T10:15:00Z' };
    const past = { ...base, lockedUntil: '2026-11-19T09:59:00Z' };
    expect(staffStatus(future, now).label).toBe('Locked');
    expect(staffStatus(future, now).text).toMatch(/^Locked until /);
    expect(isLocked(past, now)).toBe(false);
    expect(staffStatus(past, now).label).toBe('Active');
  });

  it('Disabled wins over a lock and shows the date', () => {
    const both = { disabledAt: '2026-11-18T08:00:00Z', lockedUntil: '2026-11-19T10:15:00Z' };
    expect(staffStatus(both, now).label).toBe('Disabled');
    expect(staffStatus(both, now).text).toMatch(/^Disabled /);
  });
});

describe('groupSecret', () => {
  it('groups by four and keeps a short tail', () => {
    expect(groupSecret('OZQW233TFVSGK3LP')).toBe('OZQW 233T FVSG K3LP');
    expect(groupSecret('ABCDEFGHIJ')).toBe('ABCD EFGH IJ');
  });

  it('ignores spaces already present and handles empty', () => {
    expect(groupSecret('ABCD EFGH')).toBe('ABCD EFGH');
    expect(groupSecret('')).toBe('');
  });
});

describe('sortStaff and filterStaff', () => {
  const people = [
    { role: 'support', displayName: 'Zed', email: 'zed@x.test' },
    { role: 'admin', displayName: 'bob', email: 'bob@x.test' },
    { role: 'support', displayName: 'Amy', email: 'amy@x.test' },
    { role: 'admin', displayName: 'Alice', email: 'alice@x.test' },
  ];

  it('sorts by role (admin first), then name ignoring case', () => {
    expect(sortStaff(people).map((p) => p.displayName)).toEqual(['Alice', 'bob', 'Amy', 'Zed']);
    expect(people[0]!.displayName).toBe('Zed');
  });

  it('filters by role and by name or email text', () => {
    expect(filterStaff(people, 'support', '')).toHaveLength(2);
    expect(filterStaff(people, '', 'AMY')).toHaveLength(1);
    expect(filterStaff(people, '', 'x.test')).toHaveLength(4);
    expect(filterStaff(people, 'admin', 'zed')).toHaveLength(0);
  });
});
