import postgres from "postgres";

/**
 * Direct database access for the Playwright suite.
 *
 * This is the one place in the repo that talks to Postgres over a driver other
 * than Bun's native `SQL` (apps/api/src/db/client.ts), and it is deliberate:
 * `playwright test` runs on Node, where `import { SQL } from "bun"` does not
 * exist. Anything here that genuinely needs the app's own code — migrations,
 * Better Auth's password hashing — is shelled out to a Bun subprocess in
 * global-setup.ts instead of being reimplemented.
 *
 * DATABASE_URL is not read from the environment: Playwright's process never
 * loads .env.test, and defaulting to whatever DATABASE_URL happens to be set is
 * exactly how a test suite ends up truncating a dev database.
 */
export const TEST_DATABASE_URL =
  "postgres://helpdesk:helpdesk@localhost:5433/helpdesk_test";

/** Auth tables. Wiping these would sign out the sessions auth.setup.ts minted. */
const AUTH_TABLES = ["user", "account", "session", "verification"];

/** Drizzle's bookkeeping. Truncating it would make the schema look unmigrated. */
const MIGRATIONS_TABLE = "__drizzle_migrations";

let sql: postgres.Sql | undefined;

function client(): postgres.Sql {
  sql ??= postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  return sql;
}

/**
 * Empties every table in the public schema except `exclude` (and Drizzle's
 * migration ledger).
 *
 * The table list is read from the catalog rather than hardcoded, so the Phase 5
 * ticket tables are covered the day they are created without an edit here.
 */
export async function truncateAll(exclude: string[] = []): Promise<string[]> {
  const db = client();
  const skip = new Set([MIGRATIONS_TABLE, ...exclude]);

  const rows = await db<{ tablename: string }[]>`
    select tablename from pg_tables where schemaname = 'public'
  `;

  const targets = rows.map((r) => r.tablename).filter((t) => !skip.has(t));
  if (targets.length === 0) return [];

  // One statement, because CASCADE across separate TRUNCATEs would fight the
  // foreign keys it is meant to satisfy. `db(targets)` quotes each identifier —
  // "user" is a reserved word and breaks unquoted.
  await db`truncate table ${db(targets)} restart identity cascade`;
  return targets;
}

/**
 * The one a test's `beforeEach` wants: clears application data but leaves the
 * seeded staff accounts and their sessions intact, so storageState keeps working.
 *
 * A no-op until the ticket tables land — schema.ts currently re-exports only the
 * auth tables. That is expected, not a bug.
 */
export function resetDomainData(): Promise<string[]> {
  return truncateAll(AUTH_TABLES);
}

/**
 * Deletes one session row, by token — what an admin revoking an agent will do
 * once that screen exists, and the reason auth.ts sets no `cookieCache`.
 *
 * Deliberately narrow: a broader "delete this user's sessions" would also take
 * out the storageState session the rest of the run depends on. Callers pass the
 * token of a session they minted themselves.
 */
export async function deleteSessionByToken(token: string): Promise<number> {
  const deleted = await client()`
    delete from "session" where token = ${token} returning id
  `;
  return deleted.length;
}

export async function closeTestDb(): Promise<void> {
  await sql?.end({ timeout: 5 });
  sql = undefined;
}
