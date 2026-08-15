import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Proxying keeps the browser same-origin in dev, so session cookies
    // behave exactly as they will in production behind one hostname.
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: true },
      "/healthz": { target: "http://localhost:3000", changeOrigin: true },
      "/readyz": { target: "http://localhost:3000", changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
