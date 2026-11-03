import type { NextConfig } from 'next';

/** Browser-visible API base URL, inlined at build time. Defaults to the local API. */
const publicApiUrl =
  process.env.NEXT_PUBLIC_API_URL || process.env.PUBLIC_API_URL || 'http://localhost:4000';

/**
 * Security headers of every response (ASVS 14.4): no MIME sniffing, no framing,
 * HTTPS only for a year (browsers ignore it over plain http, as on a local
 * stack), no powerful browser features, and no window shared with other origins.
 */
const SECURITY_HEADERS = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()',
  },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Extra hosts allowed to load the dev server (e.g. a phone on the LAN), comma-separated.
  allowedDevOrigins: process.env.DEV_ALLOWED_ORIGINS?.split(',').filter(Boolean) ?? [],
  // server.mjs (the production server) compresses with brotli itself; plain
  // `next start` (e.g. behind a CDN) keeps Next's gzip.
  compress: process.env.VAMOS_WEB_COMPRESSION !== 'server',
  // Workspace packages ship TypeScript source.
  transpilePackages: ['@vamos/contracts', '@vamos/i18n', '@vamos/core'],
  env: {
    NEXT_PUBLIC_API_URL: publicApiUrl,
  },
  // Demo sharing through a single public tunnel: with API_PROXY_TARGET set (e.g.
  // http://127.0.0.1:4000), the browser calls the API through this origin at /_api, so the
  // session cookie stays same-site. Off by default.
  async rewrites() {
    const target = process.env.API_PROXY_TARGET;
    return target ? [{ source: '/_api/:path*', destination: `${target}/:path*` }] : [];
  },
  async headers() {
    return [
      {
        // Every response; pages also get a per-request Content Security Policy (src/proxy.ts).
        source: '/:path*',
        headers: SECURITY_HEADERS,
      },
      {
        // The service worker must always be revalidated so updates roll out.
        source: '/sw.js',
        headers: [
          { key: 'Content-Type', value: 'application/javascript; charset=utf-8' },
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Content-Security-Policy', value: "default-src 'self'; script-src 'self'" },
        ],
      },
      {
        source: '/manifest.webmanifest',
        headers: [{ key: 'Content-Type', value: 'application/manifest+json' }],
      },
    ];
  },
};

export default nextConfig;
