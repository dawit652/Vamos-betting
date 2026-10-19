import { DEV_SESSION_SECRET, type AppConfig } from '@vamos/config';

/**
 * Reasons the API refuses to start with this configuration, on top of
 * `loadConfig`'s own guard. Licensed (real-money) mode needs NODE_ENV=production
 * (Secure cookies, no dev inbox) and a unique SESSION_SECRET, which keys the
 * OTP and national-ID hashes.
 */
export function apiConfigProblems(config: AppConfig): string[] {
  const problems: string[] = [];
  if (config.mode === 'licensed') {
    if (config.nodeEnv !== 'production') {
      problems.push('NODE_ENV=production is required in licensed mode');
    }
    if (config.sessionSecret === DEV_SESSION_SECRET) {
      problems.push(
        'SESSION_SECRET must be set to a unique secret in licensed mode (it keys OTP and Fayda ID hashes)',
      );
    }
  }
  return problems;
}
