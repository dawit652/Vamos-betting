import type { MessageKey } from '@vamos/i18n/translate';
import type { UserToast } from './messages';

/**
 * A tiny in-page channel to the toast host (UserStreamHost): code that already
 * knows an outcome (the cash-out sheet after its own POST) shows it at once,
 * and the push message that follows for the same bet is not toasted twice.
 */

type ToastListener = (toast: UserToast) => void;

const listeners = new Set<ToastListener>();
const handled = new Map<string, number>();
/** A push message for a bet the page already announced is ignored for this long. */
const HANDLED_MS = 60_000;

export function onToast(listener: ToastListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function pushToast(
  key: MessageKey,
  params: Record<string, string>,
  tone: UserToast['tone'] = 'success',
): void {
  for (const listener of [...listeners]) listener({ key, params, tone });
}

/** Remember that this page already announced `betId`'s outcome. */
export function markAnnounced(betId: string, now: number = Date.now()): void {
  handled.set(betId, now);
  for (const [id, at] of handled) if (now - at > HANDLED_MS) handled.delete(id);
}

export function wasAnnounced(betId: string, now: number = Date.now()): boolean {
  const at = handled.get(betId);
  return at !== undefined && now - at <= HANDLED_MS;
}

/** Forget that `betId` was announced (the request that would have announced it failed). */
export function unmarkAnnounced(betId: string): void {
  handled.delete(betId);
}

/**
 * Runs `request`, whose answer the page announces itself, with `betId`
 * marked as announced from the start: the push about the same outcome can
 * arrive before the HTTP response (it trails the commit by as little as a few
 * milliseconds) and must not be toasted as well. When the request fails the
 * mark is cleared, so a push about the bet is shown after all (a timed-out
 * cash-out may still have gone through).
 */
export async function announcing<T>(betId: string, request: () => Promise<T>): Promise<T> {
  markAnnounced(betId);
  try {
    return await request();
  } catch (error) {
    unmarkAnnounced(betId);
    throw error;
  }
}
