import type { NextConfig } from 'next';

/**
 * Back office shared through a tunnel (other computers, phones): with API_PROXY_TARGET set
 * (e.g. http://127.0.0.1:4000), the browser calls the API through this origin at /_api, so
 * the back office works from whatever address it is opened at (http://localhost:3001 or
 * https://admin.example.com) and the staff cookie stays first-party. Off by default: the
 * production images call PUBLIC_API_URL directly.
 */
const apiProxyTarget = process.env.API_PROXY_TARGET;

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@vamos/contracts', '@vamos/core'],
  // Extra hosts allowed to load the dev server (the tunnel host, a phone on the LAN), comma-separated.
  allowedDevOrigins: process.env.DEV_ALLOWED_ORIGINS?.split(',').filter(Boolean) ?? [],
  env: apiProxyTarget ? { NEXT_PUBLIC_ADMIN_API_URL: '/_api' } : {},
  async rewrites() {
    return apiProxyTarget
      ? [{ source: '/_api/:path*', destination: `${apiProxyTarget}/:path*` }]
      : [];
  },
  async headers() {
    return [
      {
        // Every response; pages also get a per-request Content Security Policy (src/proxy.ts).
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // Browsers ignore it over plain http (a local stack).
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          {
            key: 'Permissions-Policy',
            value:
              'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()',
          },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
