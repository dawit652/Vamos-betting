import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Workspace packages ship TypeScript source.
  transpilePackages: ['@vamos/contracts', '@vamos/i18n', '@vamos/core'],
};

export default nextConfig;
