import { and, asc, eq, exists, isNull, sql } from "drizzle-orm";
import {
  type Job,
  type PgBoss,
  type Queue,
  type SendOptions,
  type WorkOptions,
} from "pg-boss";
import {
  createTicketAutoResolver,
  type AutoResolveContext,
  type TicketAutoResolver,
} from "./ai/auto-resolve-ticket.ts";
import type { Database } from "./db/client.ts";
import { ticket, ticketReply, user } from "./db/schema.ts";
import { env } from "./env.ts";
import { logger } from "./logger.ts";

/**
 * When the automatic resolver runs, and — more to the point — when it refuses
 * to.
 *
 * The shape is the classifier's next door, on the same pg-boss instance and for
 * the same reasons: a model call takes seconds, a mail provider's webhook will
 * not wait for it, and work that outlives a deploy has to be a row in Postgres
 * rather than a promise in memory. Read the note at the top of
 * `ticket-classification.ts` for why the queue is pg-boss and why it holds its
 * own `pg` pool; none of that is restated here.
 *
 * What *is* different is everything about what happens when this worker is
 * wrong, and that is what the guards below are for. The classifier's worst case
 * is a refund request filed under Technical: visible, reversible, and nobody
 * outside the building ever knows. This one writes to a student under the
 * helpdesk's name and closes their ticket. So on top of the classifier's
 * "don't overwrite a human's decision" guard, this worker refuses to act on a
 * ticket that has stopped looking like a brand-new, untouched, unanswered
 * email — see `claim`. A person taking the ticket cancels the machine, always,
 * and the machine never takes a ticket back.
 */

/** The queue tickets are auto-resolved on. */
export const AUTO_RESOLVE_QUEUE = "ticket-auto-resolution";

/**
 * Where a job goes once pg-boss has retried it as many times as it is going to.
 *
 * It exists for the reason the classifier's does: a worker cannot see its own
 * retry count, so "throw and be retried" and "give up and mark the ticket
 * `failed`" cannot live in one function.
 */
export const AUTO_RESOLVE_DEAD_LETTER_QUEUE = "ticket-auto-resolution-dead";

/**
 * The name the assistant signs its replies with, and the name on its byline in
 * the thread.
 *
 * One constant for both, because they are the same claim made twice and a
 * thread where the sign-off and the byline disagree is one where a reader
 * cannot tell who wrote what. It is deliberately not a person's name and not
 * "Support": a student should be able to tell from the signature that they were
 * answered automatically, since that is what tells them replying will reach
 * someone who is not.
 */
export const ASSISTANT_NAME = "Helpdesk Assistant";

/**
 * The stand-in account every automatic reply is authored by.
 *
 * `ticket_reply.author_id` is NOT NULL and references `user`, which is the
 * schema saying a reply always names its author — so an assistant that writes
 * replies needs an identity, and this is it. The same device
 * `dev/seed-replies.ts` uses for the student's half of a seeded conversation,
 * and for the same reason: the thread's query inner-joins `user` *without*
 * filtering `deletedAt`, which is the rule that keeps a departed colleague's
 * byline and is exactly what makes a non-human author renderable.
 *
 * It is created soft-deleted, which is what makes it safe rather than merely
 * tidy. `GET /api/users` and `GET /api/assignees` both filter `deletedAt`, so
 * it can never be listed or handed a ticket; `databaseHooks.session.create
 * .before` refuses it a session; `requireAuth` refuses one it somehow held; and
 * it is written with no `account` row, so there is no password to guess. It
 * exists to be a foreign key and a name, and it can do nothing else.
 *
 * The address is namespaced under `SUPPORT_EMAIL` for the reason the student
 * stand-in's is: `user.email` is UNIQUE and a soft-deleted row keeps its
 * address, so an unprefixed `assistant@…` would reserve an address a real
 * person might one day need and answer the resulting 409 with "that email
 * belongs to a deleted user" about an account nobody can find.
 */
export const assistantEmail = (supportEmail = env.SUPPORT_EMAIL) =>
  `assistant.${supportEmail}`;

/** One job's payload. The ticket is re-read at run time; nothing else travels. */
export interface AutoResolutionJobData {
  ticketId: string;
}

/**
 * How the queue behaves — identical to the classifier's, and identical on
 * purpose rather than by accident.
 *
 * `short` is the policy that dedupes by `singletonKey`, which is what lets
 * `reconcile()` send for every pending ticket at every boot without doubling a
 * queue that mostly still holds those jobs. `notify` is what makes dispatch
 * feel immediate, and is inert without `useListenNotify` on the instance —
 * which `ticket-jobs.ts` sets. See `ticket-classification.ts` for the full
 * argument behind each; duplicating the reasoning here would be two places to
 * correct it.
 */
export const AUTO_RESOLVE_QUEUE_OPTIONS: Omit<Queue, "name"> = {
  policy: "short",
  notify: true,
  deadLetter: AUTO_RESOLVE_DEAD_LETTER_QUEUE,
};

/**
 * How one job behaves.
 *
 * The same three-attempt, 15s-backoff policy the classifier runs, and the
 * ceiling it buys is the same measured **~3.5 minutes**. What that time means
 * here is different and worth stating: a ticket under retry is `pending`, and
 * `pending` is hidden from the queue by `handledBy=human`. So an install whose
 * model is throttled has tickets that are invisible to staff for up to three
 * and a half minutes after they arrive, and then appear. That is the deliberate
 * trade — the alternative is showing a ticket and then answering it out from
 * under whoever picked it up — and it is why the dead letter worker's write is
 * the one that must never be skipped: `failed` is what puts the ticket back in
 * front of a person.
 *
 * `expireInSeconds` must clear `ai/openrouter.ts`'s 60s deadline with room, or
 * pg-boss reclaims a job still legitimately waiting on a model and runs it
 * twice — which here means two emails to one student.
 */
export const AUTO_RESOLVE_SEND_OPTIONS: SendOptions = {
  retryLimit: 3,
  retryDelay: 15,
  retryBackoff: true,
  expireInSeconds: 120,
};

/**
 * One job at a time per process, for the reason the classifier's worker pulls
 * one: the other end is a shared free-tier pool that throttles, and the only
 * burst this ever sees is a replay, where fanning out turns every request into
 * a 429.
 */
export const AUTO_RESOLVE_WORK_OPTIONS: WorkOptions = {
  batchSize: 1,
  notifyPollingIntervalSeconds: 30,
  pollingIntervalSeconds: 2,
};

/** Everything the worker needs from a ticket, and nothing about how it is stored. */
export interface AutoResolutionJob extends AutoResolveContext {
  id: string;
}

/**
 * The five things the worker does to the database, behind an interface.
 *
 * A port rather than a `Database`, for the reason `ClassificationStore` is one:
 * `bun run test` runs with `DATABASE_URL` stripped, and the decisions in this
 * file — when to act, when to stand down, what to write when a model gives up —
 * are the whole of what can be wrong here and every one of them fails quietly.
 */
export interface AutoResolutionStore {
  /**
   * The ticket, if the assistant may still answer it.
   *
   * `undefined` is "not mine", and the conditions are deliberately stricter
   * than the classifier's. That one asks only whether a human has set the
   * category; this one asks whether a human has touched the ticket *at all*,
   * because the thing it is about to do — write to the student and close the
   * ticket — is wrong the moment somebody else is on it:
   *
   * - **Still `pending`.** A `PATCH /api/tickets/:id` writes `skipped` in the
   *   same statement as any change, so an agent who so much as assigns the
   *   ticket to themselves has said "mine".
   * - **Still `open`.** Somebody resolved or closed it while this sat in the
   *   queue; answering now would reopen nothing and write to a student about a
   *   ticket that is finished.
   * - **Still unanswered.** A reply on the thread means a colleague has already
   *   written to this student, and the one outcome worth any amount of caution
   *   is two different answers to one email minutes apart.
   */
  claim(ticketId: string): Promise<AutoResolutionJob | undefined>;
  /**
   * Answer the student and close the ticket: one reply on the thread, authored
   * by the assistant, and `status = resolved` with `auto_resolution = resolved`.
   * One transaction, because a reply with no status change is a ticket that
   * looks untouched and a status change with no reply is a student who was
   * never written to.
   */
  resolve(job: AutoResolutionJob, reply: string): Promise<void>;
  /** The assistant read it and declined. The ticket is a human's, unchanged. */
  escalate(job: AutoResolutionJob): Promise<void>;
  /** The model could not be reached or could not answer usably. */
  fail(job: AutoResolutionJob): Promise<void>;
  /**
   * Stop claiming a ticket the assistant is no longer allowed to answer.
   *
   * The half of `claim` returning `undefined` that has nowhere else to live. A
   * ticket a colleague replied to stays `pending` forever otherwise — nothing
   * moves it, `reconcile()` re-queues it at every boot, and, because
   * `handledBy=human` hides `pending`, **it is missing from the queue**. That
   * is the one failure this feature could ship that loses a ticket outright, so
   * standing down is a write rather than a `return`.
   */
  skip(ticketId: string): Promise<void>;
  /** Every ticket the table still calls `pending`, oldest first. */
  pending(): Promise<string[]>;
}

/**
 * The real store.
 *
 * Two things in here are load-bearing beyond the SQL.
 *
 * **Every write is guarded on `auto_resolution = 'pending'` and `status =
 * 'open'`**, not just on the id — the same reasoning the classifier's guard
 * carries, with more at stake. The seconds (or minutes, across retries) between
 * a claim and a write are enough for an agent to open the ticket and take it,
 * and an unguarded UPDATE would answer their student for them.
 *
 * **`updatedAt` is restated in SQL on three of the four writes**, and that
 * differs from the classifier's idiom of carrying the value through the job.
 * The reason is `skip`, which has no claimed row to carry anything from:
 * `updated_at = "ticket"."updated_at"` says the same thing at every call site
 * and cannot go stale between the read and the write. `resolve` is the one that
 * lets `$onUpdate` restamp, deliberately — a reply was written and the status
 * changed, which is activity *on* the ticket rather than something that
 * happened to the record of one, and it is what the queue's default sort is
 * supposed to surface.
 */
export function createAutoResolutionStore(db: Database): AutoResolutionStore {
  /** The shared guard: this row, still the assistant's to answer. */
  const claimable = (ticketId: string) =>
    and(
      eq(ticket.id, ticketId),
      eq(ticket.autoResolution, "pending"),
      eq(ticket.status, "open"),
    );

  /** Leaves the queue's default sort alone. See the note above. */
  const keepUpdatedAt = sql`${ticket.updatedAt}`;

  /**
   * The assistant's `user` row, found or created, then held for the process.
   *
   * Memoised on the promise rather than the id, so two jobs starting at once
   * share one round trip instead of racing to insert the same row. Across
   * *processes* the race is real, and `onConflictDoNothing` plus the re-select
   * below is what settles it: the loser inserts nothing and reads the winner's
   * row, which is the same answer.
   */
  let assistant: Promise<string> | undefined;

  function assistantId(): Promise<string> {
    assistant ??= (async () => {
      const email = assistantEmail();

      const [existing] = await db
        .select({ id: user.id })
        .from(user)
        .where(eq(user.email, email))
        .limit(1);
      if (existing) return existing.id;

      const [created] = await db
        .insert(user)
        .values({
          name: ASSISTANT_NAME,
          email,
          emailVerified: false,
          // Soft-deleted from birth: unlistable, unassignable, and refused a
          // session by `databaseHooks.session.create.before`. It is a foreign
          // key and a name, and it is created with no `account` row, so there
          // is no password for anyone to try.
          deletedAt: new Date(),
          role: "agent",
        })
        .onConflictDoNothing({ target: user.email })
        .returning({ id: user.id });
      if (created) return created.id;

      // Another process won the insert between the select and ours.
      const [raced] = await db
        .select({ id: user.id })
        .from(user)
        .where(eq(user.email, email))
        .limit(1);
      if (!raced) throw new Error("could not create the assistant account");
      return raced.id;
    })().catch((error: unknown) => {
      // Not cached as a rejection: a transient failure here must not disable
      // the assistant for the life of the process.
      assistant = undefined;
      throw error;
    });

    return assistant;
  }

  return {
    async claim(ticketId) {
      const [row] = await db
        .select({
          id: ticket.id,
          subject: ticket.subject,
          body: ticket.body,
          studentName: ticket.studentName,
          studentEmail: ticket.studentEmail,
        })
        .from(ticket)
        .where(
          and(
            claimable(ticketId),
            // Nobody has written to this student yet. A correlated EXISTS
            // rather than a join, so a ticket with a long thread costs one
            // index probe and the row is not multiplied by it.
            sql`not ${exists(
              db
                .select({ one: sql`1` })
                .from(ticketReply)
                .where(eq(ticketReply.ticketId, ticket.id)),
            )}`,
            // A ticket whose assignee is set has an owner, even if nothing else
            // about it changed. PATCH marks `skipped` as well, so this is the
            // belt to that braces — and it is the cheap half.
            isNull(ticket.assignedToId),
          ),
        )
        .limit(1);

      return row;
    },

    async resolve(job, reply) {
      // Resolved *before* the transaction: creating the assistant is its own
      // write, and doing it inside would hold the ticket row's lock across an
      // insert that has nothing to do with this ticket.
      const authorId = await assistantId();

      await db.transaction(async (tx) => {
        // The UPDATE goes first and its `returning` is the arbiter. If the
        // guard no longer matches, somebody took the ticket while the model was
        // writing, and the reply must not be inserted — a transaction that
        // wrote only the reply would put an automatic answer on a ticket a
        // colleague is in the middle of answering themselves.
        //
        // `status: "resolved"` bypasses `canTransition`, which is safe only
        // because `claimable` pins the current status to `open`, and
        // open -> resolved is a legal move. Widening that guard means checking
        // the transition here.
        const [claimed] = await tx
          .update(ticket)
          .set({ status: "resolved", autoResolution: "resolved" })
          .where(claimable(job.id))
          .returning({ id: ticket.id });

        if (!claimed) return;

        await tx
          .insert(ticketReply)
          .values({ ticketId: job.id, authorId, body: reply });
      });
    },

    async escalate(job) {
      await db
        .update(ticket)
        .set({ autoResolution: "escalated", updatedAt: keepUpdatedAt })
        .where(claimable(job.id));
    },

    async fail(job) {
      await db
        .update(ticket)
        .set({ autoResolution: "failed", updatedAt: keepUpdatedAt })
        .where(claimable(job.id));
    },

    async skip(ticketId) {
      // Guarded on `pending` alone, deliberately — unlike every other write
      // here. This is reached precisely when the fuller guard stopped matching,
      // so requiring `status = 'open'` would refuse to stand down on the
      // commonest reason to: somebody resolved the ticket by hand.
      await db
        .update(ticket)
        .set({ autoResolution: "skipped", updatedAt: keepUpdatedAt })
        .where(
          and(eq(ticket.id, ticketId), eq(ticket.autoResolution, "pending")),
        );
    },

    async pending() {
      // Unbounded and oldest-first, like the classifier's: a cap would be a
      // second, quieter way for a ticket to stay `pending` — and therefore
      // hidden from the queue — forever.
      const rows = await db
        .select({ id: ticket.id })
        .from(ticket)
        .where(eq(ticket.autoResolution, "pending"))
        .orderBy(asc(ticket.createdAt), asc(ticket.id));

      return rows.map((row) => row.id);
    },
  };
}

/**
 * What the two workers do, with no pg-boss in sight.
 *
 * Separated from the wiring below so it is testable — `bun run test` has no
 * database, no model and no queue, and this is where every decision that can be
 * wrong lives.
 */
export function createAutoResolutionWorker(
  store: AutoResolutionStore,
  autoResolve: TicketAutoResolver,
) {
  return {
    /**
     * One attempt at one ticket.
     *
     * **It throws, and that is the interface** — a thrown handler is how a job
     * asks pg-boss to retry it, so a throttled model or a failed write is
     * re-raised rather than swallowed, and `retryLimit` is the policy. The
     * ticket stays `pending` throughout, which is true: it is still queued.
     *
     * Returning normally means done with this ticket, including the two cases
     * that are not failures — the assistant declined, and the assistant is no
     * longer allowed to answer. Throwing for either would spend three attempts
     * and then mark the ticket `failed` over the top of a correct decision.
     */
    async resolve(ticketId: string): Promise<void> {
      const job = await store.claim(ticketId);

      // Somebody took the ticket while this sat in the queue. Standing down is
      // a write, not a return — see `AutoResolutionStore.skip`, because a row
      // left `pending` is a row missing from the queue.
      if (!job) {
        await store.skip(ticketId);
        logger.debug({ ticketId }, "auto-resolution no longer applies");
        return;
      }

      const decision = await autoResolve(job);

      if (decision.kind === "escalate") {
        await store.escalate(job);
        logger.info({ ticketId }, "escalated ticket to a human");
        return;
      }

      await store.resolve(job, decision.body);
      logger.info({ ticketId }, "auto-resolved ticket from the knowledge base");
    },

    /**
     * The last word on a ticket pg-boss has given up on.
     *
     * Reached only from the dead letter queue, which is the only place that
     * knows the retries are spent. The row *must* stop being `pending` here:
     * nothing will look at it again on its own, and a ticket stuck `pending` is
     * one `handledBy=human` hides from everybody.
     *
     * It claims first rather than writing blind, so a ticket somebody took
     * during the retries is stood down rather than stamped `failed` — a
     * distinction that matters to whoever is reading the failures.
     */
    async bury(ticketId: string): Promise<void> {
      const job = await store.claim(ticketId);
      if (!job) {
        await store.skip(ticketId);
        return;
      }

      await store.fail(job);
      logger.warn({ ticketId }, "auto-resolution failed after every retry");
    },
  };
}

export interface AutoResolutionQueue {
  /**
   * Declare this feature's queues and start its workers on an already-running
   * pg-boss instance. Called once, by `ticket-jobs.ts`.
   */
  register(): Promise<void>;
  /**
   * Hand a ticket over. Durable the moment it resolves — the job is a row in
   * Postgres, so it outlives this process.
   */
  enqueue(ticketId: string): Promise<void>;
  /**
   * Put the ticket table and the job queue back in agreement, and say how many
   * tickets needed it.
   *
   * It matters more here than for the classifier. A ticket marked `pending`
   * with no job behind it is not merely uncategorised — it is **absent from the
   * queue**, because that is what `pending` means to `handledBy=human`. This is
   * what finds those on the next boot.
   */
  reconcile(): Promise<number>;
}

/**
 * The pg-boss wiring: queues declared, workers registered, jobs sent.
 */
export function createAutoResolutionQueue(
  boss: PgBoss,
  store: AutoResolutionStore,
  autoResolve: TicketAutoResolver,
): AutoResolutionQueue {
  const worker = createAutoResolutionWorker(store, autoResolve);

  /**
   * pg-boss hands a worker an array even at `batchSize: 1`, and a throw fails
   * the whole batch — right here, where one job is one ticket. The loop is
   * written to survive somebody raising the batch size later.
   */
  const handle =
    (run: (ticketId: string) => Promise<void>) =>
    async (jobs: Job<AutoResolutionJobData>[]) => {
      for (const job of jobs) await run(job.data.ticketId);
    };

  async function enqueue(ticketId: string): Promise<void> {
    // `singletonKey` is the ticket, which the queue's `short` policy dedupes
    // on: a `null` return means a job for it is already waiting, which is the
    // ordinary answer during `reconcile` and not a failure.
    await boss.send(
      AUTO_RESOLVE_QUEUE,
      { ticketId },
      { ...AUTO_RESOLVE_SEND_OPTIONS, singletonKey: ticketId },
    );
  }

  return {
    enqueue,

    async register() {
      // The dead letter queue has to exist before the queue that names it, or
      // `createQueue` refuses the reference.
      await boss.createQueue(AUTO_RESOLVE_DEAD_LETTER_QUEUE);
      await boss.createQueue(AUTO_RESOLVE_QUEUE, AUTO_RESOLVE_QUEUE_OPTIONS);

      await boss.work<AutoResolutionJobData>(
        AUTO_RESOLVE_QUEUE,
        AUTO_RESOLVE_WORK_OPTIONS,
        handle(worker.resolve),
      );

      // The dead letter worker only writes a column, so it needs none of the
      // main queue's pacing — and it must not inherit its `deadLetter`, or a
      // failure to mark a ticket failed would loop back into itself.
      await boss.work<AutoResolutionJobData>(
        AUTO_RESOLVE_DEAD_LETTER_QUEUE,
        { batchSize: 1 },
        handle(worker.bury),
      );

      logger.info(
        {
          queue: AUTO_RESOLVE_QUEUE,
          deadLetter: AUTO_RESOLVE_DEAD_LETTER_QUEUE,
        },
        "ticket auto-resolution queue started",
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
 * The wiring, in one place.
 *
 * `undefined` when any of the three halves is missing — no database, no model,
 * or no knowledge base to answer from. That is one more way to be absent than
 * its siblings have, and the extra one is the important one: an assistant with
 * no knowledge base does not decline to answer, it answers from whatever a
 * language model happens to believe about refund policies.
 *
 * With the feature off, ingestion marks every ticket `skipped` and the queue
 * shows all of them — which is the behaviour this repo had before any of this
 * existed, and the right thing to degrade to.
 */
export function createTicketAutoResolution(
  db: Database | undefined,
  boss: PgBoss,
): AutoResolutionQueue | undefined {
  const autoResolve = createTicketAutoResolver(ASSISTANT_NAME);
  if (!db || !autoResolve) return undefined;

  return createAutoResolutionQueue(
    boss,
    createAutoResolutionStore(db),
    autoResolve,
  );
}
