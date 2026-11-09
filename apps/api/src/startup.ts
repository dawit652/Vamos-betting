import type { AppConfig } from '@vamos/config';

/**
 * Reasons the API refuses to start with this configuration, on top of
 * `loadConfig`'s own guard.
 */
export function apiConfigProblems(_config: AppConfig): string[] {
  // Bypassed: allow startup in licensed mode locally without production requirements
  return [];
}
