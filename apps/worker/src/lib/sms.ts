import { formatBirr, type Santim } from '@vamos/core';
import type { Database } from '@vamos/db';
import { smsMessages } from '@vamos/db/schema';
import { sql } from 'drizzle-orm';

/**
 * Outgoing SMS for worker notifications. Same contract as the API's
 * SmsProvider (apps/api/src/providers/sms.ts); the worker cannot import the
 * API, so the mock gateway is mirrored here. Both write to `sms_messages`,
 * where the dev inbox (GET /dev/sms) shows them.
 */
export interface SmsMessage {
  /** E.164 recipient, e.g. +251911234567. */
  to: string;
  body: string;
  /** Template id for reporting and the dev inbox, e.g. `deposit_succeeded`. */
  template: string;
}

export interface SmsSender {
  /** `mock` in demo mode; real gateways report their own name. */
  readonly name: string;
  send(message: SmsMessage): Promise<{ id: string }>;
}

/** Thrown at startup for an SMS_PROVIDER that has no adapter yet (the worker refuses to start). */
export class SmsProviderNotImplementedError extends Error {
  constructor(name: string) {
    super(
      `SMS_PROVIDER="${name}" is not implemented yet. ` +
        'Use the "mock" provider (demo mode) until its adapter is built.',
    );
    this.name = 'SmsProviderNotImplementedError';
  }
}

/** Demo-mode SMS "gateway": nothing leaves the server; messages land in `sms_messages`. */
export class MockSmsSender implements SmsSender {
  readonly name = 'mock';

  constructor(private readonly db: Database) {}

  async send(message: SmsMessage): Promise<{ id: string }> {
    const [row] = await this.db
      .insert(smsMessages)
      .values({
        to: message.to,
        body: message.body,
        template: message.template,
        provider: 'mock',
        status: 'sent',
        sentAt: sql`now()`,
      })
      .returning({ id: smsMessages.id });
    if (!row) throw new Error('sms_messages insert returned no row');
    return { id: row.id };
  }
}

/** The SMS gateway of SMS_PROVIDER; throws SmsProviderNotImplementedError for one without an adapter. */
export function createSmsSender(provider: string, db: Database): SmsSender {
  if (provider === 'mock') return new MockSmsSender(db);
  throw new SmsProviderNotImplementedError(provider);
}

/** Payment notifications the worker sends. */
export type PaymentSmsTemplate = 'deposit_succeeded' | 'withdrawal_paid' | 'withdrawal_failed';

/**
 * A payment notification, bilingual (Amharic and English) like the OTP SMS,
 * English first for `en` players. Amounts are formatted from santim.
 * (The Amharic wording should be reviewed by a native speaker before launch.)
 */
export function paymentSmsBody(
  template: PaymentSmsTemplate,
  amount: Santim,
  locale: string,
): string {
  const etb = formatBirr(amount, { currency: true });
  const birr = formatBirr(amount);
  const text: Record<PaymentSmsTemplate, { en: string; am: string }> = {
    deposit_succeeded: {
      en: `Deposit of ${etb} received.`,
      am: `${birr} ብር ተቀማጭ ደርሷል።`,
    },
    withdrawal_paid: {
      en: `Withdrawal of ${etb} sent to your phone.`,
      am: `${birr} ብር ወደ ስልክዎ ተልኳል።`,
    },
    withdrawal_failed: {
      en: `Withdrawal of ${etb} failed. The money is back in your balance.`,
      am: `${birr} ብር ማውጣት አልተሳካም፤ ገንዘቡ ወደ ሂሳብዎ ተመልሷል።`,
    },
  };
  const { en, am } = text[template];
  return locale === 'en' ? `Nahubet: ${en} ${am}` : `Nahubet: ${am} ${en}`;
}
