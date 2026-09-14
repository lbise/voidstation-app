import type { NextConfig } from "next";

const networkDevelopment = process.env.NODE_ENV === "development" && process.env.VOIDSTATION_DEV_NETWORK === "1";
const testTurbopackRoot = networkDevelopment && process.env.VOIDSTATION_DEV_TEST_TURBOPACK_ROOT;

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  ...(networkDevelopment ? { distDir: ".next-network" } : {}),
  ...(testTurbopackRoot ? { turbopack: { root: testTurbopackRoot } } : {}),
};

export default nextConfig;
