import { normalizeLegalName, type CollectionAccount, type OwnerAlertTargets } from '@vamos/config';
import { institutionById } from '@vamos/core';
import { and, desc, eq, gt, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { isUniqueViolation } from '../catalog/errors';
import type { Database } from '../client';
import { domainBadRequest, domainConflict, domainNotFound } from '../errors';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { writeAudit } from '../platform/audit';
import { enqueueOwnerAlert } from '../platform/owner-alerts';
import { adminUsers } from '../schema/accounts';
import { collectionAccounts } from '../schema/smsrail';

/**
 * The SMS rail's collection accounts, managed in the back office (docs/runbooks/sms-rail.md):
 *
 * - an admin adds one (`pending`), a second person approves it (`active`: players are shown it) or
 *   rejects it. A new account sends player money somewhere new, so one person never does both;
 * - its institution and number never change (deposits, SMS and the handset's forwarder name it by
 *   `account_id`): a new number is a new account, and the old one is deleted;
 * - the holder name and hint can be edited; in licensed mode the name stays the operator's legal
 *   name (personal accounts are not allowed);
 * - deleting stops new deposits on it at once; SMS, receipts and open deposits on it still count
 *   for DELETED_ACCOUNT_GRACE_MS, so money already sent there is still credited;
 * - SMS_COLLECTION_ACCOUNTS fills an empty table once; after that the table is the list.
 *
 * Every change is audited and, when owner alerts are configured, texted to the owner.
 */

export type CollectionAccountRecord = typeof collectionAccounts.$inferSelect;
export type CollectionAccountStatus = CollectionAccountRecord['status'];

export const COLLECTION_ACCOUNT_AUDIT = {
  seeded: 'collection_account.seeded',
  requested: 'collection_account.requested',
  approved: 'collection_account.approved',
  rejected: 'collection_account.rejected',
  edited: 'collection_account.edited',
  deleted: 'collection_account.deleted',
} as const;

/** How long a deleted account still counts for SMS, receipts and its open deposits. */
export const DELETED_ACCOUNT_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

const ACCOUNT_RE = /^\+?[0-9A-Za-z]{5,30}$/;
const NAME_MAX = 120;
const HINT_MAX = 120;

const clean = (text: string) => text.replace(/\s+/g, ' ').trim();

/** A number as it is stored: spaces and dashes dropped ("1000 1234-5678" is "100012345678"). */
export function normalizeCollectionAccountNumber(account: string): string {
  return account.replace(/[\s-]+/g, '');
}

function checkInstitution(institution: string): void {
  if (institutionById(institution) === null) {
    throw domainBadRequest(
      'unknown_institution',
      'The SMS rail cannot read messages from this bank or wallet yet.',
    );
  }
}

function checkName(name: string, legalName: string | null): string {
  const value = clean(name);
  if (value.length < 2 || value.length > NAME_MAX) {
    throw domainBadRequest(
      'collection_account_name',
      `The holder name has 2 to ${NAME_MAX} characters.`,
    );
  }
  const legal = normalizeLegalName(legalName ?? '');
  if (legal.length > 0 && normalizeLegalName(value) !== legal) {
    throw domainBadRequest(
      'collection_account_not_operator',
      'A collection account must be in the operator’s legal name: personal accounts are not allowed.',
      { legalName: clean(legalName ?? '') },
    );
  }
  return value;
}

function checkHint(hint: string | null | undefined): string | null {
  const value = clean(hint ?? '');
  if (value.length > HINT_MAX) {
    throw domainBadRequest(
      'collection_account_hint',
      `The hint has at most ${HINT_MAX} characters.`,
    );
  }
  return value.length === 0 ? null : value;
}

function railView(row: CollectionAccountRecord): CollectionAccount {
  return {
    id: row.accountId,
    institution: row.institution,
    account: row.account,
    name: row.name,
    ...(row.hint === null ? {} : { hint: row.hint }),
  };
}

const auditOf = (row: CollectionAccountRecord) => ({
  accountId: row.accountId,
  institution: row.institution,
  account: row.account,
  name: row.name,
  hint: row.hint,
  status: row.status,
});

async function lockAccount(tx: DbTransaction, id: string): Promise<CollectionAccountRecord> {
  const [row] = await tx
    .select()
    .from(collectionAccounts)
    .where(eq(collectionAccounts.id, id))
    .for('update');
  if (!row) throw domainNotFound('Collection account');
  return row;
}

const closed = (row: CollectionAccountRecord) =>
  domainConflict('collection_account_closed', 'This account was rejected or deleted.', {
    status: row.status,
  });

/**
 * Fills an empty table with the configured accounts (SMS_COLLECTION_ACCOUNTS, or the demo ones of
 * the simulated rail), as active accounts nobody added. Once the table has any row, even a deleted
 * one, it does nothing. Concurrent starts wait on one lock, so the accounts go in once. Returns
 * how many went in.
 */
export async function seedCollectionAccounts(
  tx: DbTransaction,
  accounts: readonly CollectionAccount[],
  now: Date,
): Promise<number> {
  if (accounts.length === 0) return 0;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('collection_accounts_seed'))`);
  const [existing] = await tx
    .select({ id: collectionAccounts.id })
    .from(collectionAccounts)
    .limit(1);
  if (existing) return 0;
  const added: string[] = [];
  for (const [index, account] of accounts.entries()) {
    if (institutionById(account.institution) === null) continue;
    const rows = await tx
      .insert(collectionAccounts)
      .values({
        accountId: account.id,
        institution: account.institution,
        account: account.account,
        name: account.name,
        hint: account.hint ?? null,
        status: 'active',
        // A millisecond apart: the list keeps the configured order (the first is the default).
        createdAt: new Date(now.getTime() + index),
      })
      .onConflictDoNothing()
      .returning({ accountId: collectionAccounts.accountId });
    for (const row of rows) added.push(row.accountId);
  }
  if (added.length > 0) {
    await writeAudit(tx, {
      actorType: 'system',
      action: COLLECTION_ACCOUNT_AUDIT.seeded,
      targetType: 'collection_account',
      metadata: { accounts: added, source: 'SMS_COLLECTION_ACCOUNTS' },
    });
  }
  return added.length;
}

/**
 * The accounts as the rail uses them: `active` ones are offered to new deposits; `known` ones are
 * those plus the accounts deleted less than DELETED_ACCOUNT_GRACE_MS ago that players were shown
 * (SMS, receipts and open deposits on them still count). Oldest first.
 */
export async function loadRailAccounts(
  exec: DbExecutor,
  now: Date,
): Promise<{ active: CollectionAccount[]; known: CollectionAccount[] }> {
  const since = new Date(now.getTime() - DELETED_ACCOUNT_GRACE_MS);
  const rows = await exec
    .select()
    .from(collectionAccounts)
    .where(
      or(
        eq(collectionAccounts.status, 'active'),
        and(
          eq(collectionAccounts.status, 'deleted'),
          gt(collectionAccounts.deletedAt, since),
          // Deleted while active (approved, or filled from the configuration), not while pending.
          or(isNull(collectionAccounts.createdBy), isNotNull(collectionAccounts.decidedAt)),
        ),
      ),
    )
    .orderBy(collectionAccounts.createdAt, collectionAccounts.id);
  const active = rows.filter((row) => row.status === 'active').map(railView);
  const known = [...active];
  for (const row of rows) {
    if (row.status === 'deleted' && !known.some((k) => k.id === row.accountId)) {
      known.push(railView(row));
    }
  }
  return { active, known };
}

/** What takes the list: the SMS rail provider (@vamos/payments SmsRailProvider). */
export interface RailAccountsSink {
  readonly configuredAccounts: readonly CollectionAccount[];
  setCollectionAccounts(set: {
    active: readonly CollectionAccount[];
    known: readonly CollectionAccount[];
  }): void;
}

const seededSinks = new WeakSet<RailAccountsSink>();

/**
 * Loads the back office's list into the rail; the first call of a process fills an empty table
 * with the rail's configured accounts. The API calls it before it listens, every few seconds
 * (another process may have changed the list) and after each change; the worker on its own timer.
 */
export async function syncRailAccounts(
  db: Database,
  sink: RailAccountsSink,
  now: Date,
): Promise<void> {
  if (!seededSinks.has(sink)) {
    await db.transaction((tx) => seedCollectionAccounts(tx, sink.configuredAccounts, now));
    seededSinks.add(sink);
  }
  sink.setCollectionAccounts(await loadRailAccounts(db, now));
}

export type CollectionAccountRow = CollectionAccountRecord & {
  createdByName: string | null;
  decidedByName: string | null;
};

/** Every account (or the one `id`), newest first, with who added and who decided it. */
export async function listCollectionAccounts(
  exec: DbExecutor,
  filter: { id?: string } = {},
): Promise<CollectionAccountRow[]> {
  const creator = alias(adminUsers, 'collection_account_creator');
  const decider = alias(adminUsers, 'collection_account_decider');
  const rows = await exec
    .select({
      account: collectionAccounts,
      createdByName: creator.displayName,
      decidedByName: decider.displayName,
    })
    .from(collectionAccounts)
    .leftJoin(creator, eq(creator.id, collectionAccounts.createdBy))
    .leftJoin(decider, eq(decider.id, collectionAccounts.decidedBy))
    .where(filter.id === undefined ? undefined : eq(collectionAccounts.id, filter.id))
    .orderBy(desc(collectionAccounts.createdAt), desc(collectionAccounts.id));
  return rows.map((row) => ({
    ...row.account,
    createdByName: row.createdByName ?? null,
    decidedByName: row.decidedByName ?? null,
  }));
}

interface ChangeContext {
  adminId: string;
  now: Date;
  ip?: string | null;
  /** OWNER_ALERT_*: the owner is texted each change (nothing while none is configured). */
  ownerAlerts: OwnerAlertTargets;
}

/**
 * Adds an account waiting for a second person's approval. The institution must have an SMS parser
 * (400 `unknown_institution`); the number is stored without spaces or dashes (400
 * `collection_account_number`); with `legalName` (licensed, live rail) the holder name must be it
 * (400 `collection_account_not_operator`). One live row per account: 409
 * `collection_account_exists`.
 */
export async function requestCollectionAccount(
  tx: DbTransaction,
  input: ChangeContext & {
    institution: string;
    account: string;
    name: string;
    hint?: string | null;
    /** OPERATOR_LEGAL_NAME when the holder name must be it (licensed, live rail); else null. */
    legalName: string | null;
  },
): Promise<CollectionAccountRecord> {
  const institution = input.institution.trim();
  checkInstitution(institution);
  const account = normalizeCollectionAccountNumber(input.account);
  if (!ACCOUNT_RE.test(account)) {
    throw domainBadRequest(
      'collection_account_number',
      'The account number has 5 to 30 letters or digits (a leading + is allowed).',
    );
  }
  const name = checkName(input.name, input.legalName);
  const hint = checkHint(input.hint);
  let row: CollectionAccountRecord | undefined;
  try {
    [row] = await tx.transaction((sp) =>
      sp
        .insert(collectionAccounts)
        .values({
          accountId: `${institution}:${account}`,
          institution,
          account,
          name,
          hint,
          status: 'pending',
          createdBy: input.adminId,
          createdAt: input.now,
        })
        .returning(),
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw domainConflict(
        'collection_account_exists',
        'This account is listed already (or waits for approval).',
      );
    }
    throw error;
  }
  if (!row) throw new Error('collection account insert returned no row');
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.adminId,
    action: COLLECTION_ACCOUNT_AUDIT.requested,
    targetType: 'collection_account',
    targetId: row.id,
    metadata: auditOf(row),
    ip: input.ip ?? null,
  });
  await enqueueOwnerAlert(
    tx,
    input.ownerAlerts,
    { alarm: 'collection_account_changed', account: row.accountId, change: 'requested' },
    input.now,
  );
  return row;
}

/**
 * Approves (players are shown it from now on) or rejects an account waiting for approval. Four
 * eyes: 409 `four_eyes` for the person who added it (the database refuses it too). The same
 * decision again changes nothing; another is 409 `collection_account_decided`.
 */
export async function decideCollectionAccount(
  tx: DbTransaction,
  input: ChangeContext & { id: string; decision: 'approve' | 'reject' },
): Promise<{ account: CollectionAccountRecord; changed: boolean }> {
  const current = await lockAccount(tx, input.id);
  const target = input.decision === 'approve' ? 'active' : 'rejected';
  if (current.status !== 'pending') {
    if (current.status === target) return { account: current, changed: false };
    throw domainConflict('collection_account_decided', 'This account was decided already.', {
      status: current.status,
    });
  }
  if (current.createdBy === input.adminId) {
    throw domainConflict('four_eyes', 'Another person must approve or reject what you added.');
  }
  const [account] = await tx
    .update(collectionAccounts)
    .set({ status: target, decidedBy: input.adminId, decidedAt: input.now })
    .where(and(eq(collectionAccounts.id, current.id), eq(collectionAccounts.status, 'pending')))
    .returning();
  if (!account) throw new Error('collection account update returned no row');
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.adminId,
    action:
      input.decision === 'approve'
        ? COLLECTION_ACCOUNT_AUDIT.approved
        : COLLECTION_ACCOUNT_AUDIT.rejected,
    targetType: 'collection_account',
    targetId: account.id,
    metadata: auditOf(account),
    ip: input.ip ?? null,
  });
  if (input.decision === 'approve') {
    await enqueueOwnerAlert(
      tx,
      input.ownerAlerts,
      { alarm: 'collection_account_changed', account: account.accountId, change: 'approved' },
      input.now,
    );
  }
  return { account, changed: true };
}

/**
 * Changes the holder name and/or hint of a pending or active account (409
 * `collection_account_closed` otherwise); its institution and number never change. With
 * `legalName` the name must stay the operator's. No change changes nothing.
 */
export async function editCollectionAccount(
  tx: DbTransaction,
  input: ChangeContext & {
    id: string;
    name?: string;
    hint?: string | null;
    legalName: string | null;
  },
): Promise<{ account: CollectionAccountRecord; changed: boolean }> {
  const current = await lockAccount(tx, input.id);
  if (current.status !== 'pending' && current.status !== 'active') throw closed(current);
  const name = input.name === undefined ? current.name : checkName(input.name, input.legalName);
  const hint = input.hint === undefined ? current.hint : checkHint(input.hint);
  if (name === current.name && hint === current.hint) return { account: current, changed: false };
  const [account] = await tx
    .update(collectionAccounts)
    .set({ name, hint, updatedBy: input.adminId, updatedAt: input.now })
    .where(eq(collectionAccounts.id, current.id))
    .returning();
  if (!account) throw new Error('collection account update returned no row');
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.adminId,
    action: COLLECTION_ACCOUNT_AUDIT.edited,
    targetType: 'collection_account',
    targetId: account.id,
    metadata: {
      accountId: account.accountId,
      before: { name: current.name, hint: current.hint },
      after: { name: account.name, hint: account.hint },
    },
    ip: input.ip ?? null,
  });
  if (account.status === 'active') {
    await enqueueOwnerAlert(
      tx,
      input.ownerAlerts,
      { alarm: 'collection_account_changed', account: account.accountId, change: 'edited' },
      input.now,
    );
  }
  return { account, changed: true };
}

/**
 * Deletes a pending or active account: it is offered to no new deposit from now on, while SMS,
 * receipts and open deposits on it still count for DELETED_ACCOUNT_GRACE_MS. The row stays (the
 * history). Deleting again changes nothing; a rejected one is 409 `collection_account_closed`.
 */
export async function deleteCollectionAccount(
  tx: DbTransaction,
  input: ChangeContext & { id: string },
): Promise<{ account: CollectionAccountRecord; changed: boolean }> {
  const current = await lockAccount(tx, input.id);
  if (current.status === 'deleted') return { account: current, changed: false };
  if (current.status !== 'pending' && current.status !== 'active') throw closed(current);
  const [account] = await tx
    .update(collectionAccounts)
    .set({ status: 'deleted', deletedBy: input.adminId, deletedAt: input.now })
    .where(eq(collectionAccounts.id, current.id))
    .returning();
  if (!account) throw new Error('collection account update returned no row');
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.adminId,
    action: COLLECTION_ACCOUNT_AUDIT.deleted,
    targetType: 'collection_account',
    targetId: account.id,
    metadata: { ...auditOf(account), was: current.status },
    ip: input.ip ?? null,
  });
  if (current.status === 'active') {
    await enqueueOwnerAlert(
      tx,
      input.ownerAlerts,
      { alarm: 'collection_account_changed', account: account.accountId, change: 'deleted' },
      input.now,
    );
  }
  return { account, changed: true };
}
