import type { Database } from '@vamos/db';
import { smsMessages } from '@vamos/db/schema';
import { sql } from 'drizzle-orm';
import type { Locale } from '../lib/locale';

export interface SmsMessage {
  /** E.164 recipient, e.g. +251911234567. */
  to: string;
  body: string;
  /** Template id for reporting and the dev inbox, e.g. `otp_register`. */
  template: string;
}

export interface SmsProvider {
  /** `mock` in demo mode; real gateways report their own name. */
  readonly name: string;
  send(message: SmsMessage): Promise<{ id: string }>;
}

/**
 * Demo-mode SMS "gateway": nothing leaves the server. Messages are recorded
 * in `sms_messages`, where the dev inbox (`GET /dev/sms`) and tests read them.
 */
export class MockSmsProvider implements SmsProvider {
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

/**
 * One-time code SMS. Always bilingual (Amharic and English) so it can be read
 * whatever the handset's language; English comes first for `en` users. Fits
 * in two concatenated Unicode (UCS-2) SMS segments.
 */
export function otpSmsBody(code: string, locale: Locale): string {
  const amharic = `የማረጋገጫ ኮድዎ ${code} ነው።`;
  const english = `Your code is ${code}. Valid 5 min. Never share it.`;
  return locale === 'en' ? `Vamos: ${english} ${amharic}` : `Vamos: ${amharic} ${english}`;
}
