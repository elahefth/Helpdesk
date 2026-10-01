import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { closeDb, getDb } from "./db/client.ts";
import { logger } from "./logger.ts";

/**
 * Applies the committed migrations in `apps/api/drizzle/` — the deploy-time
 * counterpart of `bun run db:migrate`, and what Railway's pre-deploy command
 * runs (see `railway.json`).
 *
 * Not drizzle-kit, for two reasons. drizzle-kit is a devDependency and the
 * production image installs without those; and `db:migrate` loads
 * `../../.env`, a file that only exists on a developer's machine. drizzle-orm's
 * own migrator reads the same folder and records progress in the same
 * `drizzle.__drizzle_migrations` table, so a database migrated by either is
 * current to both.
 *
 * pg-boss is not migrated here: it owns its `pgboss` schema and migrates it on
 * `start()`, which `index.ts` calls on every boot.
 *
 * Fails loudly and exits non-zero, which is the point of running it before the
 * deploy rather than at boot: a migration that cannot apply stops the release,
 * and the previous deployment keeps serving.
 */
const db = getDb();

if (!db) {
  logger.error("DATABASE_URL is not set — nothing to migrate");
  process.exit(1);
}

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

try {
  await migrate(db, { migrationsFolder });
  logger.info({ migrationsFolder }, "migrations applied");
} catch (err) {
  logger.error({ err }, "migration failed");
  await closeDb();
  process.exit(1);
}

await closeDb();
