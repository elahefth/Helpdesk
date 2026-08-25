import { Router } from "express";
import { and, count, eq, ilike, or, type SQL } from "drizzle-orm";
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
 * Turns a search term into a LIKE pattern, escaping the characters LIKE treats
 * as wildcards.
 *
 * Without this, `%` typed into the search box matches every ticket and `_`
 * matches any single character — so a student searching for "50%_refund" gets
 * results that have nothing to do with what they typed, and a term of a single
 * `%` silently returns the whole queue. The backslash is escaped first, or
 * escaping the other two would then be undone by their own escape character.
 *
 * `ESCAPE '\'` is LIKE's default in Postgres, so the pattern needs no clause
 * of its own — but it does mean the driver's parameter and the SQL's escape
 * character have to agree, which is why the doubling happens here rather than
 * being left to string interpolation somewhere else.
 *
 * Exported only so `tickets.test.ts` can pin it: no test with a stubbed
 * database reaches the query, and the failure it guards against is silent —
 * a wrong pattern returns results rather than an error.
 */
export function searchPattern(term: string): string {
  const escaped = term
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
  return `%${escaped}%`;
}

/**
 * Where a search term is allowed to match.
 *
 * The three visible columns plus the body. Including the body means a result
 * can appear with nothing on the row explaining why — the honest cost of a
 * helpdesk search that can actually find "the one about the double charge",
 * where that phrase only ever appears in the email itself. Highlighting the
 * match is what would resolve it, and that wants a ticket detail view first.
 *
 * `ilike` rather than `lower(col) like lower(?)`: same case-insensitivity, and
 * it is the form a `pg_trgm` GIN index can serve when the queue outgrows a
 * sequential scan. At this size it scans, deliberately — an index chosen before
 * there is a query plan to justify it is a guess with a write cost.
 */
function matchesSearch(term: string): SQL | undefined {
  const pattern = searchPattern(term);
  return or(
    ilike(ticket.subject, pattern),
    ilike(ticket.studentName, pattern),
    ilike(ticket.studentEmail, pattern),
    ilike(ticket.body, pattern),
  );
}

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

    // Built once and used twice, deliberately: the count must see the same
    // filters as the page or "Page 3 of 10" is a count of a different queue.
    // The cursor is the one predicate it must *not* see — it narrows to what
    // follows a position, and the total is of everything that matches.
    const filters: SQL | undefined = and(
      query.status ? eq(ticket.status, query.status) : undefined,
      query.category ? eq(ticket.category, query.category) : undefined,
      // A search narrows the queue like any other filter, so it belongs here
      // and not beside the cursor: the count has to see it, or the pager
      // reports the size of a queue the reader is not looking at.
      query.q ? matchesSearch(query.q) : undefined,
    );

    const rows = await db
      .select()
      .from(ticket)
      .where(
        and(
          filters,
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

    // A second round trip, which is the price of a page counter — a cursor can
    // say whether a next page exists but never how many follow. Issued after
    // the page rather than in parallel so a request that is going to fail on
    // the page query does not pay for a count nobody will read.
    const [counted] = await db
      .select({ total: count() })
      .from(ticket)
      .where(filters);

    const body: ListTicketsResponse = {
      data: page.map(toTicketSummary),
      nextCursor: hasMore && last ? encodeTicketCursor(last, query.sort) : null,
      // `count()` over an empty match returns a row holding 0, so the fallback
      // is for a shape that cannot occur rather than for an empty queue.
      total: counted?.total ?? 0,
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
