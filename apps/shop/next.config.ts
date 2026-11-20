import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@vamos/contracts', '@vamos/core'],
  // Extra hosts allowed to load the dev server (a counter PC on the LAN), comma-separated.
  allowedDevOrigins: process.env.DEV_ALLOWED_ORIGINS?.split(',').filter(Boolean) ?? [],
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
