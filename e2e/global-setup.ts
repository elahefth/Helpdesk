import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { E2E_ROLES, E2E_USERS } from "./credentials.ts";
import { closeTestDb, truncateAll } from "./fixtures/db.ts";

/**
 * Brings the test database to a known state once per run: migrate, wipe, seed.
 *
 * Pure database work, no HTTP — so it does not care whether Playwright has
 * started the `webServer` processes yet. Signing in happens later, in the
 * `setup` project, which by definition runs after the servers are up.
 *
 * The two `execFileSync` calls hand off to **Bun** on purpose. drizzle-kit and
 * seed.ts both need the Bun runtime, and seed.ts is the only supported way to
 * create an account at all: HTTP sign-up is closed by the databaseHooks gate in
 * apps/api/src/auth.ts, which fires on any request-bound call.
 */

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function bun(args: string[]): void {
  execFileSync("bun", args, { cwd: repoRoot, stdio: "inherit" });
}

export default async function globalSetup(): Promise<void> {
  bun(["run", "db:migrate:test"]);

  // Full wipe, auth tables included: the containers are ephemeral but not
  // necessarily restarted between runs, and stale sessions from a previous run
  // would outlive the storageState files that Playwright is about to overwrite.
  const truncated = await truncateAll();
  if (truncated.length > 0) {
    console.log(`[e2e] truncated: ${truncated.join(", ")}`);
  }
  await closeTestDb();

  for (const role of E2E_ROLES) {
    const user = E2E_USERS[role];
    bun([
      "run",
      "--filter=@helpdesk/api",
      "seed:test",
      "--",
      `--email=${user.email}`,
      `--password=${user.password}`,
      `--name=${user.name}`,
      `--role=${user.role}`,
    ]);
  }
}
