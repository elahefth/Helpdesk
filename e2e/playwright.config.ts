import { defineConfig, devices } from "@playwright/test";
import { STORAGE_STATE } from "./auth-state.ts";

/**
 * E2E against the real stack: Express + Better Auth + Postgres + the SPA behind
 * Vite's proxy. Distinct from apps/api/src/app.test.ts, which stubs auth and runs
 * with no database at all.
 *
 * Ports are deliberately not the dev ones, so a running `bun run dev` neither
 * collides with a suite run nor gets mistaken for one.
 */
const API_PORT = 3001;
const WEB_PORT = 5174;

/**
 * Must equal WEB_ORIGIN in .env.test verbatim. That value feeds both the CORS
 * allowlist and Better Auth's trustedOrigins, and both compare the browser's
 * Origin header as a string — "127.0.0.1" here would fail against "localhost".
 */
const baseURL = `http://localhost:${WEB_PORT}`;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,

  /**
   * One worker, everywhere. All workers would share the single test database,
   * so a `resetDomainData()` in one would pull the rug from under another.
   * Raising this means giving each worker its own schema or database — a real
   * change, not a flag flip.
   */
  workers: 1,

  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],

  // Migrate, wipe, seed. Database only — no HTTP, so it is indifferent to
  // whether the webServer processes below have finished booting.
  globalSetup: "./global-setup.ts",

  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  projects: [
    // Produces the storageState files the project below consumes.
    // Its own testDir: auth.setup.ts lives beside this config, not in tests/,
    // and a project inherits the top-level testDir otherwise — which would
    // silently match nothing and leave every storageState file unwritten.
    { name: "setup", testDir: ".", testMatch: /.*\.setup\.ts/ },
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Admin by default — the widest role, so most tests need no override.
        // For anything else, see the note in auth-state.ts.
        storageState: STORAGE_STATE.admin,
      },
      dependencies: ["setup"],
    },
  ],

  webServer: [
    {
      // --env-file, not the ambient environment: this points the API at the
      // :5433 test container, and nothing else must be able to change that.
      command: "bun --env-file=../../.env.test src/index.ts",
      cwd: "../apps/api",
      url: `http://localhost:${API_PORT}/healthz`,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    },
    {
      // --strictPort so a port clash fails loudly instead of Vite quietly
      // moving to 5175 and leaving baseURL pointing at nothing.
      command: `bun run dev --port ${WEB_PORT} --strictPort`,
      cwd: "../apps/web",
      env: { API_PROXY_TARGET: `http://localhost:${API_PORT}` },
      url: baseURL,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000,
    },
  ],
});
