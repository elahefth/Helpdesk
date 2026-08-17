import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Component tests run under Vitest; `bun test` owns apps/api and packages, and
 * Playwright owns e2e/. The `include` glob below is what keeps the three runners
 * from collecting each other's files — the same reason the root `test` script
 * carries a path filter.
 *
 * Deliberately a separate file rather than a `test` block in vite.config.ts:
 * that config carries the API proxy and Tailwind, neither of which a component
 * test needs, and keeping them apart means a test run can never be steered by
 * API_PROXY_TARGET.
 */
export default defineConfig({
  plugins: [react()],
  // Mirrors the "@/*" mapping in tsconfig.json and vite.config.ts, which
  // shadcn/ui's generated imports require.
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.{ts,tsx}"],
    // Restores anything vi.stubGlobal replaced, so a test that swaps `fetch`
    // cannot leak it into the next one.
    unstubGlobals: true,
    restoreMocks: true,
  },
});
