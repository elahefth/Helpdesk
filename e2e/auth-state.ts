import path from "node:path";
import { fileURLToPath } from "node:url";
import type { E2ERole } from "./credentials.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Where auth.setup.ts parks each role's session cookie, for `storageState` to
 * pick up. Absolute so a test can reference them regardless of the working
 * directory Playwright happens to run it from. Gitignored — they are minted
 * fresh on every run.
 *
 * The `chromium` project defaults to `admin`. A test that needs a different
 * identity overrides it for its file:
 *
 *   test.use({ storageState: STORAGE_STATE.agent })       // agent
 *   test.use({ storageState: { cookies: [], origins: [] } })  // signed out
 */
export const STORAGE_STATE: Record<E2ERole, string> = {
  admin: path.join(here, "playwright/.auth/admin.json"),
  agent: path.join(here, "playwright/.auth/agent.json"),
};

/** For tests that must exercise the signed-out path (login, guard redirects). */
export const SIGNED_OUT = { cookies: [], origins: [] };
