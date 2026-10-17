import { USER_CHANNEL_PREFIX, userChannel } from '@vamos/contracts';
import type { AppDeps } from '../../deps';

/**
 * Control messages of the API on a player's push channel (`vamos:user:<id>`),
 * next to the worker's UserMessage envelopes. Every API instance's UserHub
 * reads them and never relays them to a client (they are not UserMessages).
 *
 * `session.revoked`: a session of the player was revoked (log out), or every
 * session (`sessionId: null`: password reset, self-exclusion, suspension).
 * The hubs end the matching /me/stream streams at once; the client's
 * reconnect then gets a 401. Without it a stream would only end at its next
 * periodic session check.
 */
export const SESSION_REVOKED = 'session.revoked';

export interface SessionRevoked {
  type: typeof SESSION_REVOKED;
  data: { sessionId: string | null };
}

/** The control message in a parsed channel payload, or null when it is something else. */
export function sessionRevokedOf(json: unknown): SessionRevoked | null {
  if (typeof json !== 'object' || json === null) return null;
  const { type, data } = json as { type?: unknown; data?: unknown };
  if (type !== SESSION_REVOKED || typeof data !== 'object' || data === null) return null;
  const { sessionId } = data as { sessionId?: unknown };
  if (sessionId !== null && typeof sessionId !== 'string') return null;
  return { type: SESSION_REVOKED, data: { sessionId } };
}

/**
 * Tells every API instance that a session of `userId` (or, with `sessionId`
 * null, every session) was revoked. Call it after the revoking transaction
 * has committed: a stream ended earlier could reconnect with the session
 * still valid. Best effort: a failed publish is left to the periodic session
 * check of the streams (SESSION_RECHECK_MS) and never fails the request.
 */
export async function announceSessionRevoked(
  deps: Pick<AppDeps, 'redis' | 'userChannelPrefix'>,
  userId: string,
  sessionId: string | null,
): Promise<void> {
  const message: SessionRevoked = { type: SESSION_REVOKED, data: { sessionId } };
  try {
    await deps.redis.publish(
      userChannel(userId, deps.userChannelPrefix ?? USER_CHANNEL_PREFIX),
      JSON.stringify(message),
    );
  } catch {
    // The periodic session check ends the streams.
  }
}
