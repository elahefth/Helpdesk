import { PgBoss } from "pg-boss";
import type { Database } from "./db/client.ts";
import { env } from "./env.ts";
import { logger } from "./logger.ts";
import {
  createTicketAutoResolution,
  type AutoResolutionQueue,
} from "./ticket-auto-resolution.ts";
import {
  createTicketClassification,
  type ClassificationQueue,
} from "./ticket-classification.ts";

/**
 * The background work a newly arrived ticket sets off, and the one pg-boss
 * instance it all runs on.
 *
 * This exists because there are two such features now. Classification owned the
 * connection while it was the only one; a second instance for the resolver
 * would have meant two pools against one database, both migrating the same
 * `pgboss` schema on boot and racing each other to do it. So the connection,
 * the `start()` that migrates, the error listener and the `stop()` live here,
 * and each feature contributes only its own queues, workers and jobs through
 * `register()`.
 *
 * The two are deliberately **separate queues rather than two steps of one job**,
 * and that is the design decision worth knowing. They ask different questions
 * of different prompts, they fail independently, and — the part that settles
 * it — a retry policy cannot be shared: a classification that succeeded must
 * not be re-run because the resolver was throttled, and a resolver that has not
 * run yet must not be skipped because the classifier gave up. Two queues means
 * two `singletonKey`s, two dead letter queues and two columns on the row, each
 * telling the truth about its own half.
 *
 * They run concurrently on a ticket, which is safe because they write different
 * columns and neither reads the other's. Nothing orders them: the category a
 * ticket ends up in has no bearing on whether the knowledge base answers it.
 */

export interface TicketJobs {
  /** Where ingestion sends a ticket to be categorised. Absent if unconfigured. */
  classification: ClassificationQueue | undefined;
  /** Where ingestion sends a ticket to be answered. Absent if unconfigured. */
  autoResolution: AutoResolutionQueue | undefined;
  /**
   * Connect, migrate pg-boss's schema, then let each feature declare its queues
   * and start its workers. Called once, from `index.ts`.
   */
  start(): Promise<void>;
  /**
   * Put the ticket table and the job queues back in agreement, and say how many
   * tickets needed it.
   *
   * It covers the gap between two writes that are deliberately not atomic: a
   * ticket is marked `pending` in its INSERT and the jobs are sent *after* the
   * response, so a process that dies in between — or a `send` that fails —
   * leaves a row claiming work nothing is queued to do. For classification that
   * is a category that never fills in; for auto-resolution it is worse, because
   * `pending` is what the queue hides, so the ticket is missing from everyone's
   * list until this finds it.
   */
  reconcile(): Promise<void>;
  /** Stop the workers and close the pool. */
  stop(): Promise<void>;
}

/**
 * `undefined` when there is no database, which is the one thing both features
 * need and the reason neither can run without it. Each half is then separately
 * absent if *its* model or knowledge base is not configured — so an install
 * with a key and no `knowledge-base.md` classifies and does not auto-resolve,
 * which is a coherent state rather than a half-broken one.
 *
 * Returning `undefined` for the whole thing when unconfigured is also what
 * keeps pg-boss out of the test and E2E databases, neither of which sets a
 * model key — so no `pgboss` schema is ever created there.
 */
export function createTicketJobs(
  db: Database | undefined,
): TicketJobs | undefined {
  // `db` exists only when DATABASE_URL does, so the check below is the type
  // system catching up with that rather than an assumption.
  if (!db || !env.DATABASE_URL) return undefined;

  const boss = new PgBoss({
    connectionString: env.DATABASE_URL,
    // Its own small pool, separate from the app's Bun `SQL` handle — Bun's
    // driver cannot encode the array parameters pg-boss binds throughout. See
    // the note at the top of `ticket-classification.ts`. Small because it
    // carries maintenance, four workers and the occasional send, none of which
    // is concurrent with itself.
    max: 2,
    // Turns on the instance-level LISTEN connection that `notify: true` on each
    // queue needs. Without it those flags are inert and dispatch silently falls
    // back to polling.
    useListenNotify: true,
  });

  const classification = createTicketClassification(db, boss);
  const autoResolution = createTicketAutoResolution(db, boss);

  // Nothing to run. Returning the object anyway would connect a pool and
  // migrate a schema for two features that are both switched off.
  if (!classification && !autoResolution) return undefined;

  return {
    classification,
    autoResolution,

    async start() {
      // Required: pg-boss emits maintenance and connection failures here, and
      // an EventEmitter with no `error` listener throws on the process.
      boss.on("error", (error) => {
        logger.error({ err: error }, "pg-boss error");
      });

      await boss.start();

      await classification?.register();
      await autoResolution?.register();
    },

    async reconcile() {
      const classified = (await classification?.reconcile()) ?? 0;
      if (classified > 0) {
        logger.info(
          { count: classified },
          "re-queued tickets still awaiting classification",
        );
      }

      const resolving = (await autoResolution?.reconcile()) ?? 0;
      if (resolving > 0) {
        logger.info(
          { count: resolving },
          "re-queued tickets still awaiting auto-resolution",
        );
      }
    },

    async stop() {
      // Ungraceful on purpose. A model call is allowed sixty seconds and
      // `index.ts` force-exits after ten, so waiting for in-flight work would
      // just be waiting for the kill — and it is precisely what the durable
      // queue makes unnecessary: an abandoned job goes back to `created` when
      // `expireInSeconds` lapses and runs again on whichever process is up.
      await boss.stop({ graceful: false });
    },
  };
}
