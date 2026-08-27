import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['postgres'],
  experimental: {
    // Tool executions can legitimately outlive the default budget.
    proxyTimeout: 120_000,
  },
};

export default nextConfig;
