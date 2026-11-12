import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Don't auto-generate AGENTS.md when `next dev` runs alongside an AI coding tool.
  agentRules: false,
};

export default nextConfig;
