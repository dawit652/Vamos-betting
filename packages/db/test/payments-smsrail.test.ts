import { birr, MAX_SANTIM_OFFSET, santimToBirrString, type PaymentRules } from '@vamos/core';
import { count, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acknowledgeReceiptAlarm,
  addPayoutAccount,
  approveWithdrawal,
  cancelWithdrawal,
  checkSmsDepositForPlayer,
  claimDuePayouts,
  claimManualPayout,
  closeSmsByStaff,
  createSmsDepositIntent,
  creditSmsByStaff,
  ensureOwnWalletPayoutAccount,
  expireStaleDepositIntents,
  failManualPayout,
  getBalance,
  getDepositIntent,
  getPayout,
  ingestSms,
  listBalanceObservations,
  listManualPayoutQueue,
  listSmsDueForReceiptCheck,
  listSmsReviewQueue,
  markPayoutPaid,
  MAX_PAYOUT_ACCOUNTS,
  recordReceiptCheck,
  recordReceiptPaymentForPlayer,
  releaseManualPayout,
  removePayoutAccount,
  requestWithdrawal,
  resolveFlaggedDeposit,
  settleManualPayout,
  SMS_AMOUNT_QUARANTINE_MS,
  smsRailHealth,
  verifyPayoutAccount,
  withdrawalPaidLedgerKey,
  type PaymentIntent,
} from '../src/index';
import type { Database } from '../src/client';
import {
  ledgerEntries,
  ledgerTransactions,
  paymentIntents,
  payouts,
  receivedSms,
  users,
} from '../src/schema/index';
import { createTestDatabase } from '../src/testing';
import { dropTestDatabase, pgCode } from './helpers';
import {
  cashOf,
  createPlayer,
  domainError,
  expectBooksBalanced,
  idemKey,
  NOW,
  outboxOf,
  PENDING,
  psp,
  rules,
} from './payments-fixtures';

let handle: Awaited<ReturnType<typeof createTestDatabase>>;
let db: Database;
beforeAll(async () => {
  handle = await createTestDatabase();
  db = handle.db;
});
afterAll(async () => {
  await dropTestDatabase(handle);
});

const MINUTE = 60_000;
const at = (minutes: number) => new Date(NOW.getTime() + minutes * MINUTE);

let refCounter = 0;
function nextRef(prefix = 'CA'): string {
  refCounter += 1;
  return `${prefix}${String(refCounter).padStart(8, '0')}`;
}

/** A telebirr credit confirmation as the collection SIM receives it. */
function telebirrCredit(
  amount: bigint,
  options: { phone?: string | null; ref?: string; balance?: bigint } = {},
) {
  const reference = options.ref ?? nextRef();
  const from =
    options.phone === null
      ? 'SENDER NAME'
      : `SENDER NAME (${(options.phone ?? '+251911000000').slice(1)})`;
  const balance =
    options.balance === undefined
      ? ''
      : ` Your telebirr balance is ETB ${santimToBirrString(options.balance)}.`;
  return {
    reference,
    text: `Dear CUSTOMER, you have received ETB ${santimToBirrString(amount)} from ${from} on 10/10/2026 at 12:01:00 PM. Your transaction number is ${reference}.${balance}`,
  };
}

/**
 * A telebirr debit confirmation (money leaving the collection account); `toPhone` null for the
 * sparse variant without the recipient's number, `time` the institution's time (EAT).
 */
function telebirrDebit(
  amount: bigint,
  toPhone: string | null,
  ref = nextRef('CB'),
  time = '1:00:00 PM',
) {
  const to = toPhone === null ? 'RECIPIENT' : `RECIPIENT (${toPhone.slice(1)})`;
  return {
    reference: ref,
    text: `Dear CUSTOMER, you have transferred ETB ${santimToBirrString(amount)} to ${to} on 10/10/2026 at ${time}. Your transaction number is ${ref}.`,
  };
}

async function openDeposit(
  userId: string,
  amount: bigint,
  options: { now?: Date; key?: string; offset?: number; rules?: PaymentRules } = {},
): Promise<PaymentIntent> {
  const { intent } = await db.transaction((tx) =>
    createSmsDepositIntent(tx, {
      userId,
      amount,
      idempotencyKey: options.key ?? idemKey('sms'),
      now: options.now ?? NOW,
      rules: options.rules ?? rules(),
      ...(options.offset === undefined ? {} : { randomOffset: () => options.offset! }),
    }),
  );
  return intent;
}

async function gateway(
  text: string,
  options: { now?: Date; sender?: string; deviceReceivedAt?: Date } = {},
) {
  return db.transaction((tx) =>
    ingestSms(tx, {
      source: 'gateway',
      sender: options.sender ?? 'telebirr',
      text,
      now: options.now ?? at(1),
      ...(options.deviceReceivedAt === undefined
        ? {}
        : { deviceReceivedAt: options.deviceReceivedAt }),
    }),
  );
}

/** A credited SMS deposit of `amount` (requested) for the player, returns the exact amount. */
async function depositViaSms(
  player: { userId: string; phone: string },
  amount: bigint,
): Promise<bigint> {
  const intent = await openDeposit(player.userId, amount);
  const result = await gateway(telebirrCredit(intent.amount, { phone: player.phone }).text);
  expect(result.outcome).toBe('credited');
  return intent.amount;
}

describe('SMS deposit intents', () => {
  it('reserves an exact amount 1–99 santim above the request and opens it as a transfer', async () => {
    const player = await createPlayer(db);
    const intent = await openDeposit(player.userId, birr(100), { offset: 37 });
    expect(intent).toMatchObject({
      provider: 'sms',
      status: 'pending',
      amount: birr(100) + 37n,
      requestedAmount: birr(100),
      initiationKind: 'transfer',
      providerRef: intent.id,
    });
  });

  it('replays an idempotency key and refuses it for another amount', async () => {
    const player = await createPlayer(db);
    const key = idemKey('replay');
    const first = await openDeposit(player.userId, birr(80), { key });
    const again = await openDeposit(player.userId, birr(80), { key });
    expect(again.id).toBe(first.id);
    expect((await domainError(openDeposit(player.userId, birr(81), { key }))).code).toBe(
      'idempotency_key_reused',
    );
  });

  it('checks the deposit range against the requested amount', async () => {
    const player = await createPlayer(db);
    const r = rules({ minDeposit: birr(10), maxDeposit: birr(50) });
    expect((await openDeposit(player.userId, birr(50), { rules: r })).amount).toBeGreaterThan(
      birr(50),
    );
    expect((await domainError(openDeposit(player.userId, birr(51), { rules: r }))).code).toBe(
      'deposit_amount_out_of_range',
    );
  });

  it('never hands out the same exact amount twice, even concurrently, and refuses the 100th', async () => {
    const base = birr(333);
    const players = await Promise.all(
      Array.from({ length: MAX_SANTIM_OFFSET }, () => createPlayer(db)),
    );
    const intents = await Promise.all(players.map((p) => openDeposit(p.userId, base)));
    const amounts = new Set(intents.map((i) => i.amount));
    expect(amounts.size).toBe(99);
    for (const amount of amounts) {
      expect(amount > base && amount <= base + 99n).toBe(true);
    }
    const late = await createPlayer(db);
    expect((await domainError(openDeposit(late.userId, base))).code).toBe('sms_amount_unavailable');
  });

  it('never reserves a whole-birr amount for a request that is not a whole birr', async () => {
    const player = await createPlayer(db);
    // 555.01 + 99 santim would be 556.00, which anyone might send by chance: the next one is taken.
    const intent = await openDeposit(player.userId, birr(555) + 1n, { offset: 99 });
    expect(intent.amount).toBe(birr(555) + 2n);
  });

  it('serialises allocations across overlapping bases (444.00 and 444.25 share 444.26–444.50)', async () => {
    const [first, second] = await Promise.all([createPlayer(db), createPlayer(db)]);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let opened!: () => void;
    const firstOpened = new Promise<void>((resolve) => (opened = resolve));
    // The first allocation (444.30) stays uncommitted while the second, on another base, picks
    // 444.30 too (offset 5 from 444.25): it must wait and take the next free amount, not collide.
    const one = db.transaction(async (tx) => {
      const { intent } = await createSmsDepositIntent(tx, {
        userId: first.userId,
        amount: birr(444),
        idempotencyKey: idemKey('overlap'),
        now: NOW,
        rules: rules(),
        randomOffset: () => 30,
      });
      opened();
      await held;
      return intent;
    });
    await firstOpened;
    const two = openDeposit(second.userId, birr(444) + 25n, { offset: 5 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    const [a, b] = await Promise.all([one, two]);
    expect(a.amount).toBe(birr(444) + 30n);
    expect(b.amount).toBe(birr(444) + 31n);
  });
});

describe('gateway SMS', () => {
  it('credits the exact amount from the player’s phone, once, however often it is forwarded', async () => {
    const player = await createPlayer(db);
    const intent = await openDeposit(player.userId, birr(100));
    const sms = telebirrCredit(intent.amount, { phone: player.phone });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => gateway(sms.text).catch((e: unknown) => e)),
    );
    const outcomes = results.map((r) =>
      r instanceof Error ? 'error' : (r as { outcome: string }).outcome,
    );
    expect(outcomes.filter((o) => o === 'credited')).toHaveLength(1);
    expect(outcomes.every((o) => o === 'credited' || o === 'duplicate')).toBe(true);
    expect(await cashOf(db, player.userId)).toBe(intent.amount);
    const credited = await getDepositIntent(db, intent.id);
    expect(credited?.status).toBe('succeeded');
    expect((await outboxOf(db, intent.id)).map(([type]) => type)).toContain(
      'payment.deposit_succeeded',
    );
    const [row] = await db
      .select()
      .from(receivedSms)
      .where(eq(receivedSms.reference, sms.reference));
    expect(row).toMatchObject({
      status: 'matched',
      matchedIntentId: intent.id,
      matchedUserId: player.userId,
    });
    await expectBooksBalanced(db);
  });

  it('treats the same reference with another sender label as the same message', async () => {
    const player = await createPlayer(db);
    const intent = await openDeposit(player.userId, birr(101));
    const sms = telebirrCredit(intent.amount, { phone: player.phone });
    expect((await gateway(sms.text)).outcome).toBe('credited');
    expect((await gateway(sms.text, { sender: '127' })).outcome).toBe('duplicate');
    expect(await cashOf(db, player.userId)).toBe(intent.amount);
  });

  it('never credits an outgoing transfer, whatever its amount', async () => {
    const player = await createPlayer(db);
    const intent = await openDeposit(player.userId, birr(102));
    const result = await gateway(telebirrDebit(intent.amount, player.phone).text);
    expect(result.outcome).toBe('ignored_debit');
    expect(await cashOf(db, player.userId)).toBe(0n);
  });

  it('keeps unparsed messages for review and drops their retries', async () => {
    const text = `Unrecognised confirmation ${nextRef()}`;
    expect((await gateway(text)).outcome).toBe('unparsed');
    expect((await gateway(text)).outcome).toBe('duplicate');
    const queue = await listSmsReviewQueue(db);
    expect(queue.some((row) => row.rawText === text && row.status === 'unparsed')).toBe(true);
  });

  it("telebirr's live Amharic credit: a masked payer number that fits credits, another is flagged", async () => {
    /** The shape telebirr sends (22 Nov 2026), with the payer's number masked like "2519****3670". */
    const amharicCredit = (amount: bigint, maskedPayer: string) =>
      `ውድ CUSTOMER\nከ sender name(${maskedPayer}) ${santimToBirrString(amount)} ብር በ 10/10/2026 12:01:00 ተቀብለዋል። የሂሳብ እንቅስቃሴ ቁጥርዎ ${nextRef()} ነዉ። አሁን ያለዎት ቀሪ ሂሳብ 1,234.56 ብር ነዉ። በቴሌብር ስለተገለገሉ እናመሰግናለን ኢትዮ ቴሌኮም`;
    const mask = (phone: string) => `${phone.slice(1, 5)}****${phone.slice(-4)}`;

    const own = await createPlayer(db);
    const ownDeposit = await openDeposit(own.userId, birr(104));
    const credited = await gateway(amharicCredit(ownDeposit.amount, mask(own.phone)), {
      sender: '127',
    });
    expect(credited.outcome).toBe('credited');
    expect(await cashOf(db, own.userId)).toBe(ownDeposit.amount);

    const other = await createPlayer(db);
    const otherDeposit = await openDeposit(other.userId, birr(105));
    const stranger = `${other.phone.slice(1, 5)}****${other.phone.slice(-4) === '0000' ? '1111' : '0000'}`;
    const flagged = await gateway(amharicCredit(otherDeposit.amount, stranger), { sender: '127' });
    expect(flagged.outcome).toBe('flagged');
    expect(await cashOf(db, other.userId)).toBe(0n);
    expect((await getDepositIntent(db, otherDeposit.id))?.flagReason).toBe('third_party_payer');
  });

  it('flags a payment from someone else’s phone instead of crediting it', async () => {
    const player = await createPlayer(db);
    const intent = await openDeposit(player.userId, birr(103));
    const result = await gateway(telebirrCredit(intent.amount, { phone: '+251977777777' }).text);
    expect(result.outcome).toBe('flagged');
    expect(await cashOf(db, player.userId)).toBe(0n);
    const flagged = await getDepositIntent(db, intent.id);
    expect(flagged?.flagReason).toBe('third_party_payer');
    // Resolved from the SMS queue only, so the SMS and the deposit stay in step.
    const error = await domainError(
      db.transaction((tx) =>
        resolveFlaggedDeposit(tx, {
          intentId: intent.id,
          adminId: 'staff-1',
          resolution: 'credit',
          note: 'ok',
          now: at(5),
        }),
      ),
    );
    expect(error.code).toBe('sms_deposit_flag');

    const credited = await db.transaction((tx) =>
      creditSmsByStaff(tx, {
        smsId: result.sms.id,
        userId: player.userId,
        adminId: 'staff-1',
        note: 'spouse paid, confirmed by phone',
        now: at(5),
      }),
    );
    expect(credited.sms.status).toBe('credited_by_staff');
    expect(await cashOf(db, player.userId)).toBe(intent.amount);
    expect((await getDepositIntent(db, intent.id))?.status).toBe('failed');
    expect((await getDepositIntent(db, intent.id))?.flaggedAt).toBeNull();
    // Crediting twice is refused.
    expect(
      (
        await domainError(
          db.transaction((tx) =>
            creditSmsByStaff(tx, {
              smsId: result.sms.id,
              userId: player.userId,
              adminId: 'staff-1',
              note: 'again',
              now: at(6),
            }),
          ),
        )
      ).code,
    ).toBe('sms_not_creditable');
    await expectBooksBalanced(db);
  });

  it('flags a round amount from the player’s phone and lets staff credit what arrived', async () => {
    const player = await createPlayer(db);
    const intent = await openDeposit(player.userId, birr(104));
    const result = await gateway(telebirrCredit(birr(104), { phone: player.phone }).text);
    expect(result.outcome).toBe('flagged');
    expect((await getDepositIntent(db, intent.id))?.flagReason).toBe('amount_mismatch');
    await db.transaction((tx) =>
      creditSmsByStaff(tx, {
        smsId: result.sms.id,
        userId: player.userId,
        adminId: 'staff-1',
        note: 'sent the round amount',
        now: at(5),
      }),
    );
    expect(await cashOf(db, player.userId)).toBe(birr(104));
    await expectBooksBalanced(db);
  });

  it('leaves a payment with no open deposit for review; staff may close it', async () => {
    const result = await gateway(telebirrCredit(birr(9999) + 7n, { phone: null }).text);
    expect(result.outcome).toBe('unmatched');
    const closed = await db.transaction((tx) =>
      closeSmsByStaff(tx, {
        smsId: result.sms.id,
        adminId: 'staff-1',
        note: 'refunded to sender',
        now: at(5),
      }),
    );
    expect(closed.status).toBe('closed');
    expect((await listSmsReviewQueue(db)).some((row) => row.id === result.sms.id)).toBe(false);
  });

  it('still credits a late payment within the quarantine and keeps its amount reserved', async () => {
    const player = await createPlayer(db);
    const intent = await openDeposit(player.userId, birr(105), { offset: 10 });
    const afterExpiry = new Date(intent.expiresAt.getTime() + MINUTE);
    await db.transaction((tx) => expireStaleDepositIntents(tx, { now: afterExpiry }));
    expect((await getDepositIntent(db, intent.id))?.status).toBe('expired');

    // While reserved, nobody else is handed that amount.
    const other = await createPlayer(db);
    const next = await openDeposit(other.userId, birr(105), { offset: 10, now: afterExpiry });
    expect(next.amount).not.toBe(intent.amount);

    const late = await gateway(telebirrCredit(intent.amount, { phone: player.phone }).text, {
      now: afterExpiry,
    });
    expect(late.outcome).toBe('credited');
    expect(await cashOf(db, player.userId)).toBe(intent.amount);
  });

  it('does not match an expired deposit after the quarantine', async () => {
    const player = await createPlayer(db);
    const intent = await openDeposit(player.userId, birr(106));
    const muchLater = new Date(intent.expiresAt.getTime() + SMS_AMOUNT_QUARANTINE_MS + MINUTE);
    await db.transaction((tx) => expireStaleDepositIntents(tx, { now: muchLater }));
    const result = await gateway(telebirrCredit(intent.amount, { phone: player.phone }).text, {
      now: muchLater,
    });
    expect(result.outcome).toBe('unmatched');
  });

  it('never pays a deposit opened after the money moved (a backlog forwarded hours late)', async () => {
    // The handset was offline: a payment made at 12:01 EAT for a deposit whose amount has since
    // been released reaches us at 15:20, when a newer deposit was handed the same exact amount.
    const [payer, newcomer] = await Promise.all([createPlayer(db), createPlayer(db)]);
    const old = await openDeposit(payer.userId, birr(777), { offset: 7 });
    const released = at(200);
    await db.transaction((tx) => expireStaleDepositIntents(tx, { now: released }));
    const fresh = await openDeposit(newcomer.userId, birr(777), { offset: 7, now: released });
    expect(fresh.amount).toBe(old.amount);
    const backlog = telebirrCredit(old.amount, { phone: null }); // "on 10/10/2026 at 12:01:00 PM"
    const result = await gateway(backlog.text, { now: at(201) });
    expect(result.outcome).toBe('unmatched');
    expect(await cashOf(db, newcomer.userId)).toBe(0n);

    // A date-only message (CBE) is bounded by the handset's receive time instead.
    const cbe = await gateway(
      `Dear Customer, You have received ETB ${santimToBirrString(fresh.amount)} from SENDER NAME on 10/10/2026. Ref No CBEBACKLOG1`,
      { now: at(202), sender: 'CBE', deviceReceivedAt: at(2) },
    );
    expect(cbe.outcome).toBe('unmatched');
    expect(await cashOf(db, newcomer.userId)).toBe(0n);
    // The newcomer's own payment, made after their deposit opened (15:23 EAT), still credits.
    const own = await gateway(
      `Dear CUSTOMER, you have received ETB ${santimToBirrString(fresh.amount)} from SENDER NAME (${newcomer.phone.slice(1)}) on 10/10/2026 at 3:23:00 PM. Your transaction number is OWNPAY0001.`,
      { now: at(203), deviceReceivedAt: at(203) },
    );
    expect(own.outcome).toBe('credited');
    expect(await cashOf(db, newcomer.userId)).toBe(fresh.amount);
  });

  it('sends a second payment for an already credited deposit to review', async () => {
    const player = await createPlayer(db);
    const intent = await openDeposit(player.userId, birr(107));
    expect(
      (await gateway(telebirrCredit(intent.amount, { phone: player.phone }).text)).outcome,
    ).toBe('credited');
    const second = await gateway(telebirrCredit(intent.amount, { phone: player.phone }).text);
    expect(second.outcome).toBe('unmatched');
    expect(await cashOf(db, player.userId)).toBe(intent.amount);
  });
});

describe('the player check', () => {
  it('reports a credited SMS to its owner only', async () => {
    const player = await createPlayer(db);
    const intent = await openDeposit(player.userId, birr(110));
    const sms = telebirrCredit(intent.amount, { phone: player.phone });
    await gateway(sms.text);
    const own = await db.transaction((tx) =>
      checkSmsDepositForPlayer(tx, { userId: player.userId, text: sms.text, now: at(2) }),
    );
    expect(own.status).toBe('already_credited');
    const stranger = await createPlayer(db);
    const other = await db.transaction((tx) =>
      checkSmsDepositForPlayer(tx, { userId: stranger.userId, text: sms.reference, now: at(2) }),
    );
    expect(other.status).toBe('not_found');
  });

  it('never credits someone else’s unmatched payment to the paster', async () => {
    const victimPayment = telebirrCredit(birr(111) + 3n, { phone: null });
    expect((await gateway(victimPayment.text)).outcome).toBe('unmatched');
    const thief = await createPlayer(db);
    // The offset is pinned: a random one is 3 santim once in 99 runs, and then the deposit (opened
    // before the SMS's time) has the payment's exact amount, which by the rail's own rule is a
    // genuine match. This test is about a deposit of another amount.
    await openDeposit(thief.userId, birr(111), { offset: 7 });
    const result = await db.transaction((tx) =>
      checkSmsDepositForPlayer(tx, {
        userId: thief.userId,
        text: victimPayment.reference,
        now: at(3),
      }),
    );
    expect(result.status).not.toBe('credited');
    expect(await cashOf(db, thief.userId)).toBe(0n);
  });

  it('only matches deposits that existed when the SMS arrived', async () => {
    const payment = telebirrCredit(birr(112) + 9n, { phone: null });
    expect((await gateway(payment.text, { now: at(1) })).outcome).toBe('unmatched');
    const player = await createPlayer(db);
    const intent = await openDeposit(player.userId, birr(112), { offset: 9, now: at(10) });
    expect(intent.amount).toBe(birr(112) + 9n);
    const result = await db.transaction((tx) =>
      checkSmsDepositForPlayer(tx, { userId: player.userId, text: payment.reference, now: at(11) }),
    );
    expect(result.status).toBe('in_review');
    expect(await cashOf(db, player.userId)).toBe(0n);
  });

  it('credits a receipt the institution confirmed when the handset never forwarded it', async () => {
    const player = await createPlayer(db);
    const intent = await openDeposit(player.userId, birr(113), { now: at(0) });
    const reference = nextRef();
    const receipt = {
      institution: 'telebirr',
      reference,
      amount: intent.amount,
      payerName: 'Abebe Kebede',
      payerPhone: player.phone,
      receiver: '0911000000',
      paidAt: at(2),
      raw: '<html>receipt</html>',
    };
    const result = await db.transaction((tx) =>
      recordReceiptPaymentForPlayer(tx, { userId: player.userId, receipt, now: at(3) }),
    );
    expect(result.status).toBe('credited');
    expect(await cashOf(db, player.userId)).toBe(intent.amount);
    // The gateway delivering it afterwards changes nothing.
    expect(
      (await gateway(telebirrCredit(intent.amount, { phone: player.phone, ref: reference }).text))
        .outcome,
    ).toBe('duplicate');
    const again = await db.transaction((tx) =>
      recordReceiptPaymentForPlayer(tx, { userId: player.userId, receipt, now: at(4) }),
    );
    expect(again.status).toBe('already_credited');
    expect(await cashOf(db, player.userId)).toBe(intent.amount);
  });

  it('does not credit a receipt paid before the deposit existed', async () => {
    const player = await createPlayer(db);
    const intent = await openDeposit(player.userId, birr(114), { now: at(30) });
    const result = await db.transaction((tx) =>
      recordReceiptPaymentForPlayer(tx, {
        userId: player.userId,
        receipt: {
          institution: 'telebirr',
          reference: nextRef(),
          amount: intent.amount,
          payerName: null,
          payerPhone: null,
          receiver: '0911000000',
          paidAt: at(0),
          raw: '',
        },
        now: at(31),
      }),
    );
    expect(result.status).toBe('in_review');
    expect(await cashOf(db, player.userId)).toBe(0n);
  });
  it('leaves a receipt without a payment time to staff', async () => {
    const player = await createPlayer(db);
    const intent = await openDeposit(player.userId, birr(115), { now: at(0) });
    const result = await db.transaction((tx) =>
      recordReceiptPaymentForPlayer(tx, {
        userId: player.userId,
        receipt: {
          institution: 'telebirr',
          reference: nextRef(),
          amount: intent.amount,
          payerName: null,
          payerPhone: player.phone,
          receiver: '0911000000',
          paidAt: null,
          raw: '',
        },
        now: at(3),
      }),
    );
    expect(result.status).toBe('in_review');
    expect(result.sms).toMatchObject({ status: 'unmatched', statusReason: 'receipt_without_time' });
    expect(await cashOf(db, player.userId)).toBe(0n);
  });
});

describe('receipt audit and balance reconciliation', () => {
  it('queues credited telebirr messages for a receipt check and raises a rejected one to the top', async () => {
    const player = await createPlayer(db);
    await depositViaSms(player, birr(120));
    const due = await listSmsDueForReceiptCheck(db, { institutions: ['telebirr'], limit: 200 });
    expect(due.length).toBeGreaterThan(0);
    const target = due[due.length - 1]!;
    // Inconclusive answers are retried, then final.
    const first = await db.transaction((tx) =>
      recordReceiptCheck(tx, {
        smsId: target.id,
        status: 'indeterminate',
        reason: 'timeout',
        now: at(2),
      }),
    );
    expect(first.receiptStatus).toBeNull();
    const rejected = await db.transaction((tx) =>
      recordReceiptCheck(tx, {
        smsId: target.id,
        status: 'rejected',
        reason: 'not_a_receipt',
        now: at(3),
      }),
    );
    expect(rejected.receiptStatus).toBe('rejected');
    const queue = await listSmsReviewQueue(db);
    expect(queue[0]?.id).toBe(target.id);
    expect((await smsRailHealth(db)).receiptAlarms).toBeGreaterThan(0);
    await db.transaction((tx) =>
      acknowledgeReceiptAlarm(tx, {
        smsId: target.id,
        adminId: 'staff-1',
        note: 'investigated',
        now: at(4),
      }),
    );
    expect((await listSmsReviewQueue(db)).some((row) => row.id === target.id)).toBe(false);
  });

  it('reads the balances the institution reported', async () => {
    const until = at(500);
    await gateway(telebirrCredit(birr(1), { phone: null, balance: birr(10_000) }).text, {
      now: at(400),
    });
    await gateway(telebirrCredit(birr(2), { phone: null, balance: birr(10_002) }).text, {
      now: at(401),
    });
    const observations = await listBalanceObservations(db, {
      institution: 'telebirr',
      since: at(399),
      until,
    });
    expect(observations.map((o) => o.balance)).toEqual([birr(10_000), birr(10_002)]);
  });
});

describe('the evidence is immutable', () => {
  it('refuses to rewrite or delete a received SMS', async () => {
    const result = await gateway(telebirrCredit(birr(130) + 1n, { phone: null }).text);
    const rewrite = await db
      .update(receivedSms)
      .set({ amount: 1n })
      .where(eq(receivedSms.id, result.sms.id))
      .catch((e: unknown) => e);
    expect(pgCode(rewrite)).toBe('23514');
    const remove = await db
      .delete(receivedSms)
      .where(eq(receivedSms.id, result.sms.id))
      .catch((e: unknown) => e);
    expect(pgCode(remove)).toBe('23001');
  });
});

describe('payout accounts', () => {
  it('verifies the player’s own wallet at once and refuses anyone else’s number', async () => {
    const player = await createPlayer(db);
    const own = await db.transaction((tx) =>
      addPayoutAccount(tx, {
        userId: player.userId,
        institution: 'telebirr',
        account: player.phone,
        now: NOW,
      }),
    );
    expect(own).toMatchObject({ created: true, needsOtp: false });
    expect(own.account.accountName).toBe('Abebe Kebede');
    const again = await db.transaction((tx) =>
      ensureOwnWalletPayoutAccount(tx, { userId: player.userId, now: NOW }),
    );
    expect(again?.id).toBe(own.account.id);
    const error = await domainError(
      db.transaction((tx) =>
        addPayoutAccount(tx, {
          userId: player.userId,
          institution: 'telebirr',
          account: '+251911999999',
          now: NOW,
        }),
      ),
    );
    expect(error.code).toBe('payout_account_not_own');
  });

  it('takes a bank account only in the KYC name, unverified until the OTP', async () => {
    const player = await createPlayer(db);
    const mismatch = await domainError(
      db.transaction((tx) =>
        addPayoutAccount(tx, {
          userId: player.userId,
          institution: 'cbe',
          account: '1000123456789',
          accountName: 'Someone Else',
          now: NOW,
        }),
      ),
    );
    expect(mismatch.code).toBe('payout_account_name_mismatch');
    const bank = await db.transaction((tx) =>
      addPayoutAccount(tx, {
        userId: player.userId,
        institution: 'cbe',
        account: '1000-1234-56789',
        accountName: 'ABEBE KEBEDE',
        now: NOW,
      }),
    );
    expect(bank).toMatchObject({ created: true, needsOtp: true });
    expect(bank.account.account).toBe('1000123456789');
    const verified = await db.transaction((tx) =>
      verifyPayoutAccount(tx, {
        userId: player.userId,
        payoutAccountId: bank.account.id,
        now: NOW,
      }),
    );
    expect(verified.verifiedAt).not.toBeNull();
  });

  it('refuses players without KYC and caps the number of accounts', async () => {
    const unverified = await createPlayer(db, { kyc: 'none' });
    expect(
      (
        await domainError(
          db.transaction((tx) =>
            addPayoutAccount(tx, {
              userId: unverified.userId,
              institution: 'telebirr',
              account: unverified.phone,
              now: NOW,
            }),
          ),
        )
      ).code,
    ).toBe('kyc_required');

    const player = await createPlayer(db);
    for (let i = 0; i < MAX_PAYOUT_ACCOUNTS; i += 1) {
      await db.transaction((tx) =>
        addPayoutAccount(tx, {
          userId: player.userId,
          institution: 'cbe',
          account: `10001234567${i}`,
          accountName: 'Abebe Kebede',
          now: NOW,
        }),
      );
    }
    const over = await domainError(
      db.transaction((tx) =>
        addPayoutAccount(tx, {
          userId: player.userId,
          institution: 'awash',
          account: '0130000001',
          accountName: 'Abebe Kebede',
          now: NOW,
        }),
      ),
    );
    expect(over.code).toBe('too_many_payout_accounts');
  });
});

describe('manual payouts', () => {
  async function playerWithMoney(amount: bigint) {
    const player = await createPlayer(db);
    await depositViaSms(player, amount);
    const wallet = await db.transaction((tx) =>
      addPayoutAccount(tx, {
        userId: player.userId,
        institution: 'telebirr',
        account: player.phone,
        now: NOW,
      }),
    );
    return { ...player, walletId: wallet.account.id };
  }

  async function manualWithdraw(
    player: { userId: string; phone: string },
    payoutAccountId: string,
    amount: bigint,
    r: PaymentRules = rules(),
  ) {
    return db.transaction((tx) =>
      requestWithdrawal(tx, {
        userId: player.userId,
        amount,
        phone: player.phone,
        provider: 'sms',
        manual: true,
        payoutAccountId,
        idempotencyKey: idemKey('mwd'),
        now: at(10),
        rules: r,
      }),
    );
  }

  it('pays a saved wallet only while it is still the registered phone', async () => {
    const player = await playerWithMoney(birr(500));
    const newPhone = `+2519${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
    await db.update(users).set({ phone: newPhone }).where(eq(users.id, player.userId));
    const error = await domainError(
      manualWithdraw({ ...player, phone: newPhone }, player.walletId, birr(200)),
    );
    expect(error.code).toBe('payout_account_not_own');
  });

  it('copies the destination, holds the money and keeps it away from the payout worker', async () => {
    const player = await playerWithMoney(birr(500));
    const { payout } = await manualWithdraw(player, player.walletId, birr(200));
    expect(payout).toMatchObject({
      manual: true,
      status: 'approved',
      approvedBy: 'system:auto',
      destinationInstitution: 'telebirr',
      destinationAccount: player.phone,
      payoutAccountId: player.walletId,
    });
    await db.transaction(async (tx) => {
      const due = await claimDuePayouts(tx, { now: at(11), limit: 500 });
      expect(due.some((p) => p.id === payout.id)).toBe(false);
    });
    expect(
      (
        await domainError(
          db.transaction((tx) => markPayoutPaid(tx, { payoutId: payout.id, now: at(11) })),
        )
      ).code,
    ).toBe('manual_payout');
    expect((await listManualPayoutQueue(db)).some((p) => p.id === payout.id)).toBe(true);
    await expectBooksBalanced(db);
  });

  it('refuses an unverified bank account', async () => {
    const player = await playerWithMoney(birr(300));
    const bank = await db.transaction((tx) =>
      addPayoutAccount(tx, {
        userId: player.userId,
        institution: 'cbe',
        account: '1000555555555',
        accountName: 'Abebe Kebede',
        now: NOW,
      }),
    );
    expect((await domainError(manualWithdraw(player, bank.account.id, birr(100)))).code).toBe(
      'payout_account_unverified',
    );
  });

  it('keeps approving and paying in different hands, and pays exactly once', async () => {
    const player = await playerWithMoney(birr(9000));
    const { payout } = await manualWithdraw(player, player.walletId, birr(6000));
    expect(payout.status).toBe('requested');
    await db.transaction((tx) =>
      approveWithdrawal(tx, { payoutId: payout.id, adminId: 'admin-a', now: at(12) }),
    );

    const approverClaims = await domainError(
      db.transaction((tx) =>
        claimManualPayout(tx, { payoutId: payout.id, staffId: 'admin-a', now: at(13) }),
      ),
    );
    expect(approverClaims.code).toBe('manual_payout_approver_cannot_pay');

    await db.transaction((tx) =>
      claimManualPayout(tx, { payoutId: payout.id, staffId: 'op-b', now: at(13) }),
    );
    const intruder = await domainError(
      db.transaction((tx) =>
        settleManualPayout(tx, {
          payoutId: payout.id,
          staffId: 'op-c',
          reference: 'CB99999991',
          holderNameConfirmed: false,
          requireProof: false,
          now: at(14),
        }),
      ),
    );
    expect(intruder.code).toBe('manual_payout_claimed_by_someone_else');
    expect(
      (
        await domainError(
          db.transaction((tx) =>
            cancelWithdrawal(tx, { payoutId: payout.id, userId: player.userId, now: at(14) }),
          ),
        )
      ).code,
    ).toBe('payout_not_cancellable');

    const paid = await db.transaction((tx) =>
      settleManualPayout(tx, {
        payoutId: payout.id,
        staffId: 'op-b',
        reference: 'cb99999991',
        holderNameConfirmed: false,
        requireProof: false,
        now: at(15),
      }),
    );
    expect(paid).toMatchObject({
      status: 'paid',
      settledBy: 'op-b',
      settlementReference: 'CB99999991',
      payingBy: null,
    });
    expect(await getBalance(db, psp('sms'))).toBeDefined();
    expect((await outboxOf(db, payout.id)).map(([type]) => type)).toContain(
      'payment.withdrawal_paid',
    );
    const replay = await domainError(
      db.transaction((tx) =>
        settleManualPayout(tx, {
          payoutId: payout.id,
          staffId: 'op-b',
          reference: 'CB99999991',
          holderNameConfirmed: false,
          requireProof: false,
          now: at(16),
        }),
      ),
    );
    expect(replay.code).toBe('manual_payout_wrong_status');
    await expectBooksBalanced(db);
  });

  it('refuses one transfer reference for two payouts', async () => {
    const player = await playerWithMoney(birr(1000));
    const one = (await manualWithdraw(player, player.walletId, birr(100))).payout;
    const two = (await manualWithdraw(player, player.walletId, birr(100))).payout;
    for (const p of [one, two]) {
      await db.transaction((tx) =>
        claimManualPayout(tx, { payoutId: p.id, staffId: 'op-b', now: at(13) }),
      );
    }
    await db.transaction((tx) =>
      settleManualPayout(tx, {
        payoutId: one.id,
        staffId: 'op-b',
        reference: 'CB77777771',
        holderNameConfirmed: false,
        requireProof: false,
        now: at(14),
      }),
    );
    const error = await domainError(
      db.transaction((tx) =>
        settleManualPayout(tx, {
          payoutId: two.id,
          staffId: 'op-b',
          reference: 'CB77777771',
          holderNameConfirmed: false,
          requireProof: false,
          now: at(14),
        }),
      ),
    );
    expect(error.code).toBe('settlement_reference_used');
  });

  it('settles against the outgoing SMS it proposed, and can require that proof', async () => {
    const player = await playerWithMoney(birr(800));
    const { payout } = await manualWithdraw(player, player.walletId, birr(321));
    await db.transaction((tx) =>
      claimManualPayout(tx, { payoutId: payout.id, staffId: 'op-b', now: at(13) }),
    );
    const noProof = await domainError(
      db.transaction((tx) =>
        settleManualPayout(tx, {
          payoutId: payout.id,
          staffId: 'op-b',
          reference: 'CB55555551',
          holderNameConfirmed: false,
          requireProof: true,
          now: at(14),
        }),
      ),
    );
    expect(noProof.code).toBe('settlement_proof_required');

    const debit = await gateway(telebirrDebit(birr(321), player.phone).text, { now: at(14) });
    expect(debit.outcome).toBe('proposed');
    expect(debit.sms.proposedPayoutId).toBe(payout.id);
    const paid = await db.transaction((tx) =>
      settleManualPayout(tx, {
        payoutId: payout.id,
        staffId: 'op-b',
        smsId: debit.sms.id,
        holderNameConfirmed: false,
        requireProof: true,
        now: at(15),
      }),
    );
    expect(paid).toMatchObject({
      status: 'paid',
      settlementSmsId: debit.sms.id,
      settlementReference: debit.sms.reference,
    });
    const [sms] = await db.select().from(receivedSms).where(eq(receivedSms.id, debit.sms.id));
    expect(sms?.status).toBe('settled');
  });

  it('refuses a typed reference that names another transfer we saw', async () => {
    const player = await playerWithMoney(birr(800));
    const { payout } = await manualWithdraw(player, player.walletId, birr(222));
    await db.transaction((tx) =>
      claimManualPayout(tx, { payoutId: payout.id, staffId: 'op-b', now: at(13) }),
    );
    const other = await gateway(telebirrDebit(birr(999), '+251922222222').text, { now: at(14) });
    const error = await domainError(
      db.transaction((tx) =>
        settleManualPayout(tx, {
          payoutId: payout.id,
          staffId: 'op-b',
          reference: other.sms.reference!,
          holderNameConfirmed: false,
          requireProof: false,
          now: at(15),
        }),
      ),
    );
    expect(error.code).toBe('settlement_reference_mismatch');
  });

  describe('a debit SMS only proves the transfer it shows (insider fraud)', () => {
    async function claim(payoutId: string, staffId: string, minute: number) {
      return db.transaction((tx) => claimManualPayout(tx, { payoutId, staffId, now: at(minute) }));
    }

    function settle(
      payoutId: string,
      proof: { reference: string } | { smsId: string },
      options: { staffId?: string; minute?: number; holderNameConfirmed?: boolean } = {},
    ) {
      return db.transaction((tx) =>
        settleManualPayout(tx, {
          payoutId,
          staffId: options.staffId ?? 'op-b',
          ...proof,
          holderNameConfirmed: options.holderNameConfirmed ?? false,
          requireProof: false,
          now: at(options.minute ?? 30),
        }),
      );
    }

    /** The payout's paid posting (the hold is a posting of its own): none while it is unpaid. */
    async function paidPostings(payoutId: string): Promise<number> {
      const [row] = await db
        .select({ n: count() })
        .from(ledgerTransactions)
        .where(eq(ledgerTransactions.idempotencyKey, withdrawalPaidLedgerKey(payoutId)));
      return row?.n ?? 0;
    }

    async function smsRow(id: string) {
      const [row] = await db.select().from(receivedSms).where(eq(receivedSms.id, id));
      return row!;
    }

    async function expectUnpaid(payoutId: string, claimer: string) {
      expect(await getPayout(db, payoutId)).toMatchObject({
        status: 'processing',
        payingBy: claimer,
        settlementReference: null,
        settlementSmsId: null,
      });
      expect(await paidPostings(payoutId)).toBe(0);
    }

    it('never settles a player’s payout with a same-amount debit to another number', async () => {
      const player = await playerWithMoney(birr(800));
      const { payout } = await manualWithdraw(player, player.walletId, birr(433));
      await claim(payout.id, 'op-b', 13);
      const before = await getBalance(db, PENDING);
      // The claimer pays themselves the same amount from the collection account.
      const own = await gateway(telebirrDebit(birr(433), '+251933333333').text, { now: at(14) });
      expect(own.outcome).toBe('ignored_debit');
      expect(own.sms.statusReason).toBe('no_candidate');

      const error = await domainError(settle(payout.id, { reference: own.sms.reference! }));
      expect(error.code).toBe('settlement_destination_mismatch');
      expect(error.message).toMatch(/another number/);
      await expectUnpaid(payout.id, 'op-b');
      expect(await getBalance(db, PENDING)).toBe(before);
      expect((await smsRow(own.sms.id)).status).toBe('ignored_debit');
      expect((await outboxOf(db, payout.id)).map(([type]) => type)).not.toContain(
        'payment.withdrawal_paid',
      );
      await expectBooksBalanced(db);
    });

    it('refuses a debit to the right number that predates the claim', async () => {
      const player = await playerWithMoney(birr(800));
      const { payout } = await manualWithdraw(player, player.walletId, birr(434));
      // Sent while the payout was only approved: nobody had claimed it, so it is proposed for nothing.
      const early = await gateway(telebirrDebit(birr(434), player.phone).text, { now: at(11) });
      expect(early.outcome).toBe('ignored_debit');
      await claim(payout.id, 'op-b', 20);
      const error = await domainError(settle(payout.id, { reference: early.sms.reference! }));
      expect(error.code).toBe('settlement_proof_too_old');
      await expectUnpaid(payout.id, 'op-b');

      // Forwarded after the claim, but the institution says the money moved before it.
      const backlog = await gateway(
        telebirrDebit(birr(434), player.phone, nextRef('CB'), '12:05:00 PM').text, // 09:05Z, at(5)
        { now: at(25) },
      );
      expect(backlog.outcome).toBe('ignored_debit');
      expect(
        (await domainError(settle(payout.id, { reference: backlog.sms.reference! }))).code,
      ).toBe('settlement_proof_too_old');
      await expectUnpaid(payout.id, 'op-b');
    });

    it('settles with the reference of a debit to the player’s number after the claim', async () => {
      const player = await playerWithMoney(birr(1000));
      // Two payouts of one amount to one number: the debit fits both, so it is proposed for neither.
      const one = (await manualWithdraw(player, player.walletId, birr(435))).payout;
      const two = (await manualWithdraw(player, player.walletId, birr(435))).payout;
      await claim(one.id, 'op-b', 13);
      await claim(two.id, 'op-b', 13);
      const debit = await gateway(telebirrDebit(birr(435), player.phone).text, { now: at(14) });
      expect(debit.outcome).toBe('ignored_debit');
      expect(debit.sms.statusReason).toBe('ambiguous');
      const paid = await settle(one.id, { reference: debit.sms.reference! });
      expect(paid).toMatchObject({
        status: 'paid',
        settledBy: 'op-b',
        settlementReference: debit.sms.reference,
        settlementSmsId: debit.sms.id,
      });
      expect(await paidPostings(one.id)).toBe(1);
      expect(await smsRow(debit.sms.id)).toMatchObject({
        status: 'settled',
        proposedPayoutId: one.id,
      });
      await expectUnpaid(two.id, 'op-b');
      await expectBooksBalanced(db);
    });

    it('settles a proposal by its typed reference, with or without the number in the SMS', async () => {
      const player = await playerWithMoney(birr(1000));
      const named = (await manualWithdraw(player, player.walletId, birr(436))).payout;
      await claim(named.id, 'op-b', 13);
      const withNumber = await gateway(telebirrDebit(birr(436), player.phone).text, {
        now: at(14),
      });
      expect(withNumber.sms).toMatchObject({
        status: 'settlement_proposed',
        statusReason: 'amount_and_account',
        proposedPayoutId: named.id,
      });
      expect(await settle(named.id, { reference: withNumber.sms.reference! })).toMatchObject({
        status: 'paid',
        settlementSmsId: withNumber.sms.id,
      });

      // The sparse SMS without a number: the matcher proposed it as the only payout of its amount.
      const sparse = (await manualWithdraw(player, player.walletId, birr(436) + 1n)).payout;
      await claim(sparse.id, 'op-b', 13);
      const anonymous = await gateway(telebirrDebit(birr(436) + 1n, null).text, { now: at(14) });
      expect(anonymous.sms).toMatchObject({
        status: 'settlement_proposed',
        statusReason: 'amount_only',
        proposedPayoutId: sparse.id,
        counterpartyPhone: null,
      });
      expect(await settle(sparse.id, { reference: anonymous.sms.reference! })).toMatchObject({
        status: 'paid',
        settlementSmsId: anonymous.sms.id,
      });
      await expectBooksBalanced(db);
    });

    it('refuses an ignored debit without a number as proof of a wallet payout', async () => {
      const first = await playerWithMoney(birr(800));
      const second = await playerWithMoney(birr(800));
      const a = (await manualWithdraw(first, first.walletId, birr(437))).payout;
      const b = (await manualWithdraw(second, second.walletId, birr(437))).payout;
      await claim(a.id, 'op-b', 13);
      await claim(b.id, 'op-b', 13);
      const anonymous = await gateway(telebirrDebit(birr(437), null).text, { now: at(14) });
      expect(anonymous.sms).toMatchObject({ status: 'ignored_debit', statusReason: 'ambiguous' });
      const error = await domainError(settle(a.id, { reference: anonymous.sms.reference! }));
      expect(error.code).toBe('settlement_proof_mismatch');
      await expectUnpaid(a.id, 'op-b');
      await expectUnpaid(b.id, 'op-b');
    });

    it('never proposes a debit for a payout nobody has claimed', async () => {
      const player = await playerWithMoney(birr(800));
      const { payout } = await manualWithdraw(player, player.walletId, birr(438));
      expect(payout.status).toBe('approved');
      const debit = await gateway(telebirrDebit(birr(438), player.phone).text, { now: at(14) });
      expect(debit.sms).toMatchObject({
        status: 'ignored_debit',
        statusReason: 'no_candidate',
        proposedPayoutId: null,
      });
      // Claimed afterwards, that older transfer still does not pay it.
      await claim(payout.id, 'op-b', 30);
      expect((await domainError(settle(payout.id, { reference: debit.sms.reference! }))).code).toBe(
        'settlement_proof_too_old',
      );
    });

    it('gives two payouts of one amount to different numbers each their own debit', async () => {
      const first = await playerWithMoney(birr(800));
      const second = await playerWithMoney(birr(800));
      const a = (await manualWithdraw(first, first.walletId, birr(439))).payout;
      const b = (await manualWithdraw(second, second.walletId, birr(439))).payout;
      await claim(a.id, 'op-b', 13);
      await claim(b.id, 'op-d', 13);
      const toSecond = await gateway(telebirrDebit(birr(439), second.phone).text, { now: at(14) });
      const toFirst = await gateway(telebirrDebit(birr(439), first.phone).text, { now: at(15) });
      expect(toSecond.sms.proposedPayoutId).toBe(b.id);
      expect(toFirst.sms.proposedPayoutId).toBe(a.id);
      // Each operator's reference proves only their own payout.
      expect((await domainError(settle(a.id, { reference: toSecond.sms.reference! }))).code).toBe(
        'settlement_reference_mismatch',
      );
      expect(await settle(a.id, { smsId: toFirst.sms.id })).toMatchObject({ status: 'paid' });
      expect(
        await settle(b.id, { reference: toSecond.sms.reference! }, { staffId: 'op-d' }),
      ).toMatchObject({ status: 'paid', settlementSmsId: toSecond.sms.id });
      await expectBooksBalanced(db);
    });

    it('refuses a proposal made under an earlier claim to the next claimer', async () => {
      const player = await playerWithMoney(birr(800));
      const { payout } = await manualWithdraw(player, player.walletId, birr(440));
      await claim(payout.id, 'op-b', 13);
      const debit = await gateway(telebirrDebit(birr(440), player.phone).text, { now: at(14) });
      expect(debit.sms.proposedPayoutId).toBe(payout.id);
      await db.transaction((tx) =>
        releaseManualPayout(tx, { payoutId: payout.id, staffId: 'op-b', note: 'x', now: at(15) }),
      );
      await claim(payout.id, 'op-d', 40);
      const error = await domainError(
        settle(payout.id, { smsId: debit.sms.id }, { staffId: 'op-d' }),
      );
      expect(error.code).toBe('settlement_proof_too_old');
      await expectUnpaid(payout.id, 'op-d');
    });

    it('never settles a bank payout with a debit that went to a mobile number, whatever the claimer confirms', async () => {
      const player = await playerWithMoney(birr(800));
      const bank = await db.transaction((tx) =>
        addPayoutAccount(tx, {
          userId: player.userId,
          institution: 'cbe',
          account: '1000777777777',
          accountName: 'Abebe Kebede',
          now: NOW,
        }),
      );
      await db.transaction((tx) =>
        verifyPayoutAccount(tx, {
          userId: player.userId,
          payoutAccountId: bank.account.id,
          now: NOW,
        }),
      );
      const { payout } = await manualWithdraw(player, bank.account.id, birr(447));
      await claim(payout.id, 'op-b', 13);
      const before = await getBalance(db, PENDING);
      // The claimer sends the amount to their own wallet and points at that debit.
      const own = await gateway(telebirrDebit(birr(447), '+251944444444').text, { now: at(14) });
      expect(own.outcome).toBe('ignored_debit');
      const error = await domainError(
        settle(payout.id, { reference: own.sms.reference! }, { holderNameConfirmed: true }),
      );
      expect(error.code).toBe('settlement_destination_mismatch');
      expect(error.message).toMatch(/mobile number/);
      await expectUnpaid(payout.id, 'op-b');
      expect(await getBalance(db, PENDING)).toBe(before);
      expect((await smsRow(own.sms.id)).status).toBe('ignored_debit');
      await expectBooksBalanced(db);
    });

    it('keeps the bank rule: a debit without a number settles a bank payout after the claim', async () => {
      const player = await playerWithMoney(birr(800));
      const bank = await db.transaction((tx) =>
        addPayoutAccount(tx, {
          userId: player.userId,
          institution: 'cbe',
          account: '1000888888888',
          accountName: 'Abebe Kebede',
          now: NOW,
        }),
      );
      await db.transaction((tx) =>
        verifyPayoutAccount(tx, {
          userId: player.userId,
          payoutAccountId: bank.account.id,
          now: NOW,
        }),
      );
      const early = (await manualWithdraw(player, bank.account.id, birr(441))).payout;
      const ref = 'FT26283BANK1';
      const cbeDebit = (reference: string) =>
        `Dear Customer, Your account has been debited with ETB 441.00 on 10/10/2026. Ref No ${reference}`;
      // A debit received before the claim (beyond the skew) is refused for a bank too.
      const before = await gateway(cbeDebit('FT26283BANK0'), { sender: 'CBE', now: at(11) });
      expect(before.outcome).toBe('ignored_debit');
      await claim(early.id, 'op-b', 20);
      expect(
        (
          await domainError(
            settle(early.id, { reference: 'FT26283BANK0' }, { holderNameConfirmed: true }),
          )
        ).code,
      ).toBe('settlement_proof_too_old');

      const after = await gateway(cbeDebit(ref), { sender: 'CBE', now: at(25) });
      expect(after.sms).toMatchObject({ direction: 'debit', counterpartyPhone: null });
      expect(
        await settle(early.id, { reference: ref }, { holderNameConfirmed: true }),
      ).toMatchObject({ status: 'paid', settlementSmsId: after.sms.id, holderNameConfirmed: true });
    });
  });

  it('needs the holder-name confirmation for a bank payout', async () => {
    const player = await playerWithMoney(birr(800));
    const bank = await db.transaction((tx) =>
      addPayoutAccount(tx, {
        userId: player.userId,
        institution: 'cbe',
        account: '1000777777777',
        accountName: 'Abebe Kebede',
        now: NOW,
      }),
    );
    await db.transaction((tx) =>
      verifyPayoutAccount(tx, {
        userId: player.userId,
        payoutAccountId: bank.account.id,
        now: NOW,
      }),
    );
    const { payout } = await manualWithdraw(player, bank.account.id, birr(150));
    // Removing the account later does not redirect or block the payout.
    await db.transaction((tx) =>
      removePayoutAccount(tx, {
        userId: player.userId,
        payoutAccountId: bank.account.id,
        now: at(11),
      }),
    );
    await db.transaction((tx) =>
      claimManualPayout(tx, { payoutId: payout.id, staffId: 'op-b', now: at(13) }),
    );
    const error = await domainError(
      db.transaction((tx) =>
        settleManualPayout(tx, {
          payoutId: payout.id,
          staffId: 'op-b',
          reference: 'FT26227AAAA',
          holderNameConfirmed: false,
          requireProof: false,
          now: at(14),
        }),
      ),
    );
    expect(error.code).toBe('holder_name_not_confirmed');
    const paid = await db.transaction((tx) =>
      settleManualPayout(tx, {
        payoutId: payout.id,
        staffId: 'op-b',
        reference: 'FT26227AAAA',
        holderNameConfirmed: true,
        requireProof: false,
        now: at(14),
      }),
    );
    expect(paid).toMatchObject({
      status: 'paid',
      destinationAccount: '1000777777777',
      holderNameConfirmed: true,
    });
  });

  it('releases a claim unpaid, and returns the hold when the transfer failed', async () => {
    const player = await playerWithMoney(birr(400));
    const before = await cashOf(db, player.userId);
    const { payout } = await manualWithdraw(player, player.walletId, birr(100));
    await db.transaction((tx) =>
      claimManualPayout(tx, { payoutId: payout.id, staffId: 'op-b', now: at(13) }),
    );
    const released = await db.transaction((tx) =>
      releaseManualPayout(tx, {
        payoutId: payout.id,
        staffId: 'op-b',
        note: 'shift ended',
        now: at(14),
      }),
    );
    expect(released).toMatchObject({ status: 'approved', payingBy: null });
    await db.transaction((tx) =>
      claimManualPayout(tx, { payoutId: payout.id, staffId: 'op-d', now: at(15) }),
    );
    const failed = await db.transaction((tx) =>
      failManualPayout(tx, {
        payoutId: payout.id,
        staffId: 'op-d',
        reason: 'wallet refused the transfer',
        now: at(16),
      }),
    );
    expect(failed.status).toBe('failed');
    expect(await cashOf(db, player.userId)).toBe(before);
    await expectBooksBalanced(db);
  });

  it('enforces four eyes in the database too', async () => {
    const player = await playerWithMoney(birr(9000));
    const { payout } = await manualWithdraw(player, player.walletId, birr(6000));
    await db.transaction((tx) =>
      approveWithdrawal(tx, { payoutId: payout.id, adminId: 'admin-a', now: at(12) }),
    );
    const error = await db
      .update(payouts)
      .set({ status: 'processing', payingBy: 'admin-a' })
      .where(eq(payouts.id, payout.id))
      .catch((e: unknown) => e);
    expect(pgCode(error)).toBe('23514');
    expect((await getPayout(db, payout.id))?.status).toBe('approved');
  });

  it('keeps the books and the hold account in step across everything above', async () => {
    await expectBooksBalanced(db);
    const [pending] = await db
      .select({ n: count() })
      .from(payouts)
      .where(eq(payouts.status, 'processing'));
    expect(pending?.n).toBeGreaterThanOrEqual(0);
    const held = await getBalance(db, PENDING);
    expect(held).toBeGreaterThanOrEqual(0n);
    const [unbalanced] = await db
      .select({ n: count() })
      .from(ledgerTransactions)
      .where(
        sql`(SELECT COALESCE(SUM(${ledgerEntries.amount}), 0) FROM ${ledgerEntries} WHERE ${ledgerEntries.transactionId} = ${ledgerTransactions.id}) <> 0`,
      );
    expect(unbalanced?.n).toBe(0);
    const [smsIntents] = await db
      .select({ n: count() })
      .from(paymentIntents)
      .where(eq(paymentIntents.provider, 'sms'));
    expect(smsIntents?.n).toBeGreaterThan(0);
  });
});
