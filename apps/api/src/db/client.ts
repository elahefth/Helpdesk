import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { sql } from "drizzle-orm";
import { env } from "../env.ts";
import { logger } from "../logger.ts";
import * as schema from "./schema.ts";

/**
 * Uses Bun's native SQL client rather than node-postgres — one less
 * dependency and it's the driver Drizzle documents for Bun.
 *
 * The connection is lazy and optional: with no DATABASE_URL the API still
 * boots and /readyz reports `database: "down"`. That keeps `bun dev` useful
 * before Postgres is running.
 */

export type Database = ReturnType<typeof drizzle<typeof schema>>;

let client: SQL | undefined;
let database: Database | undefined;

export function getDb(): Database | undefined {
  if (!env.DATABASE_URL) return undefined;
  if (!database) {
    client = new SQL(env.DATABASE_URL);
    database = drizzle({ client, schema });
    logger.debug("database client initialised");
  }
  return database;
}

/** Cheap liveness probe used by /readyz. Never throws. */
export async function checkDatabase(): Promise<"up" | "down"> {
  const db = getDb();
  if (!db) return "down";
  try {
    await db.execute(sql`select 1`);
    return "up";
  } catch (error) {
    logger.warn({ error }, "database health check failed");
    return "down";
  }
}

export async function closeDb(): Promise<void> {
  await client?.close();
  client = undefined;
  database = undefined;
}
