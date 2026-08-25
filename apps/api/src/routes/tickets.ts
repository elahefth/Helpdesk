import { Router } from "express";
import { and, eq } from "drizzle-orm";
import {
  listTicketsQuerySchema,
  ticketSummarySchema,
  type ListTicketsResponse,
} from "@helpdesk/shared";
import type { Database } from "../db/client.ts";
import { ticket } from "../db/schema.ts";
import { HttpError } from "../middleware/errors.ts";
import { toTicketDetail, toTicketSummary } from "./ticket-mappers.ts";
import {
  decodeTicketCursor,
  encodeTicketCursor,
  ticketAfterCursor,
  ticketOrderBy,
} from "./ticket-sort.ts";

/**
 * A factory over the database handle, like `createUsersRouter`. It was a
 * module-level const while the list was a fixture; it reads real rows now, so
 * it takes the handle and answers for its absence.
 */
export function createTicketsRouter(db: Database | undefined): Router {
  const router = Router();

  router.get("/tickets", async (req, res) => {
    // Validation before the database check, as in the user routes: a malformed
    // request should get a 400 that describes it rather than a 503 that blames
    // the database. Throws ZodError; Express 5 routes that to the error handler.
    const query = listTicketsQuerySchema.parse(req.query);
    const cursor = query.cursor ? decodeTicketCursor(query.cursor) : undefined;

    req.log.debug({ query }, "listing tickets");

    if (!db) throw HttpError.serviceUnavailable("Database unavailable");

    const rows = await db
      .select()
      .from(ticket)
      .where(
        and(
          query.status ? eq(ticket.status, query.status) : undefined,
          query.category ? eq(ticket.category, query.category) : undefined,
          cursor
            ? ticketAfterCursor(query.sort, query.order, cursor)
            : undefined,
        ),
      )
      // Must match the keyset predicate exactly — same expression, same
      // direction, same tiebreaker — or the two disagree about where the page
      // ended and rows go missing between them.
      .orderBy(...ticketOrderBy(query.sort, query.order))
      // One more than asked for: whether it came back tells us there is another
      // page without a second count(*).
      .limit(query.limit + 1);

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const last = page.at(-1);

    const body: ListTicketsResponse = {
      data: page.map(toTicketSummary),
      nextCursor: hasMore && last ? encodeTicketCursor(last, query.sort) : null,
    };

    res.json(body);
  });

  router.get("/tickets/:id", async (req, res) => {
    // A path param is untrusted input like any other. A non-UUID cannot name a
    // row, so this could 404, but 400 says what is actually wrong.
    const id = ticketSummarySchema.shape.id.safeParse(req.params.id);
    if (!id.success) throw HttpError.badRequest("Malformed ticket id");

    if (!db) throw HttpError.serviceUnavailable("Database unavailable");

    const [row] = await db
      .select()
      .from(ticket)
      .where(eq(ticket.id, id.data))
      .limit(1);

    if (!row) throw HttpError.notFound(`Ticket ${id.data} not found`);

    res.json(toTicketDetail(row));
  });

  return router;
}
