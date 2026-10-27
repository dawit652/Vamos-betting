import { NextResponse, type NextRequest } from 'next/server';
import { PUBLIC_API_URL } from '@/lib/api/config';
import { contentSecurityPolicy, newNonce } from '@/lib/csp';

/**
 * Sets the per-request Content Security Policy (src/lib/csp.ts) on every page:
 * on the request, where Next.js finds the nonce for its scripts, and on the
 * response. Every page renders dynamically (the root layout reads cookies), so
 * each one gets its own nonce.
 */
export function proxy(request: NextRequest): NextResponse {
  const policy = contentSecurityPolicy({
    nonce: newNonce(),
    apiUrl: PUBLIC_API_URL,
    dev: process.env.NODE_ENV === 'development',
  });
  const headers = new Headers(request.headers);
  headers.set('content-security-policy', policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('content-security-policy', policy);
  return response;
}

export const config = {
  matcher: [
    {
      // Not the build's static files, the icons, the service worker (it has its own policy) or
      // the manifest; link prefetches need no policy either.
      source: '/((?!_next/static|_next/image|icons/|favicon.ico|sw.js|manifest.webmanifest).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
