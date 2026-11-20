import { NextResponse, type NextRequest } from 'next/server';
import { API_URL } from '@/lib/config';
import { contentSecurityPolicy, newNonce } from '@/lib/csp';

/**
 * Sets the per-request Content Security Policy (src/lib/csp.ts) on every page:
 * on the request, where Next.js finds the nonce for its scripts, and on the
 * response. The root layout renders every page dynamically, so each one gets
 * its own nonce.
 */
export function proxy(request: NextRequest): NextResponse {
  const policy = contentSecurityPolicy({
    nonce: newNonce(),
    apiUrl: API_URL,
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
      // Not the build's static files; link prefetches need no policy either.
      source: '/((?!_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
