import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": new URL("./src", import.meta.url).pathname },
  },
  test: {
    // HTTP files start real Next/Pi processes, and the dev fixture compiles Next.
    // Run files serially to avoid exhausting small CI and home-server hosts.
    // Concurrency within each behavioral scenario is still exercised.
    fileParallelism: false,
    include: ["tests/**/*.test.{ts,tsx}"],
    testTimeout: 15_000,
    hookTimeout: 120_000,
  },
});
