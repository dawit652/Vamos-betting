import 'server-only';
import type { HealthResponse } from '@vamos/contracts';
import { cache } from 'react';
import { serverGet } from './server';

export type OperatingMode = HealthResponse['mode'];

/** The API's mode changes only with a restart: ask it at most once a minute. */
const TTL_MS = 60_000;
let known: { mode: OperatingMode; at: number } | null = null;

/**
 * The operating mode the API runs in (`GET /health`): `licensed` only when the API
 * itself started in licensed mode, which its guard refuses without a licence and
 * real providers (packages/config). The web app follows the API rather than a
 * build flag of its own, so the two cannot disagree.
 *
 * Fails safe: when the API cannot be asked, or answers anything else, this is
 * `demo` and the play-money notices stay up. Only answers are remembered.
 */
export const getOperatingMode = cache(async (): Promise<OperatingMode> => {
  if (known !== null && Date.now() - known.at < TTL_MS) return known.mode;
  try {
    const health = await serverGet<HealthResponse>('/health', { timeoutMs: 2_000 });
    const mode: OperatingMode = health.mode === 'licensed' ? 'licensed' : 'demo';
    known = { mode, at: Date.now() };
    return mode;
  } catch {
    return 'demo';
  }
});

/** True unless the API reports licensed mode (see getOperatingMode). */
export async function isDemoMode(): Promise<boolean> {
  return (await getOperatingMode()) !== 'licensed';
}
