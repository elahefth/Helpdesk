import { Router } from "express";
import { and, count, eq, ilike, isNull, or, type SQL } from "drizzle-orm";
import {
  canTransition,
  listTicketsQuerySchema,
  ticketSummarySchema,
  updateTicketBodySchema,
  type ListTicketsResponse,
  type TicketDetail,
  type UpdateTicketResponse,
} from "@helpdesk/shared";
import type { Database } from "../db/client.ts";
import { ticket, user } from "../db/schema.ts";
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
 * One ticket with its assignee resolved, in a single round trip.
 *
 * A LEFT JOIN rather than a second SELECT, and left rather than inner: most
 * tickets are unassigned, and an inner join would answer "no such ticket" for
 * every one of them.
 *
 * It deliberately does **not** filter `user.deletedAt`. A soft-deleted staff
 * account keeps its row precisely so a ticket can still name who handled it, so
 * hiding a deleted assignee here would silently redraw an owned ticket as
 * unassigned — the one reading that makes the surviving row pointless. They can
 * no longer be *chosen*: that is `GET /api/assignees`' job, and it does filter.
 *
 * Shared by GET and PATCH so the two cannot drift into describing the same
 * ticket differently.
 */
async function findTicketDetail(
  db: Database,
  id: string,
): Promise<TicketDetail | undefined> {
  const [row] = await db
    .select({ ticket, assignee: user })
    .from(ticket)
    .leftJoin(user, eq(user.id, ticket.assignedToId))
    .where(eq(ticket.id, id))
    .limit(1);

  return row ? toTicketDetail(row.ticket, row.assignee) : undefined;
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

    const detail = await findTicketDetail(db, id.data);
    if (!detail) throw HttpError.notFound(`Ticket ${id.data} not found`);

    res.json(detail);
  });

  /**
   * Assign a ticket, or hand it back to the unassigned pool.
   *
   * Deliberately **not** admin-gated, unlike every user route: the console is
   * staff-only already, and an agent claiming a ticket or passing one to a
   * colleague is the ordinary way a queue gets worked. Making it a supervisor
   * act would mean an agent who picks up a ticket cannot say so.
   */
  router.patch("/tickets/:id", async (req, res) => {
    const id = ticketSummarySchema.shape.id.safeParse(req.params.id);
    if (!id.success) throw HttpError.badRequest("Malformed ticket id");

    // Both validations before the database check, as everywhere else here: a
    // malformed request deserves a 400 that describes it rather than a 503 that
    // blames Postgres. Throws ZodError, including for an unknown key — the body
    // schema is strict.
    const input = updateTicketBodySchema.parse(req.body);

    req.log.debug({ ticketId: id.data, input }, "updating ticket");

    if (!db) throw HttpError.serviceUnavailable("Database unavailable");

    // Read before writing. Two of the three fields need the row to validate at
    // all — a status move is legal only relative to the status the ticket is
    // already in — and it is also what answers 404 for an id that names
    // nothing, before any of the checks below blame the caller for it.
    const current = await findTicketDetail(db, id.data);
    if (!current) throw HttpError.notFound(`Ticket ${id.data} not found`);

    // Every field is optional and absent means "leave it alone", so each check
    // is on the property being *present* rather than on it being truthy —
    // `assigneeId: null` and `category: null` are instructions, not omissions.
    if (input.assigneeId !== undefined && input.assigneeId !== null) {
      const [target] = await db
        .select({ id: user.id })
        .from(user)
        .where(and(eq(user.id, input.assigneeId), isNull(user.deletedAt)))
        .limit(1);

      // The foreign key would catch a wholly unknown id, but as a 500 — and it
      // would not catch a soft-deleted one at all, since that row still exists.
      // Both are the same mistake from the caller's side, so they get one 400
      // that says so.
      if (!target) {
        throw HttpError.badRequest(
          "That user does not exist, or has been deleted.",
        );
      }
    }

    /**
     * The lifecycle, enforced here rather than left to the SPA's disabled
     * options — those hide a move, they do not prevent one.
     *
     * `canTransition` answers false for the identity move as well, which is
     * correct as a statement about the lifecycle and wrong as an answer to this
     * request: setting a ticket to the status it already has changed nothing
     * and should not be an error. So "no change" is filtered out first, and
     * what reaches `canTransition` is a real move.
     *
     * 409 rather than 400: nothing about the payload is malformed — "closed" is
     * a status, and this ticket simply cannot become it. Re-validating the body
     * would not help the caller, which is the line HttpError.conflict draws.
     */
    const nextStatus =
      input.status !== undefined && input.status !== current.status
        ? input.status
        : undefined;

    if (nextStatus && !canTransition(current.status, nextStatus)) {
      throw HttpError.conflict(
        `A ${current.status} ticket cannot become ${nextStatus}.`,
      );
    }

    const changes = {
      ...(input.assigneeId !== undefined
        ? { assignedToId: input.assigneeId }
        : {}),
      ...(nextStatus ? { status: nextStatus } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
    };

    // Skipping an empty write is not an optimisation. `updatedAt` is
    // `$onUpdate`, so an UPDATE that sets nothing would still restamp it and
    // move the ticket to the top of the queue's default sort — a PATCH that
    // changed nothing must not reorder the queue.
    if (Object.keys(changes).length > 0) {
      await db.update(ticket).set(changes).where(eq(ticket.id, id.data));
    }

    // Read back rather than returning the updated row: the response names the
    // assignee, and the UPDATE knows only their id. `updatedAt` comes back
    // freshly stamped here too, which is what the page's "Updated" line shows.
    const detail = await findTicketDetail(db, id.data);
    if (!detail) throw HttpError.notFound(`Ticket ${id.data} not found`);

    const body: UpdateTicketResponse = detail;
    res.json(body);
  });

  return router;
}
