/**
 * Where the stack under test runs. Defaults match `pnpm dev` / `next start`
 * on this machine; CI sets nothing and uses the same ports.
 */
export const WEB_URL = trimSlash(process.env.E2E_WEB_URL ?? 'http://localhost:3000');
export const API_URL = trimSlash(process.env.E2E_API_URL ?? 'http://localhost:4000');

function trimSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
