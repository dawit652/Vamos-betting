import { birr, businessDateOf } from '@vamos/core';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BALANCE_AFTER_CURSOR,
  BALANCE_AFTER_FULL_SCAN_CURSOR,
  BALANCE_AFTER_FULL_SCAN_EVERY_MS,
  failReconciliationRequest,
  getReconciliationRequest,
  RECONCILIATION_REQUESTED,
  requestReconciliation,
  runReconciliation,
  runReconciliationChecks,
  runRequestedReconciliation,
} from '../src/index';
import {
  auditLog,
  complianceCursors,
  ledgerAccounts,
  ledgerEntries,
  outboxEvents,
  reconciliationRequests,
} from '../src/schema/index';
import { createBettingDatabase, type TestDb } from './betting-fixtures';
import { dropTestDatabase } from './helpers';
import { createPlayer, depositViaMock, domainError } from './payments-fixtures';

/**
 * Phase 12: "Run now" reconciliations run in the worker (a request row, an
 * outbox event, then runRequestedReconciliation), and the balance_after
 * continuity check is incremental from a verified checkpoint, with a full
 * scan weekly.
 */

let handle: TestDb;
const ADMIN = { adminId: '0f0e0d0c-0b0a-4908-8706-050403020100', ip: '196.188.0.9' };
let playerId: string;

beforeAll(async () => {
  ({ handle } = await createBettingDatabase());
  const player = await createPlayer(handle.db);
  playerId = player.userId;
  await depositViaMock(handle.db, player.userId, birr(500));
});

afterAll(async () => {
  await dropTestDatabase(handle);
});

const balanceAfter = (checks: Array<{ check: string; ok: boolean; checked: number }>) =>
  checks.find((check) => check.check === 'balance_after');

async function cursor(name: string): Promise<bigint | null> {
  const [row] = await handle.db
    .select({ position: complianceCursors.position })
    .from(complianceCursors)
    .where(eq(complianceCursors.name, name));
  return row?.position ?? null;
}

describe('requested reconciliation (Run now off the request path)', () => {
  it('queues one request at a time and the worker runs it under the request id', async () => {
    const now = new Date();
    const request = await requestReconciliation(handle.db, { now, actor: ADMIN });
    expect(request).toMatchObject({
      status: 'queued',
      businessDate: businessDateOf(now),
      requestedBy: ADMIN.adminId,
      ip: ADMIN.ip,
      attempts: 0,
      runId: null,
    });
    const events = await handle.db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.type, RECONCILIATION_REQUESTED),
          eq(outboxEvents.aggregateId, request.id),
        ),
      );
    expect(events.map((event) => event.payload)).toEqual([
      { requestId: request.id, businessDate: businessDateOf(now) },
    ]);

    // A second request while this one is open: 409.
    const busy = await domainError(requestReconciliation(handle.db, { now, actor: ADMIN }));
    expect(busy).toMatchObject({ status: 409, code: 'reconciliation_running' });

    const result = await runRequestedReconciliation(handle.db, {
      requestId: request.id,
      now: new Date(),
    });
    expect(result.ran).toBe(true);
    if (!result.ran) return;
    expect(result.run).toMatchObject({
      id: request.id,
      kind: 'manual',
      status: 'clean',
      triggeredBy: ADMIN.adminId,
      businessDate: businessDateOf(now),
    });
    expect(result.request).toMatchObject({ status: 'done', runId: request.id, attempts: 1 });
    expect(await getReconciliationRequest(handle.db, request.id)).toMatchObject({
      status: 'done',
    });
    const audits = await handle.db
      .select({ action: auditLog.action, targetId: auditLog.targetId })
      .from(auditLog)
      .where(eq(auditLog.targetId, request.id))
      .orderBy(asc(auditLog.id));
    expect(audits.map((row) => row.action)).toEqual([
      'reconciliation.requested',
      'reconciliation.run',
    ]);

    // A replayed job does nothing; the next request may start.
    expect(
      await runRequestedReconciliation(handle.db, { requestId: request.id, now: new Date() }),
    ).toMatchObject({ ran: false, reason: 'finished' });
    expect(
      await runRequestedReconciliation(handle.db, {
        requestId: '00000000-0000-4000-8000-000000000000',
        now: new Date(),
      }),
    ).toMatchObject({ ran: false, reason: 'not_found', request: null });
    // The database refuses to reopen a finished request.
    await expect(
      handle.db
        .update(reconciliationRequests)
        .set({ status: 'running' })
        .where(eq(reconciliationRequests.id, request.id)),
    ).rejects.toThrow();
  });

  it('fails a lost request when staff ask again later, and a request whose job gave up', async () => {
    const now = new Date();
    const lost = await requestReconciliation(handle.db, { now, actor: ADMIN });
    const later = new Date(now.getTime() + 60_000);
    // Not stale yet: 409.
    expect(
      await domainError(requestReconciliation(handle.db, { now: later, actor: ADMIN })),
    ).toMatchObject({ status: 409 });
    const next = await requestReconciliation(handle.db, {
      now: later,
      actor: ADMIN,
      staleAfterMs: 30_000,
    });
    expect(await getReconciliationRequest(handle.db, lost.id)).toMatchObject({
      status: 'failed',
      runId: null,
    });
    // The lost request's job, if it ever runs, does nothing.
    expect(
      await runRequestedReconciliation(handle.db, { requestId: lost.id, now: later }),
    ).toMatchObject({ ran: false, reason: 'finished' });

    await failReconciliationRequest(handle.db, {
      requestId: next.id,
      now: later,
      error: 'job failed for good',
    });
    expect(await getReconciliationRequest(handle.db, next.id)).toMatchObject({
      status: 'failed',
      error: 'job failed for good',
    });
    const bad = await domainError(
      requestReconciliation(handle.db, { now, actor: ADMIN, businessDate: '2026-02-30' }),
    );
    expect(bad).toMatchObject({ status: 400, code: 'invalid_business_date' });
  });
});

describe('incremental balance_after check', () => {
  it('reads only the entries after the checkpoint and finds a break there', async () => {
    const businessDate = businessDateOf(new Date());
    const [{ total } = { total: 0 }] = await handle.db
      .select({ total: sql<number>`count(*)::int` })
      .from(ledgerEntries);
    const full = await handle.db.transaction((tx) =>
      runReconciliationChecks(tx, { businessDate, balanceAfterGraceMs: 0 }),
    );
    expect(full.balanceAfter.scope).toBe('full');
    expect(balanceAfter(full.checks)).toMatchObject({ ok: true, checked: total });
    const checkpoint = full.balanceAfter.checkpoint;
    expect(checkpoint).not.toBeNull();

    const nothingNew = await handle.db.transaction((tx) =>
      runReconciliationChecks(tx, {
        businessDate,
        balanceAfterFrom: checkpoint,
        balanceAfterGraceMs: 0,
      }),
    );
    expect(nothingNew.balanceAfter).toEqual({ scope: 'incremental', checkpoint });
    expect(balanceAfter(nothingNew.checks)).toMatchObject({ ok: true, checked: 0 });

    // Two new deposits, then the first one's balance_after is corrupted (triggers off).
    await depositViaMock(handle.db, playerId, birr(30));
    await depositViaMock(handle.db, playerId, birr(40));
    const [account] = await handle.db
      .select({ id: ledgerAccounts.id })
      .from(ledgerAccounts)
      .where(eq(ledgerAccounts.key, `user:${playerId}:cash`));
    const recent = await handle.db
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.accountId, account!.id))
      .orderBy(asc(ledgerEntries.id));
    const broken = recent.at(-2)!.id;
    const corrupt = (delta: number) =>
      handle.db.transaction(async (tx) => {
        await tx.execute(
          sql`ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_append_only`,
        );
        await tx.execute(
          sql`UPDATE ledger_entries SET balance_after = balance_after + ${delta} WHERE id = ${broken}`,
        );
        await tx.execute(sql`ALTER TABLE ledger_entries ENABLE TRIGGER ledger_entries_append_only`);
      });
    // The clean "Run now" above was a full scan (with the default grace: no checkpoint yet).
    const lastFull = await cursor(BALANCE_AFTER_FULL_SCAN_CURSOR);
    expect(lastFull).not.toBeNull();
    expect(await cursor(BALANCE_AFTER_CURSOR)).toBeNull();
    await corrupt(7);
    try {
      const found = await handle.db.transaction((tx) =>
        runReconciliationChecks(tx, {
          businessDate,
          balanceAfterFrom: checkpoint,
          balanceAfterGraceMs: 0,
        }),
      );
      // The broken entry and the next one of that account (whose previous is now off).
      expect(balanceAfter(found.checks)).toMatchObject({ ok: false, mismatches: 2 });
      expect(
        found.mismatches.filter((m) => m.check === 'balance_after').map((m) => m.subjectId),
      ).toContain(broken.toString());
      expect(found.balanceAfter.checkpoint! > checkpoint!).toBe(true);

      // Through runReconciliation: a full scan first (no checkpoint yet), and the checkpoint
      // does not move past a break, so the next (incremental) run reports it again.
      const first = await runReconciliation(handle.db, {
        now: new Date(),
        balanceAfterGraceMs: 0,
      });
      expect(first.run.status).toBe('mismatches');
      expect(balanceAfter(first.run.checks)).toMatchObject({ ok: false, mismatches: 2 });
      expect(await cursor(BALANCE_AFTER_CURSOR)).toBeNull();
      expect(await cursor(BALANCE_AFTER_FULL_SCAN_CURSOR)).toBe(lastFull);
    } finally {
      await corrupt(-7);
    }

    const clean = await runReconciliation(handle.db, { now: new Date(), balanceAfterGraceMs: 0 });
    expect(clean.run.status).toBe('clean');
    const verified = await cursor(BALANCE_AFTER_CURSOR);
    expect(verified).not.toBeNull();
    expect((await cursor(BALANCE_AFTER_FULL_SCAN_CURSOR))! > lastFull!).toBe(true);

    // The next run is incremental: it reads only what was written since.
    await depositViaMock(handle.db, playerId, birr(25));
    const incremental = await runReconciliation(handle.db, {
      now: new Date(),
      balanceAfterGraceMs: 0,
    });
    expect(incremental.run.status).toBe('clean');
    // A mock deposit posts two entries (PSP clearing and the player's cash).
    expect(balanceAfter(incremental.run.checks)?.checked).toBe(2);
    expect((await cursor(BALANCE_AFTER_CURSOR))! > verified!).toBe(true);

    // A week later the scan is full again.
    const weekLater = new Date(Date.now() + BALANCE_AFTER_FULL_SCAN_EVERY_MS);
    const weekly = await runReconciliation(handle.db, { now: weekLater, balanceAfterGraceMs: 0 });
    const [{ all } = { all: 0 }] = await handle.db
      .select({ all: sql<number>`count(*)::int` })
      .from(ledgerEntries);
    expect(balanceAfter(weekly.run.checks)?.checked).toBe(all);

    // With the default grace, entries written in the last 30 minutes stay behind the checkpoint.
    const graced = await handle.db.transaction((tx) =>
      runReconciliationChecks(tx, { businessDate }),
    );
    expect(graced.balanceAfter.checkpoint).toBeNull();
  });
});
