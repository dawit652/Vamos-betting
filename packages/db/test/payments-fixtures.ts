import { randomUUID } from 'node:crypto';
import { DEFAULT_PAYMENT_RULES, type PaymentRules } from '@vamos/core';
import { MockPaymentProvider, mockDepositRef } from '@vamos/payments';
import { and, count, eq, sql } from 'drizzle-orm';
import {
  applyDepositEvent,
  createDepositIntent,
  DomainError,
  getBalance,
  markDepositInitiated,
  openPayoutTotal,
  requestWithdrawal,
  type AccountRef,
  type PaymentIntent,
  type RequestWithdrawalResult,
} from '../src/index';
import type { Database } from '../src/client';
import { auditLog, kycProfiles, ledgerAccounts, outboxEvents, users } from '../src/schema/index';
import { cash } from './helpers';

export const NOW = new Date('2026-10-10T09:00:00Z');
export const MOCK_SECRET = 'payments-test-mock-webhook-secret';

/** The demo provider, on a fixed clock (signed webhooks verify at NOW). */
export function mockProvider(now: { value: Date } = { value: NOW }): MockPaymentProvider {
  return new MockPaymentProvider({ webhookSecret: MOCK_SECRET, clock: () => now.value });
}

/** Payment rules for tests: the defaults, with wagering off unless a test is about it. */
export function rules(overrides: Partial<PaymentRules> = {}): PaymentRules {
  return { ...DEFAULT_PAYMENT_RULES, wageringMultiplierBps: 0, ...overrides };
}

let phoneCounter = 0;

/**
 * An active player with a unique Ethiopian mobile number. `suffix` sets the
 * last four digits (the mock provider fails payouts to …0000 and keeps
 * …9999 pending until queried).
 */
export async function createPlayer(
  db: Database,
  options: { suffix?: string; kyc?: 'verified' | 'pending' | 'none'; name?: string | null } = {},
): Promise<{ userId: string; phone: string }> {
  phoneCounter += 1;
  const head = String(phoneCounter).padStart(4, '0');
  const tail = options.suffix ?? String(1000 + (phoneCounter % 8000)).padStart(4, '0');
  const phone = `+2519${head}${tail}`;
  const [row] = await db
    .insert(users)
    .values({
      phone,
      passwordHash: 'not-a-real-hash',
      dateOfBirth: '1990-01-01',
      status: 'active',
      termsAcceptedAt: new Date(),
    })
    .returning({ id: users.id });
  const userId = row!.id;
  const kyc = options.kyc ?? 'verified';
  if (kyc !== 'none') {
    await db.insert(kycProfiles).values({
      userId,
      status: kyc,
      provider: 'mock',
      verifiedName: options.name === undefined ? 'Abebe Kebede' : options.name,
    });
  }
  return { userId, phone };
}

let keyCounter = 0;
export function idemKey(prefix = 'key'): string {
  keyCounter += 1;
  return `${prefix}-${keyCounter}-${randomUUID().slice(0, 8)}`;
}

/**
 * A deposit through the mock provider, end to end in the DB: intent,
 * initiation, then the signed webhook the dev phone simulator sends
 * (verified by the provider) applied to it.
 */
export async function depositViaMock(
  db: Database,
  userId: string,
  amount: bigint,
  options: { now?: Date; provider?: MockPaymentProvider } = {},
): Promise<PaymentIntent> {
  const now = options.now ?? NOW;
  const provider = options.provider ?? mockProvider();
  const { intent } = await db.transaction((tx) =>
    createDepositIntent(tx, {
      userId,
      provider: 'mock',
      amount,
      idempotencyKey: idemKey('dep'),
      now,
      rules: rules(),
    }),
  );
  const initiation = await provider.initiateDeposit({
    intentId: intent.id,
    amount,
    phone: intent.phone,
    callbackUrl: 'http://localhost:4000/payments/webhooks/mock',
    returnUrl: 'http://localhost:3000/wallet',
  });
  await db.transaction((tx) => markDepositInitiated(tx, { intentId: intent.id, initiation, now }));
  const event = await provider.verifyWebhook(
    provider.simulateDepositDecision({
      providerRef: mockDepositRef(intent.id),
      amount,
      decision: 'approve',
      pin: '1234',
    }),
  );
  const result = await db.transaction((tx) =>
    applyDepositEvent(tx, { provider: 'mock', event, now }),
  );
  if (result.outcome !== 'credited') throw new Error(`deposit not credited: ${result.outcome}`);
  return result.intent;
}

/** requestWithdrawal in its own transaction, to the player's own phone via mock. */
export async function withdraw(
  db: Database,
  player: { userId: string; phone: string },
  amount: bigint,
  options: { key?: string; now?: Date; rules?: PaymentRules; phone?: string } = {},
): Promise<RequestWithdrawalResult> {
  return db.transaction((tx) =>
    requestWithdrawal(tx, {
      userId: player.userId,
      amount,
      phone: options.phone ?? player.phone,
      provider: 'mock',
      idempotencyKey: options.key ?? idemKey('wd'),
      now: options.now ?? NOW,
      rules: options.rules ?? rules(),
    }),
  );
}

export async function domainError(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
}

export const PENDING: AccountRef = { kind: 'house_withdrawals_pending' };
export const psp = (provider = 'mock'): AccountRef => ({ kind: 'house_psp_clearing', provider });

export async function cashOf(db: Database, userId: string): Promise<bigint> {
  return getBalance(db, cash(userId));
}

/** Outbox rows of one aggregate, oldest first, as [type, payload]. */
export async function outboxOf(db: Database, aggregateId: string) {
  const rows = await db
    .select({ type: outboxEvents.type, payload: outboxEvents.payload })
    .from(outboxEvents)
    .where(eq(outboxEvents.aggregateId, aggregateId))
    .orderBy(outboxEvents.id);
  return rows.map((r) => [r.type, r.payload] as const);
}

export async function auditCount(db: Database, targetId: string, action?: string) {
  const [row] = await db
    .select({ n: count() })
    .from(auditLog)
    .where(and(eq(auditLog.targetId, targetId), action ? eq(auditLog.action, action) : undefined));
  return row?.n ?? 0;
}

/**
 * The books balance: every account sums to zero, and the withdrawal hold
 * account equals the open payouts.
 */
export async function expectBooksBalanced(db: Database): Promise<void> {
  const [row] = await db
    .select({ total: sql<string>`COALESCE(SUM(${ledgerAccounts.balance}), 0)::text` })
    .from(ledgerAccounts);
  if (BigInt(row?.total ?? '0') !== 0n) throw new Error(`ledger total is ${row?.total}`);
  const held = await getBalance(db, PENDING);
  const open = await openPayoutTotal(db);
  if (held !== open) throw new Error(`withdrawals pending ${held} != open payouts ${open}`);
}
