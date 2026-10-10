/**
 * Idempotency keys for unsafe requests the API deduplicates (bet placement,
 * demo top-up, deposits, withdrawals). The API accepts 8 to 100 printable
 * characters. Make ONE key per user intent and reuse it for every retry of that
 * intent (e.g. keep it in state until the bet is accepted), so a retry after a
 * timeout can never place a second bet.
 */
export function newIdempotencyKey(prefix = 'web'): string {
  const c = globalThis.crypto;
  // randomUUID needs a secure context; plain-http LAN testing on a phone has none.
  if (typeof c.randomUUID === 'function') {
    try {
      return `${prefix}-${c.randomUUID()}`;
    } catch {
      // fall through
    }
  }
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  return `${prefix}-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
