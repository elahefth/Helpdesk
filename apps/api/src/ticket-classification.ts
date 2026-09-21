import { and, asc, eq, isNull } from "drizzle-orm";
import type { TicketCategory } from "@helpdesk/shared";
import {
  createTicketClassifier,
  type ClassifyContext,
  type TicketClassifier,
} from "./ai/classify-ticket.ts";
import { ModelError } from "./ai/openrouter.ts";
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
 * returns, and the work happens here, after the response, in this process.
 *
 * **In-process and in-memory, deliberately, and the limits are worth knowing
 * before relying on it.** There is no Redis, no outbox table and no worker
 * process in this repo, and introducing one for a single model call per email
 * would be infrastructure bought against a load nobody has. What stands in for
 * durability is that the *state* is in Postgres even though the queue is not:
 * a row is `pending` from the moment it exists, so a process that dies
 * mid-flight leaves a true fact behind rather than a lost job, and `resume()`
 * on the next boot picks it up. What is genuinely given up is ordering across
 * a restart and exactly-once across replicas — two API processes sharing a
 * database can both classify the same ticket, which costs one wasted model
 * call and writes the same value twice. An outbox with `SELECT … FOR UPDATE
 * SKIP LOCKED` is the shape that fixes it, and the day this runs on more than
 * one process is the day it is worth it.
 *
 * **One at a time.** Concurrency is 1 because the thing on the other end is a
 * shared free-tier pool that throttles (the reason `OPENROUTER_MODEL` is a
 * chain at all), and because the only burst this ever sees is a bulk replay —
 * `bun run seed:tickets` or a provider flushing a backlog — where fanning out
 * would turn every request into a 429 and every ticket into `failed`. Serial,
 * the backlog simply takes as long as it takes, and nothing in front of it is
 * waiting.
 */

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
 * The three things the worker does to the database, behind an interface.
 *
 * A port rather than a `Database` handle passed around, for the reason
 * `isAuthorizedSource` and `searchPattern` are exported pure functions: the
 * interesting logic here — refusing to overwrite a human's decision, not
 * bumping the queue, telling a model failure from a write failure — is
 * unreachable in a test that cannot reach Postgres, and `bun run test` runs
 * with `DATABASE_URL` stripped precisely so it never can. With the SQL behind
 * this seam the pump is testable against a few lines of fake and the SQL is
 * four short statements in one place.
 */
export interface ClassificationStore {
  /**
   * The ticket, if it is still this worker's to classify.
   *
   * `undefined` covers every way a job goes stale between being queued and
   * being reached: a human set the category from the detail page, a human
   * explicitly cleared it (which is a decision too), or another process got
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
  /** Every ticket left `pending` by a previous process, oldest first. */
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
 * answering — seconds, or a minute on a throttled chain — an agent can open
 * the ticket and categorise it themselves. An unguarded UPDATE would then
 * overwrite a human's decision with a machine's, some time after they made it,
 * with nothing on screen to explain it. The guard makes that a no-op instead.
 *
 * **`updatedAt` is written back explicitly**, which looks redundant and is
 * not. The column carries `$onUpdate`, so leaving it out of `.set()` restamps
 * it with `now()` — and the queue's default sort is `updated_at desc`. A boot
 * sweep classifying a week-old backlog would silently drag all of it to the
 * top of everyone's queue, and a fresh ticket would jump above mail that
 * arrived after it. Classification is something that happened *to* the record
 * of a ticket, not activity on the ticket, so it does not count as a touch.
 * `dev/seed-tickets.ts` restates the column for the same reason.
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

export interface ClassificationQueue {
  /**
   * Hand a ticket over. Returns immediately, always — it pushes an id onto an
   * array and schedules a microtask, and never touches the network or the
   * database on the caller's stack. That is the contract the ingestion route
   * depends on, which is why it returns `void` rather than a promise: a promise
   * is something a caller can be tempted to await.
   */
  enqueue(ticketId: string): void;
  /**
   * Re-queue everything a previous process left pending, and say how many.
   *
   * Called once from `index.ts` on boot and never from `createApp`, which is
   * the boundary that keeps it out of the test suite and out of any future
   * in-process use of the app: it is a statement about this *process* owning
   * the backlog, not about an Express app existing.
   */
  resume(): Promise<number>;
  /**
   * Resolves when the queue has nothing left to do.
   *
   * A test seam. Nothing in the running app waits for this — shutdown
   * deliberately does not, since a ticket left `pending` by a SIGTERM is
   * recovered by `resume()` on the next boot, and holding a container's
   * shutdown open for a minute-long model call is a worse trade than
   * classifying that ticket a little later.
   */
  drained(): Promise<void>;
}

/**
 * The pump: a FIFO of ticket ids and one worker walking it.
 *
 * Takes its two dependencies rather than building them, so a test can drive the
 * real logic with a fake store and a fake model, and so the decision about
 * whether this feature exists at all lives in one place — see
 * `createTicketClassification` below.
 */
export function createClassificationQueue(
  store: ClassificationStore,
  classify: TicketClassifier,
): ClassificationQueue {
  const waiting: string[] = [];
  /**
   * Every ticket this process is dealing with — waiting *or* in flight.
   *
   * A provider retrying a webhook is the ordinary case (it is why
   * `source_message_id` is unique), and a boot sweep overlapping live ingestion
   * is the other: `resume()` reads every row that is still `pending`, and a
   * ticket being classified right now is one of them, because the worker has
   * not written its answer yet. Dropping an id from here when it comes *off*
   * the queue rather than when its job *ends* leaves exactly that window open,
   * and the cost is a second model call whose answer the guarded UPDATE throws
   * away.
   */
  const queued = new Set<string>();
  let running: Promise<void> | undefined;

  async function work(ticketId: string): Promise<void> {
    let job: ClassificationJob | undefined;
    try {
      job = await store.claim(ticketId);
    } catch (error) {
      // The row is still `pending`, which is the truth, and `resume()` will
      // find it on the next boot. Deliberately not marked failed: nothing was
      // asked of the model, and "failed" would close a job that never started.
      logger.error(
        { err: error, ticketId },
        "could not claim a ticket to classify",
      );
      return;
    }

    // Somebody categorised it while this sat in the queue, or another process
    // took it. Not a failure and not worth a log line above debug.
    if (!job) {
      logger.debug({ ticketId }, "classification no longer needed");
      return;
    }

    let category: TicketCategory | null;
    try {
      category = await classify(job);
    } catch (error) {
      // A ModelError is the provider having a bad day — throttled, unreachable,
      // or answering with something that is not a category — and its message is
      // written to be read. Anything else is a bug in this codebase and gets
      // the louder level. Either way the ticket stops being pending: nothing
      // will look at it again on its own, and a row that claims to be queued
      // when it is not is the one state a reader cannot act on.
      if (error instanceof ModelError) {
        logger.warn({ err: error, ticketId }, "ticket classification failed");
      } else {
        logger.error({ err: error, ticketId }, "ticket classification threw");
      }
      await store
        .fail(job)
        .catch((err: unknown) =>
          logger.error(
            { err, ticketId },
            "could not mark a classification failed",
          ),
        );
      return;
    }

    try {
      await store.settle(job, category);
      logger.info({ ticketId, category }, "classified ticket");
    } catch (error) {
      // The model answered and the write did not land, so the row is still
      // `pending` and the next boot re-asks. Costing a second model call is the
      // right side of this trade — the alternative is losing the answer with no
      // trace that there ever was one.
      logger.error(
        { err: error, ticketId },
        "could not record a classification",
      );
    }
  }

  async function pump(): Promise<void> {
    for (;;) {
      const ticketId = waiting.shift();
      if (ticketId === undefined) return;
      try {
        // Serial by construction: the next id is not taken until this one is
        // finished. See the note at the top of the file for why.
        await work(ticketId);
      } finally {
        // After the job, not before it — see `queued` above.
        queued.delete(ticketId);
      }
    }
  }

  function start(): void {
    if (running) return;
    // Through a resolved promise rather than called directly, so `enqueue`
    // returns to its caller before any of this runs. The caller is an Express
    // handler that has just answered 201, and the point of the whole file is
    // that none of this appears in that request.
    running = Promise.resolve()
      .then(pump)
      .finally(() => {
        running = undefined;
      });
  }

  return {
    enqueue(ticketId) {
      if (queued.has(ticketId)) return;
      queued.add(ticketId);
      waiting.push(ticketId);
      start();
    },

    async resume() {
      const ids = await store.pending();
      for (const id of ids) {
        if (queued.has(id)) continue;
        queued.add(id);
        waiting.push(id);
      }
      if (ids.length > 0) start();
      return ids.length;
    },

    drained() {
      return running ?? Promise.resolve();
    },
  };
}

/**
 * The wiring, in one place because two entry points need the same answer:
 * `app.ts` hands the queue to the ingestion route, and `index.ts` calls
 * `resume()` on it at boot.
 *
 * `undefined` when either half is missing — no database, or no model — which is
 * the `getDb()` / `createAuth(db)` / `createReplyPolisher()` shape this codebase
 * uses everywhere for a dependency the API is expected to boot without. Unlike
 * the polisher and the summariser there is no route to answer 503: ingestion
 * simply marks the ticket `skipped`, which is the honest record that nothing
 * was asked and nothing is coming.
 */
export function createTicketClassification(
  db: Database | undefined,
): ClassificationQueue | undefined {
  const classify = createTicketClassifier();
  if (!db || !classify) return undefined;

  return createClassificationQueue(createClassificationStore(db), classify);
}
