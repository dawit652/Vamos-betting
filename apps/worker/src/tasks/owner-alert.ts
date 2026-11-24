import { ownerAlertTargetCount } from '@vamos/config';
import type { OwnerAlertSmsJobData } from './outbox-dispatch';
import { claimAlertSlot, releaseAlertSlot } from '../lib/owner-alert';
import type { TaskContext } from './context';

/**
 * The `owner.alert` handler (plan task 1.11). The outbox dispatcher hands each owner.alert row to the
 * `sms` queue; this sends its text, as it is, to every number of OWNER_ALERT_PHONES through the SMS
 * gateway (the mock one in demo mode), and to every chat of TELEGRAM_OWNER_CHAT_IDS through the bot. To know, not to act: the safe action was taken before the
 * alert was written.
 *
 * - With no number configured it does nothing.
 * - The same key is sent at most once per OWNER_ALERT_MIN_INTERVAL_MINUTES (claimAlertSlot, one Redis
 *   key per alert key, atomic across workers); an alert inside the window is dropped and logged.
 * - If every send fails the window is given back and the job fails, so BullMQ retries it; if only
 *   some numbers fail they are logged and not retried (the others would be texted twice).
 * - It logs the key, the text and how many numbers got it; never the numbers.
 */

/** Template of the owner's alert texts (sms_messages.template). */
export const OWNER_ALERT_TEMPLATE = 'owner_alert';

export type OwnerAlertResult =
  | { sent: true; template: typeof OWNER_ALERT_TEMPLATE; messageId: string; recipients: number }
  | { sent: false; reason: 'owner_alerts_off' | 'suppressed' };

export async function processOwnerAlertJob(
  ctx: TaskContext,
  data: OwnerAlertSmsJobData,
): Promise<OwnerAlertResult> {
  const alerts = ctx.ownerAlerts;
  if (alerts === undefined || ownerAlertTargetCount(alerts) === 0) {
    return { sent: false, reason: 'owner_alerts_off' };
  }
  const parsed = Date.parse(data.raisedAt);
  const raisedAt = Number.isNaN(parsed) ? ctx.clock().getTime() : parsed;
  // The alarm's own repeat window (owner's rule: only what matters, not every few minutes); a
  // service-down alert keeps its own 15 minutes exactly (owner, 21 Nov 2026).
  const intervalMs =
    data.exactRepeat === true
      ? (data.repeatMs ?? 0)
      : Math.max(alerts.minIntervalMinutes * 60_000, data.repeatMs ?? 0);
  if (!(await claimAlertSlot(ctx.redis, 'sent', data.key, raisedAt, intervalMs))) {
    ctx.logger.info(
      {
        alertKey: data.key,
        outboxId: data.outboxId,
        minIntervalMinutes: alerts.minIntervalMinutes,
      },
      'owner alert already sent within the interval; not sent again',
    );
    return { sent: false, reason: 'suppressed' };
  }
  // Service alerts go to Telegram only (one every 15 minutes would cost an SMS each).
  const phones = data.telegramOnly === true ? [] : alerts.phones;
  const results = await Promise.allSettled(
    phones.map((to) => ctx.sms.send({ to, body: data.message, template: OWNER_ALERT_TEMPLATE })),
  );
  // The same text to the owner's Telegram chats (when the bot is configured).
  const telegram = ctx.telegram;
  const chats = telegram === undefined ? [] : (alerts.telegramChatIds ?? []);
  const telegramResults = await Promise.allSettled(
    chats.map((chatId) => telegram!.sendMessage(chatId, data.message)),
  );
  const ids: string[] = [];
  const failures: unknown[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') ids.push(result.value.id);
    else failures.push(result.reason);
  }
  for (const [i, result] of telegramResults.entries()) {
    if (result.status === 'fulfilled') ids.push(`telegram:${i}:${result.value.message_id}`);
    else failures.push(result.reason);
  }
  const [firstId] = ids;
  if (firstId === undefined) {
    await releaseAlertSlot(ctx.redis, 'sent', data.key, raisedAt).catch(() => {});
    throw failures[0] instanceof Error ? failures[0] : new Error('owner alert SMS send failed');
  }
  if (failures.length > 0) {
    ctx.logger.error(
      { alertKey: data.key, outboxId: data.outboxId, failed: failures.length, err: failures[0] },
      'owner alert SMS failed for some numbers',
    );
  }
  ctx.logger.info(
    {
      alertKey: data.key,
      outboxId: data.outboxId,
      message: data.message,
      recipients: ids.length,
      provider: ctx.sms.name,
    },
    'owner alert sent',
  );
  return { sent: true, template: OWNER_ALERT_TEMPLATE, messageId: firstId, recipients: ids.length };
}
