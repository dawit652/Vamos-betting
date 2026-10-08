import { isIP } from 'node:net';
import { DEV_SESSION_SECRET, type AppConfig } from '@vamos/config';

/** Fastify `trustProxy`: false, or the addresses / CIDRs of the trusted proxies. */
export type TrustProxySetting = false | string[];

/** A setting the API cannot start with. */
export class StartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartupError';
  }
}

/** Address ranges proxy-addr knows by name. */
const NAMED_RANGES = new Set(['loopback', 'linklocal', 'uniquelocal']);

function isAddressOrCidr(value: string): boolean {
  if (NAMED_RANGES.has(value)) return true;
  const [address = '', prefix, ...rest] = value.split('/');
  const version = isIP(address);
  if (version === 0 || rest.length > 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (version === 4 ? 32 : 128);
}

/**
 * Parses TRUST_PROXY, which says whose X-Forwarded-For may set `request.ip`
 * (used for rate limits, sessions and the audit log):
 * - unset, empty, `false` or `0`: nobody. `request.ip` is the TCP peer.
 * - a comma-separated list of the proxies' addresses or CIDRs (or
 *   `loopback`, `linklocal`, `uniquelocal`), e.g. `10.0.0.0/8` for the load
 *   balancer subnet. X-Forwarded-For is then read right to left, skipping
 *   those proxies.
 *
 * `true` is refused: it would trust every hop, so any client could choose its
 * own address and escape every per-address limit. A hop count is refused too,
 * because it cannot check who the immediate peer is (Fastify ignores it).
 */
export function parseTrustProxy(value: string | undefined): TrustProxySetting {
  const text = value?.trim() ?? '';
  if (text === '' || text === 'false' || text === '0') return false;
  if (text === 'true' || /^\d+$/.test(text)) {
    throw new StartupError(
      `TRUST_PROXY=${text} cannot tell a proxy from a client that sends X-Forwarded-For itself. ` +
        'List the addresses or CIDRs of the proxies in front of the API instead (e.g. 10.0.0.0/8).',
    );
  }
  const entries = text
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const invalid = entries.filter((entry) => !isAddressOrCidr(entry));
  if (entries.length === 0 || invalid.length > 0) {
    throw new StartupError(
      `TRUST_PROXY must be false, a hop count or proxy addresses/CIDRs (invalid: ${invalid.join(', ') || text})`,
    );
  }
  return entries;
}

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
