import { createApp } from "./app.ts";
import { env } from "./env.ts";
import { logger } from "./logger.ts";
import { closeDb, getDb } from "./db/client.ts";
import { createTicketJobs } from "./ticket-jobs.ts";

/**
 * Built here rather than left to `createApp` so this process can also start and
 * reconcile it below — the app needs somewhere to hand new tickets, and the
 * process needs to own the backlog, and those have to be the same queues.
 */
const jobs = createTicketJobs(getDb());

const app = createApp({ jobs });

const server = app.listen(env.PORT, () => {
  logger.info(
    {
      port: env.PORT,
      env: env.NODE_ENV,
      database: Boolean(env.DATABASE_URL),
      classification: Boolean(jobs?.classification),
      autoResolution: Boolean(jobs?.autoResolution),
    },
    "api listening",
  );
});

/**
 * Bring the background job queues up, then put them back in agreement with the
 * ticket table.
 *
 * Both halves live in `index.ts` and not in `createApp` on purpose. `createApp`
 * is a factory the test suite calls, and starting pg-boss there would mean
 * every `createApp()` in a test — or any future in-process use of the app —
 * connecting to a database, migrating a schema and registering workers.
 * Running the queue is a statement about being *the server process*, not about
 * having built an Express app.
 *
 * Deliberately not awaited before `listen`: `start()` migrates pg-boss's schema
 * and `reconcile()` reads every pending ticket, and neither is worth delaying
 * the port — and therefore a platform's health check — for. Until it resolves,
 * ingestion's `enqueue` fails and is caught, which leaves rows marked `pending`
 * that this very call is about to pick up.
 *
 * A failure is logged and dropped rather than crashing the process. The API
 * serves tickets, replies, users and auth without a classifier or an assistant;
 * refusing to boot because a background queue could not start would take all of
 * that down with it. Note what that costs while the queues are down: every
 * arriving ticket is marked `pending` and `handledBy=human` hides `pending`, so
 * the tickets are in the database and not in the queue until `reconcile()`
 * runs. That is the case the boot sweep exists for, and the reason it runs on
 * every start rather than only after an unclean one.
 */
void (async () => {
  if (!jobs) return;
  await jobs.start();
  await jobs.reconcile();
})().catch((err: unknown) => {
  logger.error({ err }, "could not start the ticket job queues");
});

/**
 * Container platforms send SIGTERM and then kill after a grace period. Stop
 * accepting connections, drain in-flight requests, close the pool.
 */
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "shutting down");
  server.close(async (err) => {
    if (err) logger.error({ err }, "error closing server");
    // Before `closeDb`, and tolerant of its own failure: a queue that will not
    // stop cleanly must not keep the process from closing its database handle.
    // Anything in flight is abandoned rather than waited for — the job returns
    // to `created` when it expires and runs again wherever the next process is.
    await jobs
      ?.stop()
      .catch((error: unknown) =>
        logger.error({ err: error }, "error stopping the ticket job queues"),
      );
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
