import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError } from '../src/errors';
import {
  COLLECTION_ACCOUNT_AUDIT,
  DELETED_ACCOUNT_GRACE_MS,
  decideCollectionAccount,
  deleteCollectionAccount,
  editCollectionAccount,
  listCollectionAccounts,
  loadRailAccounts,
  requestCollectionAccount,
  seedCollectionAccounts,
} from '../src/payments/index';
import { OWNER_ALERT } from '../src/platform/index';
import { adminUsers, auditLog, collectionAccounts, outboxEvents } from '../src/schema/index';
import { createTestDatabase } from '../src/testing';
import { dropTestDatabase } from './helpers';
import { NOW } from './payments-fixtures';

/** The SMS rail's collection accounts, managed in the back office. */

type TestDb = Awaited<ReturnType<typeof createTestDatabase>>;
let handle: TestDb;
let admin: string;
let finance: string;
const ALERTS = { phones: ['+251911000099'] };
const NO_ALERTS = { phones: [] };

beforeAll(async () => {
  handle = await createTestDatabase();
  admin = await staff('admin');
  finance = await staff('finance');
});

afterAll(async () => {
  await dropTestDatabase(handle);
});

async function staff(role: 'admin' | 'finance'): Promise<string> {
  const [row] = await handle.db
    .insert(adminUsers)
    .values({
      email: `${role}-${randomUUID()}@example.com`,
      passwordHash: 'not-a-real-hash',
      displayName: `Test ${role}`,
      role,
    })
    .returning({ id: adminUsers.id });
  return row!.id;
}

async function refusal(promise: Promise<unknown>): Promise<{ status: number; code: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainError) return { status: error.status, code: error.code };
    throw error;
  }
  throw new Error('expected a refusal');
}

const request = (
  fields: { institution?: string; account: string; name?: string; hint?: string | null },
  options: { adminId?: string; legalName?: string | null } = {},
) =>
  handle.db.transaction((tx) =>
    requestCollectionAccount(tx, {
      institution: fields.institution ?? 'cbe',
      account: fields.account,
      name: fields.name ?? 'Nahubet Gaming PLC',
      hint: fields.hint ?? null,
      legalName: options.legalName ?? null,
      adminId: options.adminId ?? admin,
      now: NOW,
      ownerAlerts: ALERTS,
    }),
  );

const decide = (id: string, decision: 'approve' | 'reject', adminId = finance) =>
  handle.db.transaction((tx) =>
    decideCollectionAccount(tx, { id, decision, adminId, now: NOW, ownerAlerts: ALERTS }),
  );

const remove = (id: string, now = NOW) =>
  handle.db.transaction((tx) =>
    deleteCollectionAccount(tx, { id, adminId: admin, now, ownerAlerts: ALERTS }),
  );

const rail = (now = NOW) => loadRailAccounts(handle.db, now);
const ids = (accounts: readonly { id: string }[]) => accounts.map((a) => a.id);

describe('collection accounts', () => {
  it('the configured accounts fill an empty table once', async () => {
    const configured = [
      { id: 'telebirr:0911000001', institution: 'telebirr', account: '0911000001', name: 'Op' },
      { id: 'cbe-main', institution: 'cbe', account: '1000111122223', name: 'Op', hint: 'Bole' },
      // Not readable by the rail: left out.
      { id: 'nosuchbank:12345', institution: 'nosuchbank', account: '12345', name: 'Op' },
    ];
    expect(await handle.db.transaction((tx) => seedCollectionAccounts(tx, configured, NOW))).toBe(
      2,
    );
    // Once filled, the configuration no longer changes the list.
    expect(
      await handle.db.transaction((tx) =>
        seedCollectionAccounts(
          tx,
          [{ id: 'awash:0132', institution: 'awash', account: '01320000001', name: 'Op' }],
          NOW,
        ),
      ),
    ).toBe(0);
    const { active, known } = await rail();
    expect(ids(active)).toEqual(['telebirr:0911000001', 'cbe-main']);
    expect(active[1]).toEqual({
      id: 'cbe-main',
      institution: 'cbe',
      account: '1000111122223',
      name: 'Op',
      hint: 'Bole',
    });
    expect(ids(known)).toEqual(ids(active));
    const [audit] = await handle.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, COLLECTION_ACCOUNT_AUDIT.seeded));
    expect(audit).toMatchObject({ actorType: 'system' });
  });

  it('a new account is shown to players only once a second person approves it', async () => {
    const added = await request({ account: '1000 2222-3333 4', hint: 'Main branch' });
    expect(added).toMatchObject({
      status: 'pending',
      accountId: 'cbe:1000222233334',
      account: '1000222233334',
      hint: 'Main branch',
    });
    expect(ids((await rail()).active)).not.toContain('cbe:1000222233334');
    expect(ids((await rail()).known)).not.toContain('cbe:1000222233334');

    expect(await refusal(decide(added.id, 'approve', admin))).toEqual({
      status: 409,
      code: 'four_eyes',
    });
    const approved = await decide(added.id, 'approve');
    expect(approved).toMatchObject({ changed: true, account: { status: 'active' } });
    expect(ids((await rail()).active)).toContain('cbe:1000222233334');
    // The same decision again changes nothing; the other one is refused.
    expect((await decide(added.id, 'approve')).changed).toBe(false);
    expect(await refusal(decide(added.id, 'reject'))).toEqual({
      status: 409,
      code: 'collection_account_decided',
    });

    const alerts = await handle.db
      .select({ key: outboxEvents.aggregateId })
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.type, OWNER_ALERT),
          inArray(outboxEvents.aggregateId, [
            'collection_account_changed|cbe:1000222233334|requested',
            'collection_account_changed|cbe:1000222233334|approved',
          ]),
        ),
      );
    expect(alerts).toHaveLength(2);
    const listed = (await listCollectionAccounts(handle.db)).find((row) => row.id === added.id);
    expect(listed).toMatchObject({ createdByName: 'Test admin', decidedByName: 'Test finance' });
  });

  it('a rejected account is never shown; the number can be added again', async () => {
    const added = await request({ institution: 'telebirr', account: '0911000777' });
    expect((await decide(added.id, 'reject')).account.status).toBe('rejected');
    expect(ids((await rail()).known)).not.toContain('telebirr:0911000777');
    expect(await refusal(remove(added.id))).toEqual({
      status: 409,
      code: 'collection_account_closed',
    });
    expect((await request({ institution: 'telebirr', account: '0911000777' })).status).toBe(
      'pending',
    );
  });

  it('refuses an unknown institution, a bad number, a duplicate and a personal account', async () => {
    expect(await refusal(request({ institution: 'nosuchbank', account: '1234567' }))).toEqual({
      status: 400,
      code: 'unknown_institution',
    });
    expect(await refusal(request({ account: '12' }))).toEqual({
      status: 400,
      code: 'collection_account_number',
    });
    expect(await refusal(request({ account: '1000/2222' }))).toEqual({
      status: 400,
      code: 'collection_account_number',
    });
    // Listed already (seeded): by number, whatever its spacing.
    expect(await refusal(request({ account: '1000 1111 2222 3' }))).toEqual({
      status: 409,
      code: 'collection_account_exists',
    });
    // Licensed: the holder is the operator, spelled any way.
    expect(
      await refusal(
        request({ account: '1000333344445', name: 'Abebe Kebede' }, { legalName: 'Nahubet PLC' }),
      ),
    ).toEqual({ status: 400, code: 'collection_account_not_operator' });
    const ok = await request(
      { account: '1000333344445', name: 'nahubet,  plc' },
      { legalName: 'Nahubet PLC' },
    );
    expect(ok.name).toBe('nahubet, plc');
  });

  it('edits the name and hint, never the number; the licensed name stays the operator', async () => {
    const added = await request({ institution: 'awash', account: '01320000005' });
    await decide(added.id, 'approve');
    const edit = (fields: { name?: string; hint?: string | null }, legalName: string | null) =>
      handle.db.transaction((tx) =>
        editCollectionAccount(tx, {
          id: added.id,
          ...fields,
          legalName,
          adminId: admin,
          now: NOW,
          ownerAlerts: NO_ALERTS,
        }),
      );
    const edited = await edit({ hint: ' Use   reason: deposit ' }, null);
    expect(edited).toMatchObject({ changed: true, account: { hint: 'Use reason: deposit' } });
    expect((await edit({ hint: 'Use reason: deposit' }, null)).changed).toBe(false);
    expect(await refusal(edit({ name: 'Someone Else' }, 'Nahubet Gaming PLC'))).toEqual({
      status: 400,
      code: 'collection_account_not_operator',
    });
    expect((await edit({ hint: null }, null)).account.hint).toBeNull();
    const shown = (await rail()).active.find((a) => a.id === 'awash:01320000005');
    expect(shown).toEqual({
      id: 'awash:01320000005',
      institution: 'awash',
      account: '01320000005',
      name: 'Nahubet Gaming PLC',
    });
    const [audit] = await handle.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, COLLECTION_ACCOUNT_AUDIT.edited), eq(auditLog.targetId, added.id)),
      );
    expect(audit?.metadata).toMatchObject({
      before: { hint: null },
      after: { hint: 'Use reason: deposit' },
    });
  });

  it('a deleted account takes no new deposit but counts for SMS for a week', async () => {
    const added = await request({ institution: 'telebirr', account: '0911000555' });
    await decide(added.id, 'approve');
    const deleted = await remove(added.id);
    expect(deleted).toMatchObject({ changed: true, account: { status: 'deleted' } });
    expect((await remove(added.id)).changed).toBe(false);
    const { active, known } = await rail();
    expect(ids(active)).not.toContain('telebirr:0911000555');
    expect(ids(known)).toContain('telebirr:0911000555');
    const later = new Date(NOW.getTime() + DELETED_ACCOUNT_GRACE_MS + 1);
    expect(ids((await rail(later)).known)).not.toContain('telebirr:0911000555');

    // Added again (a new row with the same id): active once more, listed once.
    const again = await request({ institution: 'telebirr', account: '0911000555' });
    await decide(again.id, 'approve');
    const after = await rail();
    expect(ids(after.active).filter((id) => id === 'telebirr:0911000555')).toHaveLength(1);
    expect(ids(after.known).filter((id) => id === 'telebirr:0911000555')).toHaveLength(1);

    // A pending account deleted before approval was never shown, so it never counts.
    const withdrawn = await request({ institution: 'telebirr', account: '0911000556' });
    await remove(withdrawn.id);
    expect(ids((await rail()).known)).not.toContain('telebirr:0911000556');
  });

  it('the database keeps four eyes even past the service', async () => {
    const added = await request({ institution: 'dashen', account: '5000111122' });
    await expect(
      handle.db
        .update(collectionAccounts)
        .set({ status: 'active', decidedBy: admin, decidedAt: NOW })
        .where(eq(collectionAccounts.id, added.id)),
    ).rejects.toThrow();
  });
});
