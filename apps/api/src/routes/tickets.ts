import { Router } from "express";
import {
  and,
  asc,
  count,
  eq,
  ilike,
  inArray,
  isNull,
  notInArray,
  or,
  type SQL,
} from "drizzle-orm";
import {
  AI_HANDLED_AUTO_RESOLUTIONS,
  canTransition,
  createTicketReplyBodySchema,
  listTicketsQuerySchema,
  polishTicketReplyBodySchema,
  ticketSummarySchema,
  updateTicketBodySchema,
  type CreateTicketReplyResponse,
  type ListTicketRepliesResponse,
  type ListTicketsResponse,
  type PolishTicketReplyResponse,
  type SummarizeTicketResponse,
  type TicketDetail,
  type TicketHandler,
  type TicketReply,
  type UpdateTicketResponse,
} from "@helpdesk/shared";
import { ModelError } from "../ai/openrouter.ts";
import { createReplyPolisher, type ReplyPolisher } from "../ai/polish-reply.ts";
import {
  createTicketSummarizer,
  type TicketSummarizer,
} from "../ai/summarize-ticket.ts";
import type { Database } from "../db/client.ts";
import { ticket, ticketReply, user } from "../db/schema.ts";
import { HttpError } from "../middleware/errors.ts";
import {
  toTicketDetail,
  toTicketReply,
  toTicketSummary,
  toUser,
} from "./ticket-mappers.ts";
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
 * The `handledBy` predicate — the one filter on this route whose default hides
 * rows.
 *
 * `human` is that default, and it is the whole of "do not show tickets the
 * assistant is handling": a ticket it is reading or has already answered is not
 * work anybody should pick up, and a queue that lists one invites a second
 * answer to a student who has had one. `escalated` and `failed` are
 * deliberately *not* in `AI_HANDLED_AUTO_RESOLUTIONS` — those are the tickets
 * the assistant handed back, and handing back means appearing in the queue.
 *
 * `undefined` for `all`, so it composes into `and(...)` as no predicate rather
 * than as a tautology the planner has to see through.
 *
 * Spread rather than passed as the `readonly` tuple it is: drizzle's `inArray`
 * takes a mutable array, and the copy is two strings.
 *
 * Built from the shared constant rather than spelled out here, because the
 * SPA's empty state explains which rows are missing and the two have to agree.
 * A list that hides one set while the page explains another is worse than
 * either on its own.
 */
function matchesHandler(handler: TicketHandler): SQL | undefined {
  if (handler === "all") return undefined;

  const handled = [...AI_HANDLED_AUTO_RESOLUTIONS];

  return handler === "ai"
    ? inArray(ticket.autoResolution, handled)
    : notInArray(ticket.autoResolution, handled);
}

/**
 * One ticket with its assignee resolved, in a single round trip.
 *
 * A LEFT JOIN rather than a second SELECT, and left rather than inner: most
 * tickets are unassigned, and an inner join would answer "no such ticket" for
 * every one of them.
 *
 * It deliberately does **not** filter `user.deletedAt`, even though
 * `DELETE /api/users/:id` now unassigns a departed colleague's tickets, so the
 * join should not meet one. Filtering here would mean answering the leftovers —
 * rows assigned before that behaviour landed, or an id written some other way —
 * by silently redrawing an owned ticket as unassigned, which is a worse answer
 * than naming someone who has left. Which is also why they are still
 * unchoosable: that is `GET /api/assignees`' job, and it does filter.
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
 * One ticket's replies, oldest first, with each author resolved.
 *
 * `innerJoin`, unlike `findTicketDetail`'s left join to the assignee, and the
 * difference is the column: `author_id` is NOT NULL, so an inner join loses
 * nothing and is what types the author non-nullable all the way out to the
 * response. It deliberately does not filter `user.deletedAt` for the same
 * reason the assignee join does not — a departed colleague keeps their byline,
 * because the alternative is a thread that quietly loses track of who said
 * what.
 *
 * Shared by the thread route and the summariser, so the two cannot drift into
 * disagreeing about what "the conversation" is: a summary that saw a different
 * set of replies than the page below it would be wrong in the one way nobody
 * checks, since the reader is looking at the summary precisely to avoid
 * reading the thread.
 */
async function findTicketReplies(
  db: Database,
  id: string,
): Promise<TicketReply[]> {
  const rows = await db
    .select({ reply: ticketReply, author: user })
    .from(ticketReply)
    .innerJoin(user, eq(user.id, ticketReply.authorId))
    .where(eq(ticketReply.ticketId, id))
    // Ascending, because a thread is read top to bottom, and tiebroken by id
    // for the reason the queue's cursor is: two replies written in the same
    // millisecond are otherwise ordered by whatever the plan produced, and a
    // conversation that reshuffles between reloads reads as a bug.
    .orderBy(asc(ticketReply.createdAt), asc(ticketReply.id));

  return rows.map((row) => toTicketReply(row.reply, toUser(row.author)));
}

/**
 * A factory over the database handle, like `createUsersRouter`. It was a
 * module-level const while the list was a fixture; it reads real rows now, so
 * it takes the handle and answers for its absence.
 */
export function createTicketsRouter(
  db: Database | undefined,
  /**
   * The reply polisher, defaulted rather than injected from `app.ts` so the
   * wiring stays in one place — and a parameter rather than a module-level
   * const so a test can hand in a stub instead of reaching OpenRouter.
   * `undefined` when no key is configured, which the route answers for.
   */
  polishReply: ReplyPolisher | undefined = createReplyPolisher(),
  /** The ticket summariser, on the same terms as the polisher above. */
  summarizeTicket: TicketSummarizer | undefined = createTicketSummarizer(),
): Router {
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
      // In `filters` and not beside the cursor, like every other narrowing
      // here: the count has to see it, or the pager reports the size of a queue
      // nobody is looking at — and this one narrows every request, including
      // the ones that name no filter at all.
      matchesHandler(query.handledBy),
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
      /**
       * A human deciding the category also closes the classifier's job on this
       * ticket, which is why the two are written together and never apart.
       *
       * Without it a PATCH that lands while a classification is in flight
       * leaves the row `pending` forever: the queue's guarded UPDATE correctly
       * refuses to overwrite the category, so nothing ever moves the state off
       * `pending`, and the queue renders "Classifying…" next to a category a
       * colleague chose. `skipped` is the right terminal value rather than
       * `done` — it means "the classifier is not the author of this", which is
       * exactly what just became true, and it holds for the null case too:
       * clearing a category by hand is a decision, not an invitation to guess
       * again.
       */
      ...(input.category !== undefined
        ? { category: input.category, classification: "skipped" as const }
        : {}),
    };

    // Skipping an empty write is not an optimisation. `updatedAt` is
    // `$onUpdate`, so an UPDATE that sets nothing would still restamp it and
    // move the ticket to the top of the queue's default sort — a PATCH that
    // changed nothing must not reorder the queue.
    if (Object.keys(changes).length > 0) {
      await db
        .update(ticket)
        .set({
          ...changes,
          /**
           * A human touched this ticket, so the assistant does not get to
           * answer it. Written alongside *any* change rather than only a status
           * one, because every field here says the same thing: somebody has
           * taken this.
           *
           * It is the other half of the guard in
           * `ticket-auto-resolution.ts`'s `claim`, and the halves fail
           * differently. That one stops a job already in flight from writing
           * over this decision; this one stops the ticket sitting on `pending`
           * afterwards — which matters because `pending` is precisely what
           * `handledBy=human` hides, so a ticket an agent just assigned to
           * themselves would vanish from the queue they assigned it in. It is
           * the same statement `classification: "skipped"` makes above, and it
           * covers the same failure.
           *
           * Unconditional rather than guarded on the current value: writing
           * `skipped` over `skipped` changes nothing, and a read-modify-write
           * to avoid it would be a round trip bought to save a no-op.
           */
          autoResolution: "skipped" as const,
        })
        .where(eq(ticket.id, id.data));
    }

    // Read back rather than returning the updated row: the response names the
    // assignee, and the UPDATE knows only their id. `updatedAt` comes back
    // freshly stamped here too, which is what the page's "Updated" line shows.
    const detail = await findTicketDetail(db, id.data);
    if (!detail) throw HttpError.notFound(`Ticket ${id.data} not found`);

    const body: UpdateTicketResponse = detail;
    res.json(body);
  });

  /**
   * A ticket's reply thread, oldest first.
   *
   * `innerJoin`, unlike `findTicketDetail`'s left join to the assignee, and the
   * difference is the column: `author_id` is NOT NULL, so an inner join loses
   * nothing and is what types the author non-nullable all the way out to the
   * response. It deliberately does not filter `user.deletedAt` for the same
   * reason the assignee join does not — a departed colleague keeps their
   * byline, because the alternative is a thread that quietly loses track of who
   * said what.
   *
   * Unpaginated. A thread is read as a conversation, and a "load more" in the
   * middle of one is something the reader has to reassemble; a ticket with
   * enough replies to need a cursor is a different problem than pagination.
   */
  router.get("/tickets/:id/replies", async (req, res) => {
    const id = ticketSummarySchema.shape.id.safeParse(req.params.id);
    if (!id.success) throw HttpError.badRequest("Malformed ticket id");

    if (!db) throw HttpError.serviceUnavailable("Database unavailable");

    // The existence check is a round trip this route could skip — an unknown id
    // simply matches no replies — and it is here because "this ticket has no
    // replies yet" and "there is no such ticket" are different answers, and
    // answering the first for the second turns a dead link into an empty thread
    // that looks like a working page.
    const [exists] = await db
      .select({ id: ticket.id })
      .from(ticket)
      .where(eq(ticket.id, id.data))
      .limit(1);
    if (!exists) throw HttpError.notFound(`Ticket ${id.data} not found`);

    const body: ListTicketRepliesResponse = {
      data: await findTicketReplies(db, id.data),
    };

    res.json(body);
  });

  /**
   * Write a reply.
   *
   * Open to any signed-in staff member, like the PATCH above and unlike every
   * user route: answering a student is the work a queue exists for, not a
   * supervisor act.
   *
   * **Nothing is delivered.** There is no email provider in this repo, so this
   * records what was said and does not send it — the same gap
   * `dev/send-inbound-email.ts` stands in for on the way in. When a provider
   * lands, this is the seam it hooks into, and the reply row is what it sends.
   */
  router.post("/tickets/:id/replies", async (req, res) => {
    const id = ticketSummarySchema.shape.id.safeParse(req.params.id);
    if (!id.success) throw HttpError.badRequest("Malformed ticket id");

    // Both validations before the database check, as everywhere else here.
    // Throws ZodError, including for an unknown key — the schema is strict.
    const input = createTicketReplyBodySchema.parse(req.body);

    // `requireAuth` populates this and the router is mounted behind it, so the
    // guard is for a wiring mistake rather than for a request. It is a 401
    // because that is the fail-closed answer to not knowing who is asking —
    // and the author cannot come from the body: a payload that named its own
    // author would let anyone sign a reply with a colleague's name.
    if (!req.user) throw HttpError.unauthorized();

    req.log.debug({ ticketId: id.data }, "replying to ticket");

    if (!db) throw HttpError.serviceUnavailable("Database unavailable");

    // Read the ticket first, so an unknown id is a 404 rather than a foreign
    // key violation surfacing as a 500. Deliberately *not* a status check:
    // `closed` is terminal for the status lifecycle, and a closed ticket that
    // cannot be added to is a separate policy nobody has asked for — the
    // ordinary case is a last word after something is closed out.
    const [exists] = await db
      .select({ id: ticket.id })
      .from(ticket)
      .where(eq(ticket.id, id.data))
      .limit(1);
    if (!exists) throw HttpError.notFound(`Ticket ${id.data} not found`);

    const [row] = await db
      .insert(ticketReply)
      .values({
        ticketId: id.data,
        authorId: req.user.id,
        body: input.body,
      })
      .returning();

    // `returning()` on a single-row insert always yields it, so this is a
    // narrowing for the type rather than a case that happens.
    if (!row) throw HttpError.serviceUnavailable("Database unavailable");

    /*
     * The ticket row is deliberately left alone.
     *
     * `ticket.updatedAt` is `$onUpdate`, and the queue's default sort is on it,
     * so touching the ticket here would move it to the top of the queue every
     * time anyone replied. That is a real feature — "recently active" is what a
     * support queue usually sorts by — and it is a decision about the queue
     * rather than a side effect of this route, so it is not made here. Making
     * it later means an UPDATE in a transaction with this insert, plus the SPA
     * invalidating ["tickets"] on a successful reply.
     *
     * The author is `req.user`, which `requireAuth` built from the session, so
     * the byline needs no second lookup.
     */
    const body: CreateTicketReplyResponse = toTicketReply(row, req.user);

    res.status(201).json(body);
  });

  /**
   * Rewrite a draft reply with a language model, and write nothing.
   *
   * A separate route from the POST above rather than a flag on it, because the
   * two do different things to the world: this one produces text for a box the
   * agent is still typing in, and sending is a second, deliberate act. Folding
   * them together would mean the only way to see a polished reply is to have
   * already published it.
   *
   * Ticket-scoped for the model's sake, not the URL's: the prompt carries the
   * student's email so a rewrite knows what "it" refers to and can match the
   * register the student wrote in. See `ai/polish-reply.ts` for why that
   * context is explicitly *not* a second source of facts.
   *
   * Open to any signed-in staff member, like the reply it drafts.
   */
  router.post("/tickets/:id/replies/polish", async (req, res) => {
    const id = ticketSummarySchema.shape.id.safeParse(req.params.id);
    if (!id.success) throw HttpError.badRequest("Malformed ticket id");

    // Validated before either dependency is checked, as everywhere else here.
    // The draft is held to the same ceiling a sent reply is, so the polisher is
    // never paid for on text that could not have been sent anyway.
    const input = polishTicketReplyBodySchema.parse(req.body);

    // The same guard the reply write carries, and now for a second reason: the
    // polished reply is signed off with this name, so a request that reached
    // the model without one would come back signed by whoever the model decided
    // to be.
    if (!req.user) throw HttpError.unauthorized();

    // 503 rather than 404, and the message names the missing key: this route
    // exists, and the install simply has no model configured. An admin reading
    // "not found" would go looking for a bug in the SPA.
    if (!polishReply) {
      throw HttpError.serviceUnavailable(
        "Reply polishing is not configured on this server.",
      );
    }

    if (!db) throw HttpError.serviceUnavailable("Database unavailable");

    // The ticket is what the draft is polished against, so an unknown id is a
    // 404 here for the same reason it is on the thread routes — and it is read
    // before the model is called, so a dead link costs nothing.
    const ticket = await findTicketDetail(db, id.data);
    if (!ticket) throw HttpError.notFound(`Ticket ${id.data} not found`);

    req.log.debug({ ticketId: id.data }, "polishing a draft reply");

    let polished: string;
    try {
      polished = await polishReply(input.body, ticket, req.user.name);
    } catch (error) {
      // Only the polisher's own failures are translated. Anything else is a bug
      // in this API and belongs in the 500 the error handler gives it.
      if (!(error instanceof ModelError)) throw error;

      // Logged with the cause, which is where the provider's own message lives;
      // the client gets `error.message`, which is written to be safe to render.
      req.log.warn({ err: error }, "reply polishing failed");
      throw HttpError.badGateway(error.message);
    }

    // 200, not 201: nothing was created. The draft in the box is still the only
    // copy, and it is still the agent's.
    const body: PolishTicketReplyResponse = { body: polished };
    res.json(body);
  });

  /**
   * Summarise the ticket and everything said on it, and write nothing.
   *
   * **POST for a read, deliberately.** Nothing is created and nothing is
   * stored, so GET is the verb this looks like — and GET is the one thing it
   * must not be: a GET is what a browser, a proxy and React Query all treat as
   * free to repeat and safe to cache, and each repeat is a model call this
   * install pays for and a *different* answer. POST says the two things that
   * are true here: asking again costs something, and asking again is the point.
   *
   * **It is regenerated every time, and there is no store to read instead.**
   * The alternative — a `summary` column filled on the first press — has to be
   * invalidated by every reply, every status change and every edit, and the
   * version of that which ships is the one where it silently is not: a summary
   * describing a ticket as it stood four replies ago, presented with the same
   * confidence as a fresh one. The reader cannot tell those apart, which is
   * what makes a stale summary worse than no summary.
   *
   * The body is not read at all. The material is the ticket plus its thread,
   * both of which this route fetches — see `summarizeTicketResponseSchema` for
   * why taking text from the caller would be a different, worse endpoint.
   *
   * Open to any signed-in staff member, like the thread it summarises. Unlike
   * the polisher there is no `req.user` guard, because nothing here is signed:
   * a summary names the people in the thread, never the person reading it.
   */
  router.post("/tickets/:id/summary", async (req, res) => {
    const id = ticketSummarySchema.shape.id.safeParse(req.params.id);
    if (!id.success) throw HttpError.badRequest("Malformed ticket id");

    // 503 rather than 404, and the message names what is missing: this route
    // exists, and the install simply has no model configured. The same answer
    // the polisher gives, because it is the same missing key.
    if (!summarizeTicket) {
      throw HttpError.serviceUnavailable(
        "Ticket summaries are not configured on this server.",
      );
    }

    if (!db) throw HttpError.serviceUnavailable("Database unavailable");

    // Read before the model is called, so a dead link costs nothing. The 404
    // comes from the ticket rather than the thread — an empty thread is an
    // ordinary ticket nobody has answered yet, and summarising one is exactly
    // what a colleague picking it up wants.
    const detail = await findTicketDetail(db, id.data);
    if (!detail) throw HttpError.notFound(`Ticket ${id.data} not found`);

    const replies = await findTicketReplies(db, id.data);

    req.log.debug(
      { ticketId: id.data, replies: replies.length },
      "summarizing a ticket",
    );

    let summary: string;
    try {
      summary = await summarizeTicket(detail, replies);
    } catch (error) {
      // Only the model's own failures are translated. Anything else is a bug in
      // this API and belongs in the 500 the error handler gives it.
      if (!(error instanceof ModelError)) throw error;

      // Logged with the cause, which is where the provider's own message lives;
      // the client gets `error.message`, which is written to be safe to render.
      req.log.warn({ err: error }, "ticket summarisation failed");
      throw HttpError.badGateway(error.message);
    }

    const body: SummarizeTicketResponse = { summary };
    res.json(body);
  });

  return router;
}
