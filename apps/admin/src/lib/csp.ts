/**
 * The Content Security Policy of the back office's pages (ASVS 14.4.3), set per
 * request by src/proxy.ts with a fresh nonce. Next.js reads the nonce from the
 * request's policy and puts it on its own scripts; `'strict-dynamic'` lets
 * those load the page's chunks. Nothing else may run: no inline or injected
 * script, no other origin, no plugins, no framing, and the page only talks to
 * itself and the API. Styles may be inline (React style attributes), which
 * carries far less risk than scripts.
 */
export interface CspOptions {
  /** A fresh random nonce for this response (newNonce). */
  nonce: string;
  /** The API's public URL (NEXT_PUBLIC_API_URL): fetch() and EventSource go there. */
  apiUrl: string;
  /** `next dev` needs eval for its error overlays; production never does. */
  dev: boolean;
}

export function contentSecurityPolicy({ nonce, apiUrl, dev }: CspOptions): string {
  const api = new URL(apiUrl);
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${api.origin}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    // Over https only: a plain-http local stack would have its API calls upgraded.
    ...(api.protocol === 'https:' ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}

/** 128 random bits, base64: a CSP nonce (Web Crypto, so it runs in any runtime). */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}
