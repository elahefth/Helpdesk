import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The E2E suite runs a second API on :3001 against the test database and points
// the dev server at it (e2e/playwright.config.ts). Everything else gets the
// dev default, so `bun run dev` is unchanged.
const apiTarget = process.env.API_PROXY_TARGET ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Mirrors the "@/*" path mapping in tsconfig.json, which shadcn/ui requires.
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  server: {
    port: 5173,
    /**
     * Fail rather than drift to the next free port.
     *
     * Vite's default is to take 5174 when 5173 is busy, and here that is not a
     * convenience — it is a broken app with a confusing error. The API pins
     * both its CORS allowlist and Better Auth's `trustedOrigins` to
     * `WEB_ORIGIN` (http://localhost:5173), and those compare the `Origin`
     * header as a string, so a browser served from :5174 has every sign-in
     * refused with **"Invalid origin"** — a message that points at auth
     * configuration when the actual fault is a second dev server someone
     * started and forgot. The page loads, the queue renders through the proxy,
     * and only logging in fails, which is what makes it hard to place.
     *
     * :5174 is also the E2E suite's own Vite port (e2e/playwright.config.ts),
     * so a drifted dev server sits exactly where the test server belongs.
     *
     * With this, the second `bun run dev:web` says "Port 5173 is already in
     * use" and exits, which is the true statement.
     */
    strictPort: true,
    // Proxying keeps the browser same-origin in dev, so session cookies
    // behave exactly as they will in production behind one hostname.
    proxy: {
      "/api": { target: apiTarget, changeOrigin: true },
      "/healthz": { target: apiTarget, changeOrigin: true },
      "/readyz": { target: apiTarget, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
