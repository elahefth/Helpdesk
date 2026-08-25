import { Router } from "express";
import { timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { inboundEmailBodySchema } from "@helpdesk/shared";
import type { Database } from "../db/client.ts";
import { ticket } from "../db/schema.ts";
import { env } from "../env.ts";
import { HttpError } from "../middleware/errors.ts";
import { toTicketDetail } from "./ticket-mappers.ts";

/** The header a source presents INBOUND_EMAIL_SECRET in. */
export const INBOUND_SECRET_HEADER = "x-inbound-secret";

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
export function createInboundEmailRouter(db: Database | undefined): Router {
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

    const values = {
      subject: email.subject,
      studentEmail: email.from,
      supportEmail: email.to,
      body: email.text,
      // Every ticket starts open. There is no "unread" state to clear, and no
      // classifier to move it — see TICKET_STATUS_TRANSITIONS.
      status: "open" as const,
      category: email.category ?? null,
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
      res.status(201).json(toTicketDetail(created));
      return;
    }

    // Nothing came back, so `messageId` matched a ticket already created from
    // this delivery. Answering with it, and 200, tells a retrying provider
    // exactly where its email went — a 409 would read as "your email was
    // rejected" for mail that was in fact accepted the first time.
    const [existing] = await db
      .select()
      .from(ticket)
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

    res.status(200).json(toTicketDetail(existing));
  });

  return router;
}
