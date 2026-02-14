import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next.js 16 預設使用 Turbopack，設定空 turbopack config 避免警告
  turbopack: {},
};

export default nextConfig;
