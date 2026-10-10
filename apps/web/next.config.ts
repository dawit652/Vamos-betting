import type { NextConfig } from 'next';

/** Browser-visible API base URL, inlined at build time. Defaults to the local API. */
const publicApiUrl =
  process.env.NEXT_PUBLIC_API_URL || process.env.PUBLIC_API_URL || 'http://localhost:4000';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // server.mjs (the production server) compresses with brotli itself; plain
  // `next start` (e.g. behind a CDN) keeps Next's gzip.
  compress: process.env.VAMOS_WEB_COMPRESSION !== 'server',
  // Workspace packages ship TypeScript source.
  transpilePackages: ['@vamos/contracts', '@vamos/i18n', '@vamos/core'],
  env: {
    NEXT_PUBLIC_API_URL: publicApiUrl,
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
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
