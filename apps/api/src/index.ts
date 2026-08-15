import { createApp } from "./app.ts";
import { env } from "./env.ts";
import { logger } from "./logger.ts";
import { closeDb } from "./db/client.ts";

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info(
    { port: env.PORT, env: env.NODE_ENV, database: Boolean(env.DATABASE_URL) },
    "api listening",
  );
});

/**
 * Container platforms send SIGTERM and then kill after a grace period. Stop
 * accepting connections, drain in-flight requests, close the pool.
 */
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "shutting down");
  server.close(async (err) => {
    if (err) logger.error({ err }, "error closing server");
    await closeDb();
    process.exit(err ? 1 : 0);
  });

  setTimeout(() => {
    logger.error("forced shutdown after timeout");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
