import { Router } from "express";
import { timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { inboundEmailBodySchema } from "@helpdesk/shared";
import type { Database } from "../db/client.ts";
import { ticket, user } from "../db/schema.ts";
import { env } from "../env.ts";
import { HttpError } from "../middleware/errors.ts";
import type { ClassificationQueue } from "../ticket-classification.ts";
import { toTicketDetail } from "./ticket-mappers.ts";

/** The header a source presents INBOUND_EMAIL_SECRET in. */
export const INBOUND_SECRET_HEADER = "x-inbound-secret";

/**
 * The header a source sets to say "do not classify this one".
 *
 * It is about *this delivery* rather than about the mail, which is why it is a
 * header and not a field on `inboundEmailBodySchema`: that schema is the
 * provider seam, the small intersection every webhook can produce, and a flag
 * about our own background work has no business in it.
 *
 * It exists for bulk replay. `bun run seed:tickets` posts a hundred committed
 * fixtures whose categories — including the ~18% deliberately left null — are
 * part of what the corpus is *for*; classifying them would spend a model call
 * per message and quietly erase the unclassified tail that the category sort's
 * NULLS-last branch is checked against by eye. The same argument covers a
 * forwarding script replaying an archive. It grants nothing and skips work, so
 * it is not a privilege: a caller who can reach this endpoint at all already
 * holds `INBOUND_EMAIL_SECRET`.
 */
export const SKIP_CLASSIFICATION_HEADER = "x-skip-classification";

/**
 * Whether a delivery asked to skip classification.
 *
 * Exported and pure for the reason `isAuthorizedSource` is — `env` and the
 * queue are both out of reach of a test that cannot start a process with them
 * configured. Two spellings accepted because both are what someone writes
 * without checking, and the failure of guessing wrong is silent: a header that
 * was meant to skip and did not costs a model call and a changed corpus, with
 * nothing to say it was ignored.
 */
export function wantsClassificationSkipped(
  header: string | undefined,
): boolean {
  return header === "1" || header?.toLowerCase() === "true";
}

/**
 * Compares the presented secret to the configured one in constant time.
 *
 * Exported and pure because it cannot be reached any other way in a test:
 * `env` is parsed once at import, so a test cannot configure a secret and then
 * make a request against it. This is the whole guard, and an untested guard on
 * the one unauthenticated write in the API is not worth having.
 *
 * With no secret configured the endpoint is open. That is deliberate in
 * development — the point of the fixture script is that `curl` works — and
 * unreachable in production, where env.ts refuses to boot without one.
 *
 * `timingSafeEqual` throws on a length mismatch rather than returning false, so
 * the lengths are compared first. That comparison leaks the secret's length,
 * which is not a secret worth protecting; the alternative is hashing both sides
 * to a fixed width, which buys nothing here.
 */
export function isAuthorizedSource(
  presented: string | undefined,
  configured: string | undefined,
): boolean {
  if (!configured) return true;
  if (!presented) return false;

  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(configured, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Turns one delivered email into one ticket.
 *
 * Unauthenticated by necessity: whatever delivers the mail — a provider
 * webhook, a forwarding script, the fixture sender in `dev/` — holds no session
 * and never will. It is mounted above `requireAuth` in app.ts for that reason,
 * and `isAuthorizedSource` is what stands in for the session.
 *
 * A factory over the database handle, like `createUsersRouter` and for the same
 * reason: `getDb()` may return undefined, and this route has to answer for that
 * rather than assume it.
 */
export function createInboundEmailRouter(
  db: Database | undefined,
  /**
   * Where a newly created ticket goes to be categorised — after the response,
   * never during it. `undefined` when the install has no model configured, in
   * which case the row is written `skipped` and nothing is queued.
   *
   * A parameter rather than a module-level const, like the polisher on the
   * tickets router: it is how a test hands in a fake, and how `index.ts` gets
   * the same instance it calls `resume()` on.
   */
  classification?: ClassificationQueue,
): Router {
  const router = Router();

  router.post("/inbound-email", async (req, res) => {
    // Before the body is even looked at: an unauthorized caller learns nothing
    // about what this endpoint accepts.
    if (
      !isAuthorizedSource(
        req.header(INBOUND_SECRET_HEADER),
        env.INBOUND_EMAIL_SECRET,
      )
    ) {
      throw HttpError.unauthorized("Invalid inbound-email secret");
    }

    // Throws ZodError on a malformed payload; Express 5 routes that to the
    // error handler as `validation_failed`, with the failing fields in
    // `details` — which is what an adapter author needs to see.
    const email = inboundEmailBodySchema.parse(req.body);

    // Mail addressed somewhere else is not this helpdesk's. 422 rather than
    // 400: the payload is perfectly well-formed, it just describes a delivery
    // this mailbox should not have received, and re-sending it unchanged will
    // never succeed.
    if (email.to !== env.SUPPORT_EMAIL) {
      throw new HttpError(
        422,
        "wrong_recipient",
        `Not addressed to the support address (${env.SUPPORT_EMAIL})`,
      );
    }

    req.log.debug(
      { from: email.from, messageId: email.messageId },
      "ingesting inbound email",
    );

    if (!db) throw HttpError.serviceUnavailable("Database unavailable");

    // The server's clock is the fallback, not the schema's: a schema shared
    // with the browser must not read a clock.
    const receivedAt = email.receivedAt
      ? new Date(email.receivedAt)
      : new Date();

    /**
     * Whether this delivery is the classifier's to look at.
     *
     * Three ways it is not, and they are all the same answer to the reader —
     * "nothing was asked" — which is what `skipped` means. A source that stated
     * its own category knows better than a model does; a source that asked to
     * be left alone is replaying mail in bulk; and an install with no
     * `OPENROUTER_API_KEY` has nothing to ask.
     */
    const classify =
      !email.category &&
      !wantsClassificationSkipped(req.header(SKIP_CLASSIFICATION_HEADER)) &&
      Boolean(classification);

    const values = {
      subject: email.subject,
      studentName: email.fromName ?? null,
      studentEmail: email.from,
      supportEmail: email.to,
      body: email.text,
      // Every ticket starts open. There is no "unread" state to clear, and no
      // classifier to move it — see TICKET_STATUS_TRANSITIONS.
      status: "open" as const,
      category: email.category ?? null,
      /**
       * Written here, in the INSERT, rather than by the queue when it picks the
       * job up. The row is therefore `pending` from the instant it exists —
       * true in the 201 this request is about to send, true for a reader who
       * refreshes the queue a millisecond later, and true if this process dies
       * before the microtask below ever runs, which is precisely the case
       * `resume()` recovers. A worker that marked its own jobs would leave a
       * gap in which a brand-new ticket looks like one nobody will classify.
       */
      classification: classify ? ("pending" as const) : ("skipped" as const),
      sourceMessageId: email.messageId ?? null,
      receivedAt,
    };

    // Idempotency in one statement. A provider that retries its webhook — the
    // normal response to a slow 200 — must not produce a second ticket, and
    // doing this as SELECT-then-INSERT would lose that race to a concurrent
    // retry. The unique index on source_message_id is the arbiter, so the
    // second delivery updates nothing and returns no row.
    const [created] = await db
      .insert(ticket)
      .values(values)
      .onConflictDoNothing({ target: ticket.sourceMessageId })
      .returning();

    if (created) {
      // Explicitly unassigned: a ticket arrives in the unassigned pool,
      // because nothing routes. It is categorised below rather than here, for
      // the same reason as ever: nothing *about the email* says which category
      // it is, and a default would be a guess wearing a decision's clothes.
      res.status(201).json(toTicketDetail(created, null));

      /**
       * After the response, and that ordering is still deliberate — though it
       * now buys something different than it used to.
       *
       * The model call is decoupled by the queue itself: `enqueue` is one
       * INSERT into pg-boss's job table and returns in a millisecond or two,
       * so putting it *before* the 201 would no longer risk the timeout-and-
       * redeliver problem that shaped this route. What keeps it here is a
       * priority rather than a latency: losing mail is unrecoverable and
       * failing to classify is not. If pg-boss is unreachable, a delivery must
       * still become a ticket — so the queue is never in the critical path of
       * the one write this API accepts from outside.
       *
       * Hence the catch. A failed send leaves a row that says `pending` with
       * nothing queued behind it, which is precisely what
       * `ClassificationQueue.reconcile()` exists to find on the next boot. It
       * is logged rather than thrown because the response has already gone: an
       * Express 5 handler that rejects after `res.json()` reaches the error
       * handler, which would then try to write a second time.
       *
       * Read off the row rather than off `classify`, so the queue and the
       * column can never disagree about whether a job is owed.
       */
      if (classification && created.classification === "pending") {
        try {
          await classification.enqueue(created.id);
        } catch (error) {
          req.log.error(
            { err: error, ticketId: created.id },
            "could not queue a ticket for classification",
          );
        }
      }
      return;
    }

    // Nothing came back, so `messageId` matched a ticket already created from
    // this delivery. Answering with it, and 200, tells a retrying provider
    // exactly where its email went — a 409 would read as "your email was
    // rejected" for mail that was in fact accepted the first time.
    const [existing] = await db
      .select({ ticket, assignee: user })
      .from(ticket)
      // The one place ingestion has to care who owns a ticket. The first
      // delivery is unassigned by definition, but this row has existed for as
      // long as the retry took, and somebody may have picked it up in between —
      // so the duplicate's answer is joined rather than assumed.
      .leftJoin(user, eq(user.id, ticket.assignedToId))
      // Non-null: `onConflictDoNothing` can only have fired on this column, and
      // a NULL messageId cannot conflict (NULLs are distinct under a unique
      // index), so reaching here means one was supplied.
      .where(eq(ticket.sourceMessageId, email.messageId!))
      .limit(1);

    // Only reachable if the conflicting row disappeared between the two
    // statements, which nothing in this codebase does — there is no ticket
    // delete. Answering 503 rather than asserting past it keeps the failure
    // honest and retryable.
    if (!existing) {
      throw HttpError.serviceUnavailable(
        "Could not resolve the duplicate delivery; retry",
      );
    }

    res.status(200).json(toTicketDetail(existing.ticket, existing.assignee));
  });

  return router;
}
