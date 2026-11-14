import 'server-only';
import type { HealthResponse } from '@vamos/contracts';
import { cache } from 'react';
import { modeFromHealth, type OperatingMode } from './mode-state';
import { serverGet } from './server';

/**
 * The platform's operating mode, as the API itself reports it (GET /health):
 * `demo` (play money) or `licensed` (real money). The API is the only place
 * where licensed mode can be switched on (its start-up guard checks every
 * compliance prerequisite), so the web app asks it instead of having a setting
 * of its own that could disagree.
 *
 * The shell shows the play-money notice in demo mode and drops it in licensed
 * mode. The answer is kept for a minute; while the API cannot be reached the
 * last answer stands, and before any answer the mode is `demo`, the default.
 */

const KEEP_MS = 60_000;
const TIMEOUT_MS = 2_000;

let known: { mode: OperatingMode; at: number } | null = null;

export const getOperatingMode = cache(async (): Promise<OperatingMode> => {
  if (known !== null && Date.now() - known.at < KEEP_MS) return known.mode;
  try {
    const mode = modeFromHealth(
      await serverGet<HealthResponse>('/health', { timeoutMs: TIMEOUT_MS }),
    );
    if (mode !== null) known = { mode, at: Date.now() };
  } catch {
    // The API is down or slow: the page still renders, with the last known mode.
  }
  return known?.mode ?? 'demo';
});

/** True while balances are play money: the shell then shows the DEMO notice and badge. */
export async function isDemoMode(): Promise<boolean> {
  return (await getOperatingMode()) === 'demo';
}
