import type { APIRequestContext } from '@playwright/test';
import { API_URL } from './env';

/** One message of the mock SMS gateway (`GET /dev/sms?phone=`). */
export interface DevSms {
  to: string;
  body: string;
  template: string;
  createdAt: string;
}

/** The latest messages the mock SMS gateway "sent" to `phone`, newest first. */
export async function devInbox(request: APIRequestContext, phone: string): Promise<DevSms[]> {
  const response = await request.get(`${API_URL}/dev/sms`, { params: { phone } });
  if (response.status() === 404) {
    throw new Error(
      'GET /dev/sms is 404: the dev SMS inbox needs OPERATING_MODE=demo, SMS_PROVIDER=mock and NODE_ENV other than production on the API',
    );
  }
  if (!response.ok()) throw new Error(`GET /dev/sms failed: ${response.status()}`);
  const body = (await response.json()) as { items: DevSms[] };
  return body.items;
}

/**
 * Waits for an OTP sent to `phone` with the given template (newer than
 * `since`, when given) and returns its 6-digit code, read from the dev inbox
 * the way a tester would read their phone.
 */
export async function readOtp(
  request: APIRequestContext,
  phone: string,
  options: { template?: string; since?: Date; timeoutMs?: number } = {},
): Promise<string> {
  const template = options.template ?? 'otp_register';
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  for (;;) {
    const messages = await devInbox(request, phone);
    const message = messages.find(
      (sms) =>
        sms.template === template &&
        (options.since === undefined || new Date(sms.createdAt) >= options.since),
    );
    const code = message === undefined ? undefined : /\b(\d{6})\b/.exec(message.body)?.[1];
    if (code !== undefined) return code;
    if (Date.now() > deadline) {
      throw new Error(`no ${template} SMS with a 6-digit code reached ${phone}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
