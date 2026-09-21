import { and, asc, eq, isNull } from "drizzle-orm";
import {
  type Job,
  type PgBoss,
  type Queue,
  type SendOptions,
  type WorkOptions,
} from "pg-boss";
import type { TicketCategory } from "@helpdesk/shared";
import {
  createTicketClassifier,
  type ClassifyContext,
  type TicketClassifier,
} from "./ai/classify-ticket.ts";
import type { Database } from "./db/client.ts";
import { ticket } from "./db/schema.ts";
import { logger } from "./logger.ts";

/**
 * When the classifier runs, which is the whole of what "non-blocking" means
 * here.
 *
 * `POST /api/inbound-email` answers 201 the moment the row is written. A model
 * call takes seconds and can take a minute — see `TIMEOUT_MS` in
 * `ai/openrouter.ts` — and a mail provider's webhook is not a place to spend
 * that: a provider that times out retries, and a retry on an endpoint that is
 * slow because it is *working* produces a second delivery of mail that was
 * already accepted. So the request writes `classification: "pending"` and
 * returns, and the work happens out here.
 *
 * **The queue is pg-boss**, which is Postgres — the database this app already
 * has, with no broker to run beside it. That replaced an in-memory FIFO, and
 * what it bought is worth stating because each item was a real hole:
 *
 * - **Jobs survive the process.** A deploy or a crash mid-classification used
 *   to drop the work on the floor and wait for the next boot to notice.
 * - **Retries, with backoff.** The one failure that actually happens is a
 *   throttled free tier, and the honest answer to it is "ask again in a
 *   minute", which nothing in an in-memory pump could do. A ticket is only
 *   marked `failed` once pg-boss has exhausted `retryLimit` and dead-lettered
 *   the job — see `DEAD_LETTER_QUEUE`.
 * - **More than one process.** Dispatch is a row lock, so two API replicas
 *   share the work instead of both doing it.
 *
 * It owns its own `pgboss` schema and migrates it on `start()`, which makes it
 * the second migration system in this repo — drizzle-kit does not know about
 * it and must not be pointed at it. It is also the reason the connection is
 * pg-boss's own `pg` pool rather than the Bun `SQL` handle the rest of the app
 * uses: pg-boss can take a caller's driver (`db: { executeSql }`), but Bun's
 * driver cannot encode array parameters — `sql.unsafe("… $1::text[]", [["a"]])`
 * reaches Postgres as the string `a` and fails with `malformed array literal` —
 * and pg-boss binds arrays throughout. Two pools against one database is the
 * cheaper of the two prices.
 */

/** The queue tickets are classified on. */
export const CLASSIFY_QUEUE = "ticket-classification";

/**
 * Where a job goes once pg-boss has retried it as many times as it is going to.
 *
 * It exists because the handler cannot see its own retry count — a pg-boss
 * worker is handed `{ id, name, data, … }` and nothing about attempts — so
 * "throw and let it retry" and "give up and mark the ticket `failed`" cannot
 * both live in one function. Dead-lettering splits them: the main worker only
 * ever throws, and the *only* thing that writes `failed` is the worker on this
 * queue, which by definition runs once, after the last attempt.
 */
export const DEAD_LETTER_QUEUE = "ticket-classification-dead";

/** One job's payload. The ticket is re-read at run time; nothing else travels. */
export interface ClassificationJobData {
  ticketId: string;
}

/**
 * How the queue itself behaves.
 *
 * `short` is the policy that dedupes: it allows one job per `singletonKey`
 * *in the queued state*, so a second `send` for a ticket already waiting is
 * answered `null` instead of creating a duplicate. That is not a nicety —
 * `reconcile()` runs at every boot and sends for every ticket the table calls
 * `pending`, which is exactly the set that usually still has live jobs. Without
 * the dedupe, every restart would double the queue. (`singleton` was the
 * obvious-looking choice and is the wrong one: it serialises same-key jobs but
 * still creates them. `stately` dedupes too, and carries state semantics this
 * has no use for.)
 *
 * `notify` turns on Postgres LISTEN/NOTIFY for the queue, which with
 * `useListenNotify` on the instance is what keeps this feeling immediate:
 * measured at ~16ms from `send` to the handler, against a poll interval of
 * thirty seconds. Polling stays on underneath as the backstop for a dropped
 * listener.
 */
export const QUEUE_OPTIONS: Omit<Queue, "name"> = {
  policy: "short",
  notify: true,
  deadLetter: DEAD_LETTER_QUEUE,
};

/**
 * How one job behaves.
 *
 * `retryLimit` with backoff is the whole reason a throttled model is no longer
 * a `failed` ticket: `OPENROUTER_MODEL`'s chain handles a provider that is busy
 * *now*, and this handles a pool that is busy for the next few minutes.
 *
 * Know the ceiling before changing these, because it is longer than the numbers
 * suggest and it is visible: measured end to end against a model that fails
 * every time, three attempts at a 15s base took **~3.5 minutes** to exhaust and
 * reach the dead letter queue. The ticket reads "Classifying…" for all of it
 * and the SPA polls it every few seconds throughout. That is the deliberate
 * trade — a throttled pool usually recovers well inside that window, and the
 * alternative is marking a ticket `failed` on its first bad minute and handing
 * a human work the queue would have done.
 *
 * `expireInSeconds` must clear `ai/openrouter.ts`'s 60s deadline with room, or
 * pg-boss reclaims a job that is still legitimately waiting on a model and runs
 * it a second time. 120 is that, doubled.
 *
 * `singletonKey` is *not* here: it is the ticket id, so it is supplied per send.
 */
export const SEND_OPTIONS: SendOptions = {
  retryLimit: 3,
  retryDelay: 15,
  retryBackoff: true,
  expireInSeconds: 120,
};

/**
 * How the worker pulls.
 *
 * `batchSize: 1` is what keeps one process doing one model call at a time,
 * which is the same reasoning the in-memory pump carried: the thing on the
 * other end is a shared free-tier pool that throttles, and the only burst this
 * sees is a bulk replay, where fanning out turns every request into a 429. What
 * changed is that this is now a *per-process* limit rather than a global one —
 * scaling out is adding replicas, deliberately.
 *
 * The two intervals are the notify-on and notify-off cases. 30s is the relaxed
 * backstop for when NOTIFY is doing the work; 2s is what it falls back to if
 * the listener drops, and is still far below anything a person would notice on
 * a ticket that just arrived.
 */
export const WORK_OPTIONS: WorkOptions = {
  batchSize: 1,
  notifyPollingIntervalSeconds: 30,
  pollingIntervalSeconds: 2,
};

/** Everything the worker needs from a ticket, and nothing about how it is stored. */
export interface ClassificationJob extends ClassifyContext {
  id: string;
  /**
   * Carried through the job and written back unchanged — see `settle`. It is
   * here rather than fetched again at write time so the two statements are
   * talking about the same version of the row.
   */
  updatedAt: Date;
}

/**
 * The three things the worker does to the ticket table, behind an interface.
 *
 * A port rather than a `Database` handle passed around, for the reason
 * `isAuthorizedSource` and `searchPattern` are exported pure functions: the
 * interesting logic here — refusing to overwrite a human's decision, not
 * bumping the queue, telling a model failure from a write failure — is
 * unreachable in a test that cannot reach Postgres, and `bun run test` runs
 * with `DATABASE_URL` stripped precisely so it never can. With the SQL behind
 * this seam the worker is testable against a few lines of fake and the SQL is
 * four short statements in one place.
 */
export interface ClassificationStore {
  /**
   * The ticket, if it is still this worker's to classify.
   *
   * `undefined` covers every way a job goes stale between being queued and
   * being reached: a human set the category from the detail page, a human
   * explicitly cleared it (which is a decision too), or another replica got
   * there first. All of them mean the same thing — leave the row alone — so
   * they are one answer rather than three.
   */
  claim(ticketId: string): Promise<ClassificationJob | undefined>;
  /** Record what the model answered. `null` is "it declined to place this". */
  settle(
    job: ClassificationJob,
    category: TicketCategory | null,
  ): Promise<void>;
  /** Record that the model could not answer at all. */
  fail(job: ClassificationJob): Promise<void>;
  /** Every ticket the table still calls `pending`, oldest first. */
  pending(): Promise<string[]>;
}

/**
 * The real store.
 *
 * Two things in here are easy to get wrong and quiet, and both are about
 * writing to a row that the rest of the app is also writing to.
 *
 * **Every write is guarded on `classification = 'pending'` and a null
 * category**, not just on the id. Between a job being queued and the model
 * answering — seconds, or two minutes across a retry — an agent can open the
 * ticket and categorise it themselves. An unguarded UPDATE would then overwrite
 * a human's decision with a machine's, some time after they made it, with
 * nothing on screen to explain it. The guard makes that a no-op instead.
 *
 * **`updatedAt` is written back explicitly**, which looks redundant and is
 * not. The column carries `$onUpdate`, so leaving it out of `.set()` restamps
 * it with `now()` — and the queue's default sort is `updated_at desc`. A
 * reconciliation pass classifying a week-old backlog would silently drag all of
 * it to the top of everyone's queue, and a fresh ticket would jump above mail
 * that arrived after it. Classification is something that happened *to* the
 * record of a ticket, not activity on the ticket, so it does not count as a
 * touch. `dev/seed-tickets.ts` restates the column for the same reason.
 */
export function createClassificationStore(db: Database): ClassificationStore {
  /** The shared guard: this row, still pending, still unclassified. */
  const claimable = (ticketId: string) =>
    and(
      eq(ticket.id, ticketId),
      eq(ticket.classification, "pending"),
      isNull(ticket.category),
    );

  return {
    async claim(ticketId) {
      const [row] = await db
        .select({
          id: ticket.id,
          subject: ticket.subject,
          body: ticket.body,
          updatedAt: ticket.updatedAt,
        })
        .from(ticket)
        .where(claimable(ticketId))
        .limit(1);

      return row;
    },

    async settle(job, category) {
      await db
        .update(ticket)
        .set({
          category,
          classification: "done",
          updatedAt: job.updatedAt,
        })
        .where(claimable(job.id));
    },

    async fail(job) {
      await db
        .update(ticket)
        .set({ classification: "failed", updatedAt: job.updatedAt })
        .where(claimable(job.id));
    },

    async pending() {
      // Unbounded, and ordered oldest first so a backlog is worked in the order
      // it arrived. A cap would be a second, quieter way for a ticket to stay
      // pending forever: the rows past the limit would be skipped on every boot
      // and there would be nothing to say so.
      const rows = await db
        .select({ id: ticket.id })
        .from(ticket)
        .where(eq(ticket.classification, "pending"))
        .orderBy(asc(ticket.createdAt), asc(ticket.id));

      return rows.map((row) => row.id);
    },
  };
}

/**
 * What the two workers actually do, with no pg-boss in sight.
 *
 * Separated from the wiring below so it is testable: `bun run test` has no
 * database and no model, and it certainly has no job queue — but these two
 * functions are where every decision that can be wrong lives, and each of them
 * is wrong *silently*. Nothing here knows it is running inside a retry.
 */
export function createClassificationWorker(
  store: ClassificationStore,
  classify: TicketClassifier,
) {
  return {
    /**
     * One attempt at one ticket.
     *
     * **It throws, and that is the interface.** A thrown handler is how a job
     * tells pg-boss to retry it, so every transient failure — a throttled
     * model, a dropped connection, a write that did not land — is re-raised
     * rather than swallowed. The in-memory version had to decide, right here,
     * whether a failure was worth another go and had no way to act on the
     * answer; this one just reports what happened and lets the queue's
     * `retryLimit` be the policy. The ticket stays `pending` throughout, which
     * is true: it is still queued.
     *
     * Returning normally means *done with this ticket* — including the case
     * where there is nothing to do, which is not a failure and must not be
     * thrown, or a ticket a colleague categorised would be retried three times
     * and then marked `failed`.
     */
    async classify(ticketId: string): Promise<void> {
      const job = await store.claim(ticketId);

      // Somebody categorised it while this sat in the queue, or another replica
      // took it. Not a failure, and not worth a log line above debug.
      if (!job) {
        logger.debug({ ticketId }, "classification no longer needed");
        return;
      }

      const category = await classify(job);
      await store.settle(job, category);
      logger.info({ ticketId, category }, "classified ticket");
    },

    /**
     * The last word on a ticket pg-boss has given up on.
     *
     * Reached only from `DEAD_LETTER_QUEUE`, which is the only place that knows
     * the retries are spent. The row must stop being `pending` here, because
     * nothing will look at it again on its own — and a ticket that claims to be
     * queued when no queue holds it is the one state a reader cannot act on.
     *
     * It claims first rather than writing blind, so a ticket somebody
     * categorised during the two minutes of retries is left alone instead of
     * being stamped `failed` over the top of their decision.
     */
    async bury(ticketId: string): Promise<void> {
      const job = await store.claim(ticketId);
      if (!job) return;

      await store.fail(job);
      logger.warn({ ticketId }, "classification failed after every retry");
    },
  };
}

export interface ClassificationQueue {
  /**
   * Declare this feature's queues and start its workers on an already-running
   * pg-boss instance. Called once, by `ticket-jobs.ts`, which owns the
   * connection and the `start()`/`stop()` that go with it — there is one boss
   * per process and more than one feature riding on it.
   */
  register(): Promise<void>;
  /**
   * Hand a ticket over. Durable the moment it resolves — the job is a row in
   * Postgres, so it outlives this process.
   *
   * It rejects if pg-boss cannot be reached, and the ingestion route catches
   * that rather than failing the delivery: the ticket row already says
   * `pending`, and `reconcile()` is what turns that back into a job.
   */
  enqueue(ticketId: string): Promise<void>;
  /**
   * Put the ticket table and the job queue back in agreement, and say how many
   * tickets needed it.
   *
   * With a durable queue this is no longer crash recovery — pg-boss keeps its
   * own jobs, and retries the ones a dying process left `active` once they
   * expire. What it covers is the gap between the two writes: a ticket is
   * marked `pending` in its INSERT and the job is sent *after* the response, so
   * a process that dies in between, or a `send` that fails, leaves a row that
   * says "classifying…" with nothing queued behind it. Nothing else would ever
   * notice.
   *
   * Sending for a ticket that *does* still have a job is the ordinary case
   * here, not the exception, and it costs nothing: `short` + `singletonKey`
   * answers `null` rather than queueing a second.
   */
  reconcile(): Promise<number>;
}

/**
 * The pg-boss wiring: queues declared, workers registered, jobs sent.
 *
 * Takes its dependencies rather than building them, so the decision about
 * whether this feature exists at all lives in one place — see
 * `createTicketClassification` below.
 */
export function createClassificationQueue(
  boss: PgBoss,
  store: ClassificationStore,
  classify: TicketClassifier,
): ClassificationQueue {
  const worker = createClassificationWorker(store, classify);

  /**
   * pg-boss hands a worker an array even at `batchSize: 1`, and a throw fails
   * the whole batch. That is exactly right here — one ticket per job — and the
   * loop is written to survive somebody raising the batch size later without
   * silently classifying only the first of each batch.
   */
  const handle =
    (run: (ticketId: string) => Promise<void>) =>
    async (jobs: Job<ClassificationJobData>[]) => {
      for (const job of jobs) await run(job.data.ticketId);
    };

  async function enqueue(ticketId: string): Promise<void> {
    // `singletonKey` is the ticket, which is what the queue's `short` policy
    // dedupes on. A `null` return means a job for this ticket is already
    // waiting — the ordinary answer during `reconcile`, and not a failure.
    await boss.send(
      CLASSIFY_QUEUE,
      { ticketId },
      { ...SEND_OPTIONS, singletonKey: ticketId },
    );
  }

  return {
    enqueue,

    async register() {
      // The dead letter queue has to exist before the queue that names it, or
      // `createQueue` refuses the reference.
      await boss.createQueue(DEAD_LETTER_QUEUE);
      await boss.createQueue(CLASSIFY_QUEUE, QUEUE_OPTIONS);

      await boss.work<ClassificationJobData>(
        CLASSIFY_QUEUE,
        WORK_OPTIONS,
        handle(worker.classify),
      );

      // The dead letter worker only writes a column, so it needs none of the
      // main queue's pacing — and it must not inherit its `deadLetter`, or a
      // failure to mark a ticket failed would loop back into itself.
      await boss.work<ClassificationJobData>(
        DEAD_LETTER_QUEUE,
        { batchSize: 1 },
        handle(worker.bury),
      );

      logger.info(
        { queue: CLASSIFY_QUEUE, deadLetter: DEAD_LETTER_QUEUE },
        "ticket classification queue started",
      );
    },

    async reconcile() {
      const ids = await store.pending();
      for (const id of ids) await enqueue(id);
      return ids.length;
    },
  };
}

/**
 * The wiring, in one place because two entry points need the same answer:
 * `app.ts` hands the queue to the ingestion route, and `ticket-jobs.ts` starts
 * it and reconciles against it at boot.
 *
 * `undefined` when either half is missing — no database, or no model — which is
 * the `getDb()` / `createAuth(db)` / `createReplyPolisher()` shape this codebase
 * uses everywhere for a dependency the API is expected to boot without. Unlike
 * the polisher and the summariser there is no route to answer 503: ingestion
 * simply marks the ticket `skipped`, which is the honest record that nothing
 * was asked and nothing is coming.
 *
 * The pg-boss instance is a parameter rather than built here, which it used to
 * be. There are two background features now and they share one connection, one
 * `start()` and one `stop()` — see `ticket-jobs.ts`, which owns all three. Two
 * instances against one database would each migrate the same `pgboss` schema
 * and each hold their own pool for no gain.
 */
export function createTicketClassification(
  db: Database | undefined,
  boss: PgBoss,
): ClassificationQueue | undefined {
  const classify = createTicketClassifier();
  if (!db || !classify) return undefined;

  return createClassificationQueue(
    boss,
    createClassificationStore(db),
    classify,
  );
}
