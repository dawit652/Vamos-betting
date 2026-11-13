import type { OwnerAlertsConfig } from '@vamos/config';
import { buildOwnerAlert, type OwnerAlertInput } from '@vamos/core';
import type { DbExecutor } from '../ledger/types';
import { enqueueOutbox } from './outbox';

/** Outbox type of an alert to the owner's phone (plan task 1.11); the worker texts it. */
export const OWNER_ALERT = 'owner.alert';

/** The payload of an `owner.alert` outbox row. */
export interface OwnerAlertPayload {
  /** The alarm's name plus its subject (buildOwnerAlert): the unit of deduplication. */
  key: string;
  /** The text to send: what was done, at most 160 characters, no personal data. */
  message: string;
  /** ISO time the alarm was raised: the dedupe window runs on this, not on delivery time. */
  raisedAt: string;
}

/**
 * Raises an alert for an alarm: writes an `owner.alert` outbox row. Call it with the transaction
 * that opens the alarm's review item (or its own small one where the alarm was only a log line), so
 * the alert exists if and only if the alarm does. It writes nothing while no owner number is
 * configured (OWNER_ALERT_PHONES empty, the default), so a deployment without alerts is unchanged.
 * Returns whether a row was written. The worker texts every number once per key and interval.
 */
export async function enqueueOwnerAlert(
  exec: DbExecutor,
  ownerAlerts: Pick<OwnerAlertsConfig, 'phones'>,
  input: OwnerAlertInput,
  now: Date,
): Promise<boolean> {
  if (ownerAlerts.phones.length === 0) return false;
  const alert = buildOwnerAlert(input);
  const payload: OwnerAlertPayload = {
    key: alert.key,
    message: alert.message,
    raisedAt: now.toISOString(),
  };
  await enqueueOutbox(exec, {
    type: OWNER_ALERT,
    aggregateType: 'owner_alert',
    aggregateId: alert.key,
    payload: { ...payload },
  });
  return true;
}
