import { Router } from "express";
import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import {
  listTicketsQuerySchema,
  ticketSummarySchema,
  type ListTicketsQuery,
  type ListTicketsResponse,
} from "@helpdesk/shared";
import type { Database } from "../db/client.ts";
import { ticket } from "../db/schema.ts";
import { HttpError } from "../middleware/errors.ts";
import { toTicketDetail, toTicketSummary } from "./ticket-mappers.ts";

/** The two columns `sort` may name, resolved once so the query cannot be told to order by anything else. */
const SORT_COLUMNS = {
  createdAt: ticket.createdAt,
  updatedAt: ticket.updatedAt,
} as const;

/**
 * The cursor is `<iso timestamp>|<uuid>`, base64url'd.
 *
 * Two parts, unlike the user list's single email, because neither half is a
 * total order on its own: two emails can arrive in the same millisecond, and
 * paging on the timestamp alone would drop or repeat whichever rows straddled
 * the boundary. `id` is the tiebreaker, and it is in both sort indexes for
 * exactly this comparison.
 *
 * Base64 for the same reason as the user list: it keeps the sort key from
 * hardening into a de-facto public API.
 */
function encodeCursor(sortValue: Date, id: string): string {
  return Buffer.from(`${sortValue.toISOString()}|${id}`, "utf8").toString(
    "base64url",
  );
}

function decodeCursor(cursor: string): { sortValue: Date; id: string } {
  // Buffer.from drops invalid base64 silently rather than throwing, so these
  // checks are the actual validation and not a second opinion.
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const separator = decoded.lastIndexOf("|");
  if (separator === -1) throw HttpError.badRequest("Malformed cursor");

  const timestamp = decoded.slice(0, separator);
  const id = ticketSummarySchema.shape.id.safeParse(
    decoded.slice(separator + 1),
  );
  const sortValue = new Date(timestamp);

  if (!id.success || Number.isNaN(sortValue.getTime())) {
    throw HttpError.badRequest("Malformed cursor");
  }

  return { sortValue, id: id.data };
}

/**
 * Keyset predicate for "everything after the cursor row".
 *
 * A row-value comparison — `(sort, id) < (value, id)` — rather than the
 * `sort < v OR (sort = v AND id < id)` it expands to. Postgres can drive the
 * composite index straight from the tuple form; the OR form is a filter it
 * usually cannot, and the difference shows up as a sequential scan on page two.
 *
 * The parameters are passed through Drizzle's `sql` interpolation, so they are
 * bound values and not string-concatenated into the statement.
 */
function afterCursor(
  query: ListTicketsQuery,
  cursor: { sortValue: Date; id: string },
): SQL {
  const column = SORT_COLUMNS[query.sort];
  const comparison = query.order === "asc" ? sql`>` : sql`<`;
  return sql`(${column}, ${ticket.id}) ${comparison} (${cursor.sortValue}, ${cursor.id}::uuid)`;
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
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;

    req.log.debug({ query }, "listing tickets");

    if (!db) throw HttpError.serviceUnavailable("Database unavailable");

    const column = SORT_COLUMNS[query.sort];
    const direction = query.order === "asc" ? asc : desc;

    const rows = await db
      .select()
      .from(ticket)
      .where(
        and(
          query.status ? eq(ticket.status, query.status) : undefined,
          query.category ? eq(ticket.category, query.category) : undefined,
          cursor ? afterCursor(query, cursor) : undefined,
        ),
      )
      // Must match the cursor's tuple exactly, or the keyset predicate and the
      // ordering disagree and rows go missing between pages.
      .orderBy(direction(column), direction(ticket.id))
      // One more than asked for: whether it came back tells us there is another
      // page without a second count(*).
      .limit(query.limit + 1);

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const last = page.at(-1);

    const body: ListTicketsResponse = {
      data: page.map(toTicketSummary),
      nextCursor:
        hasMore && last ? encodeCursor(last[query.sort], last.id) : null,
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
