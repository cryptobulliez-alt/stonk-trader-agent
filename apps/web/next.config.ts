import type { NextConfig } from "next";

const SHELL = process.env.SHELL_URL || "http://127.0.0.1:8788";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      // Regular API proxy. Live SSE connects to SHELL_URL directly (see page.tsx).
      { source: "/api/:path*", destination: `${SHELL}/api/:path*` },
    ];
  },
};

export default nextConfig;
