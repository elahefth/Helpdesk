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
