import { createApp } from "./app.ts";
import { env } from "./env.ts";
import { logger } from "./logger.ts";
import { closeDb, getDb } from "./db/client.ts";
import { createTicketClassification } from "./ticket-classification.ts";

/**
 * Built here rather than left to `createApp` so this process can also call
 * `resume()` on it below — the app needs somewhere to hand new tickets, and the
 * process needs to own the backlog, and those have to be the same queue.
 */
const classification = createTicketClassification(getDb());

const app = createApp({ classification });

const server = app.listen(env.PORT, () => {
  logger.info(
    {
      port: env.PORT,
      env: env.NODE_ENV,
      database: Boolean(env.DATABASE_URL),
      classification: Boolean(classification),
    },
    "api listening",
  );
});

/**
 * Pick up whatever the last process left half-done.
 *
 * The classification queue is in memory, so a restart — a deploy, a crash, a
 * Ctrl-C during `bun run dev` — drops every job it was holding. What survives
 * is the `classification = 'pending'` on the rows themselves, which is why
 * ingestion writes it in the INSERT: those rows are the queue's durable half,
 * and this is the one read that turns them back into work.
 *
 * It lives in `index.ts` and not in `createApp` on purpose. `createApp` is a
 * factory the test suite calls, and a sweep firing there would mean every
 * `createApp()` in a test — or any future in-process use of the app — quietly
 * claiming a production backlog. Owning the backlog is a statement about being
 * *the server process*, not about having built an Express app.
 *
 * Deliberately not awaited before `listen`: a slow query here would delay the
 * port opening, and an old ticket waiting a few more seconds for a category is
 * not worth a health check failing over. A failure is logged and dropped — the
 * rows stay pending, and the next boot tries again.
 */
void classification
  ?.resume()
  .then((count) => {
    if (count > 0) logger.info({ count }, "resumed pending classifications");
  })
  .catch((err: unknown) => {
    logger.error({ err }, "could not resume pending classifications");
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
