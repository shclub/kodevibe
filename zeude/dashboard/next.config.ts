import type { NextConfig } from "next";
import bundleAnalyzer from '@next/bundle-analyzer';

const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === 'true',
});

const nextConfig: NextConfig = {
  output: 'standalone',
  // Ensure standalone output goes to .next/standalone/server.js (not nested under workspace root)
  outputFileTracingRoot: process.cwd(),
  typescript: { ignoreBuildErrors: true },
  experimental: {
    optimizePackageImports: ['recharts', 'lucide-react'],
  },
};

export default withBundleAnalyzer(nextConfig);
