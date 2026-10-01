import { z } from "zod";
import {
  ticketAutoResolutionSchema,
  ticketCategorySchema,
  ticketClassificationSchema,
  ticketHandlerSchema,
  ticketStatusSchema,
  userRoleSchema,
} from "./domain.ts";

/** Shape every error response uses. The SPA renders `message`. */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const healthSchema = z.object({
  status: z.literal("ok"),
  uptimeSeconds: z.number(),
});
export type Health = z.infer<typeof healthSchema>;

export const readinessSchema = z.object({
  status: z.enum(["ready", "degraded"]),
  checks: z.object({
    database: z.enum(["up", "down"]),
  }),
});
export type Readiness = z.infer<typeof readinessSchema>;

export const userSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string(),
  role: userRoleSchema,
});
export type User = z.infer<typeof userSchema>;

/**
 * A staff row in the admin user list. `emailVerified` is deliberately absent:
 * HTTP sign-up is closed and the seed script never sets it, so it is `false` for
 * every row that can exist — surfacing it would tell an admin their whole team
 * is unverified.
 */
export const userSummarySchema = userSchema.extend({
  createdAt: z.string().datetime(),
});
export type UserSummary = z.infer<typeof userSummarySchema>;

/**
 * A ticket as the list view needs it. One row is one email that arrived at the
 * support address; there is no thread yet, so there is no message count.
 *
 * The assignee is deliberately *not* here, and its absence is the same
 * judgement `body`'s is: the queue does not show who owns a ticket, so putting
 * the assignee on the summary would make every list request pay for a join
 * nothing renders. It lives on `ticketDetailSchema` instead. Adding an
 * assignee column to the queue is what would move it up here — along with the
 * join, a sort key and a filter, which is why it is a decision rather than a
 * field.
 *
 * `category` is nullable because nothing classifies. An email carries no
 * category of its own, and with no AI in the pipeline the only way a ticket
 * gets one is a human (or a sender that stated it — see `inboundEmailSchema`).
 * A default of "general questions" would be a guess the UI could not tell from
 * a decision, so unclassified is spelled null.
 */
export const ticketSummarySchema = z.object({
  id: z.string().uuid(),
  subject: z.string(),
  /**
   * The display name off the From header, when the delivering source had one.
   * Nullable because plenty of mail carries a bare address, and because every
   * ticket ingested before this field existed has none — so a renderer must
   * always be able to fall back to `studentEmail`.
   */
  studentName: z.string().nullable(),
  studentEmail: z.string().email(),
  /**
   * The opening of the email, whitespace collapsed and cut at
   * `TICKET_PREVIEW_LENGTH` characters — see `ticketPreview` in the API.
   *
   * It is the answer to the note under this schema: the list still does not
   * ship whole emails, but a subject alone is often not enough to triage by
   * ("cant login", "Question"), and the first line of the body usually is. Cut
   * on the server so a page costs a few hundred bytes a row, not a few
   * kilobytes. It does not say whether it was cut; a renderer that needs the
   * whole thing opens the ticket.
   */
  preview: z.string(),
  status: ticketStatusSchema,
  category: ticketCategorySchema.nullable(),
  /**
   * What the automatic classifier did with this ticket, which `category` alone
   * cannot say — see `TICKET_CLASSIFICATIONS`.
   *
   * It is on the *summary* rather than on the detail, unlike `assignee`, and
   * the reason is the opposite of the one that keeps the assignee off: this
   * costs no join, it is a column already on the row, and the queue is exactly
   * where it has to be readable. Classification happens after the 201, so the
   * first thing anyone sees of a new ticket is a list row with no category —
   * and without this field that row cannot tell "an answer is coming" from
   * "nobody is going to classify this".
   */
  classification: ticketClassificationSchema,
  /**
   * What the automatic resolver did with this ticket — see
   * `TICKET_AUTO_RESOLUTIONS`.
   *
   * On the summary for the reason `classification` is, and then for one more:
   * the queue *filters* on it. `handledBy` hides the rows the assistant owns,
   * so a row that made it onto the page has already passed that test — and the
   * field is what lets the page say which of the remaining ones the assistant
   * looked at and handed back. Without it an escalated ticket and a ticket
   * nobody ever asked about are the same row, which is the distinction
   * `TICKET_AUTO_RESOLUTIONS` exists to keep.
   */
  autoResolution: ticketAutoResolutionSchema,
  receivedAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type TicketSummary = z.infer<typeof ticketSummarySchema>;

/**
 * The list deliberately does not carry `body`: a page of 25 tickets would then
 * ship 25 full emails to render 25 subject lines. It carries `preview`, the
 * first line or so, and fetching the whole email is what GET /api/tickets/:id
 * is for.
 */
export const ticketDetailSchema = ticketSummarySchema.extend({
  body: z.string(),
  supportEmail: z.string().email(),
  /**
   * The staff member who owns this ticket, resolved rather than left as an id:
   * the page renders a name, and a bare `assigneeId` would make every viewer
   * fetch the staff list just to turn it into one.
   *
   * `userSchema` rather than a narrower assignee shape, because it is the same
   * person the user routes describe — a second definition of "a staff member"
   * is a thing to keep in sync for no gain.
   *
   * Null is unassigned, which is how every ticket arrives: nothing routes, so
   * an owner is always a human decision. It stays null after a soft delete of
   * whoever was assigned — the user row survives a delete precisely so a ticket
   * can still name who handled it, so the assignee here may be an account that
   * appears in no list and can no longer sign in.
   */
  assignee: userSchema.nullable(),
});
export type TicketDetail = z.infer<typeof ticketDetailSchema>;

/**
 * Rows per page in the ticket queue, and the API's default `limit`.
 *
 * One constant rather than two matching numbers: the SPA divides `total` by it
 * to render "Page 3 of 10", so a server default that disagreed with the client's
 * page size would produce a page count that is quietly wrong — ten pages
 * claimed, twenty delivered.
 */
export const TICKET_PAGE_SIZE = 10;

/**
 * How much of an email `TicketSummary.preview` carries: about one line of the
 * queue at desktop width, with room for the renderer to ellipsis it.
 */
export const TICKET_PREVIEW_LENGTH = 160;

/**
 * The columns `GET /api/tickets` will sort by, and the ids the ticket table's
 * columns carry so a header click maps to one of these without a lookup table
 * in between.
 *
 * `sender` is one key rather than two because it is one column on screen: the
 * cell renders the display name and falls back to the address, and the server
 * orders by exactly that fallback. Sorting by the raw `student_name` would
 * gather every nameless sender into one block that reads as unsorted.
 *
 * `updatedAt` has no column in the table and is here anyway — nothing else
 * exposes "recently touched", and it costs a string.
 */
export const TICKET_SORT_KEYS = [
  "subject",
  "sender",
  "status",
  "category",
  "createdAt",
  "updatedAt",
] as const;
export const ticketSortKeySchema = z.enum(TICKET_SORT_KEYS);
export type TicketSortKey = z.infer<typeof ticketSortKeySchema>;

/**
 * Query params for GET /api/tickets. Parsed with this on the server.
 *
 * Sorting is a server concern, not a table one: the SPA holds one page of a
 * cursor-paginated list, so re-ordering the rows it happens to have would sort
 * a sample and present it as the queue. The table sends `sort`/`order` and
 * renders what comes back.
 */
export const listTicketsQuerySchema = z.object({
  status: ticketStatusSchema.optional(),
  category: ticketCategorySchema.optional(),
  /**
   * Which tickets the queue is being asked about — and the one filter here with
   * a non-neutral default.
   *
   * `human` excludes the tickets the assistant is answering or has answered, so
   * a bare `GET /api/tickets` is the work a person still has to do. That is the
   * point of auto-resolution: a ticket the machine is handling must not sit in
   * someone's queue, and a reader who has to remember to filter it out is a
   * reader who occasionally answers a student twice.
   *
   * Defaulted in the schema rather than applied in the route, so every caller
   * gets it: the SPA, a `curl`, and the count query that produces the page
   * numbers. A default that lived in the handler would be one the response's
   * `total` could disagree with.
   */
  handledBy: ticketHandlerSchema.default("human"),
  /**
   * Free-text search across the subject, the sender and the email body.
   *
   * Blank becomes `undefined` rather than an empty pattern, because the two are
   * not the same question: `q=` would otherwise reach the server as a search
   * for nothing, which matches everything by accident. Clearing the box has to
   * mean "no search", and it is spelled once here rather than guarded at each
   * of the two call sites.
   *
   * Capped at 200 characters. A search term longer than a subject line is a
   * paste accident, and the pattern goes into a LIKE that scans every row.
   */
  q: z
    .string()
    .trim()
    .max(200, "Search term is too long.")
    .optional()
    .transform((value) => value || undefined),
  sort: ticketSortKeySchema.default("createdAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
  /**
   * Ten, matching the queue's page size, so a request that omits it gets the
   * same page the UI would ask for. The ceiling stays at 100 — that is the
   * export-shaped request, not a page anyone reads.
   */
  limit: z.coerce.number().int().min(1).max(100).default(TICKET_PAGE_SIZE),
  cursor: z.string().optional(),
});
export type ListTicketsQuery = z.infer<typeof listTicketsQuerySchema>;

export const listTicketsResponseSchema = z.object({
  data: z.array(ticketSummarySchema),
  nextCursor: z.string().nullable(),
  /**
   * How many tickets match the filters, ignoring the cursor — the total the
   * queue is a page of, not the size of this page.
   *
   * It costs a second query per request, which cursor pagination exists partly
   * to avoid, and it is here anyway because "Page 3 of 10" cannot be computed
   * from a cursor. A cursor knows there is a next page; it has no idea how many
   * follow. The alternative is a Prev/Next pair with no sense of where you are
   * in the queue, which is worse than the count is expensive at this size.
   */
  total: z.number().int().nonnegative(),
});
export type ListTicketsResponse = z.infer<typeof listTicketsResponseSchema>;

/**
 * Body for PATCH /api/tickets/:id. Any signed-in staff may send it.
 *
 * `strictObject`, for the reason `inboundEmailBodySchema` is one: a plain
 * `z.object` strips keys it does not know, so a caller that spelled the field
 * `assignee` would be answered 200 having changed nothing. A 400 naming the
 * unknown key is the only version of that a caller can act on.
 *
 * `assigneeId` is optional *and* nullable, and the two mean different things —
 * this is a PATCH, so absent is "leave it alone" and an explicit null is
 * "unassign". Collapsing them would make it impossible to hand a ticket back to
 * the unassigned pool, which is the move an agent makes when they cannot take
 * it after all.
 *
 * Three fields, all optional, and a body naming none of them is a read rather
 * than an error — which is what makes this one route rather than three, and why
 * it was never `PATCH /api/tickets/:id/assignee`. The SPA sends exactly the
 * field the reader changed.
 */
export const updateTicketBodySchema = z.strictObject({
  assigneeId: z.string().uuid().nullable().optional(),
  /**
   * Not nullable, unlike the other two: a ticket always has a status. The
   * server additionally checks the move against `TICKET_STATUS_TRANSITIONS` —
   * "is this a status" is a question the schema can answer, "may this ticket
   * become that" is not, because the answer depends on the row.
   */
  status: ticketStatusSchema.optional(),
  /**
   * Nullable, because "unclassified" is a real answer and the only one every
   * ticket starts with — nothing classifies. Sending null is how a human takes
   * a category back off, which the same optional/nullable split as `assigneeId`
   * keeps distinguishable from not mentioning it.
   */
  category: ticketCategorySchema.nullable().optional(),
});
export type UpdateTicketBody = z.infer<typeof updateTicketBodySchema>;

/** The updated ticket, in the same shape GET /api/tickets/:id answers with. */
export const updateTicketResponseSchema = ticketDetailSchema;
export type UpdateTicketResponse = TicketDetail;

/**
 * How long a reply may be.
 *
 * Generous by the standards of a form and tight by the standards of a `text`
 * column, which is the point: the ceiling exists so a paste accident or a
 * scripted caller cannot write an unbounded row, not to tell an agent how much
 * to explain. It is in the shared schema, so the form counts against the same
 * number the API enforces.
 */
export const TICKET_REPLY_MAX_LENGTH = 10_000;

/**
 * One reply on a ticket's thread — what a member of staff said back.
 *
 * This is deliberately not the same shape as the ticket's own `body`. That is
 * the email that created the ticket, and it has a student on the other end of
 * it; a reply has a staff account, which is why `author` is a `User` rather
 * than a name and an address. The detail page renders the email first and the
 * thread under it for the same reason.
 *
 * `author` is not nullable: `ticket_reply.author_id` is NOT NULL with a foreign
 * key, so the row cannot exist without one, and the route joins rather than
 * left-joins to say so. A soft-deleted colleague still appears here — the user
 * row survives a delete precisely so past work can name who did it — so a
 * byline may name an account that is in no list and can no longer sign in.
 *
 * There is no `updatedAt` and no edit route: a reply is a thing that was said.
 */
export const ticketReplySchema = z.object({
  id: z.string().uuid(),
  /**
   * The ticket it belongs to. Redundant with the URL it was fetched from, and
   * carried anyway so a reply is self-describing once it is out of that
   * response — the SPA writes these into a per-ticket cache entry, and a shape
   * that only makes sense next to the request that produced it is the kind that
   * gets mis-filed.
   */
  ticketId: z.string().uuid(),
  body: z.string(),
  author: userSchema,
  createdAt: z.string().datetime(),
});
export type TicketReply = z.infer<typeof ticketReplySchema>;

/**
 * GET /api/tickets/:id/replies — a ticket's whole thread, oldest first.
 *
 * Unpaginated, for the reason `listAssigneesResponseSchema` is: a thread is
 * read as a conversation, and a conversation with a "load more" in the middle
 * of it is one the reader has to reassemble. A support ticket answered a
 * hundred times is a different problem from a pagination one.
 *
 * A separate request rather than a field on `ticketDetailSchema`, which is the
 * one design decision here worth stating. PATCH /api/tickets/:id answers with a
 * `TicketDetail`, so a thread on that shape would be re-sent in full every time
 * someone changed a status — and the two have different lifetimes in the SPA's
 * cache, since posting a reply must not invalidate the ticket and changing a
 * status must not refetch the thread.
 */
export const listTicketRepliesResponseSchema = z.object({
  data: z.array(ticketReplySchema),
});
export type ListTicketRepliesResponse = z.infer<
  typeof listTicketRepliesResponseSchema
>;

/**
 * Body for POST /api/tickets/:id/replies. Any signed-in staff member may send
 * one, like PATCH beside it and for the same reason: answering a student is the
 * work, not a supervisor act.
 *
 * The author is absent deliberately rather than forgotten — it comes from the
 * session, the way `role` is refused on the user writes. A body that could name
 * its own author would let anyone sign a reply with a colleague's name.
 *
 * `strictObject`, like every other write here: a plain `z.object` strips a key
 * it does not know, so a caller that spelled the field `text` would be answered
 * 201 having posted an empty reply — except it would not, because `body` is
 * required, which is the version of that failure with a message attached.
 */
/**
 * The reply text, as both writes that take one accept it: trimmed, required,
 * and capped at `TICKET_REPLY_MAX_LENGTH`.
 *
 * A factory rather than one shared field, because the two callers say different
 * things about an empty box — you send a reply and you polish a draft — while
 * the *ceiling* is the part that must not drift: a draft the polisher accepted
 * and the send route then rejected would be a dead end reached only after the
 * model had been paid for.
 */
function ticketReplyBodyField(emptyMessage: string) {
  return z
    .string()
    .trim()
    .min(1, emptyMessage)
    .max(
      TICKET_REPLY_MAX_LENGTH,
      `A reply cannot be longer than ${TICKET_REPLY_MAX_LENGTH.toLocaleString("en-US")} characters.`,
    );
}

export const createTicketReplyBodySchema = z.strictObject({
  /**
   * Trimmed, then required. A reply of only whitespace is a misfire — the
   * Enter key on an empty box — and storing one puts a blank bubble in a thread
   * that nobody can delete.
   */
  body: ticketReplyBodyField("Write a reply before sending it."),
});
export type CreateTicketReplyBody = z.infer<typeof createTicketReplyBodySchema>;

/** POST /api/tickets/:id/replies answers 201 with the reply it created. */
export const createTicketReplyResponseSchema = ticketReplySchema;
export type CreateTicketReplyResponse = TicketReply;

/**
 * Body for POST /api/tickets/:id/replies/polish — the draft an agent has typed,
 * on its way to a language model that rewrites it.
 *
 * Ticket-scoped rather than a general "improve this text" endpoint, and that is
 * the design decision here: the route reads the ticket the draft answers and
 * puts the student's own words in the prompt, so the rewrite can keep a
 * reference to what was actually asked. A context-free polisher would have to
 * guess, and its guesses would be the parts an agent has to undo.
 *
 * `strictObject` for the reason its neighbour is: a caller that spelled the
 * field `text` must be answered rather than have the draft silently dropped and
 * a rewrite of nothing returned.
 */
export const polishTicketReplyBodySchema = z.strictObject({
  body: ticketReplyBodyField("Write a draft before polishing it."),
});
export type PolishTicketReplyBody = z.infer<typeof polishTicketReplyBodySchema>;

/**
 * The rewritten draft, and nothing else.
 *
 * Deliberately not a `TicketReply`: polishing writes no row and creates
 * nothing. What comes back is text for the box the agent is still typing in,
 * which they are free to edit or ignore — the send is a separate, explicit act,
 * and keeping the shapes distinct is what stops a polish from ever reading like
 * something that was said.
 */
export const polishTicketReplyResponseSchema = z.object({
  body: z.string().max(TICKET_REPLY_MAX_LENGTH),
});
export type PolishTicketReplyResponse = z.infer<
  typeof polishTicketReplyResponseSchema
>;

/**
 * How long a generated summary may be.
 *
 * Short by design, and the number is a policy rather than a guess: a summary
 * that runs to a page is one an agent skims instead of reading, which is the
 * one failure mode that makes the button worse than useless — it would be
 * quicker to read the ticket. The model is told to be brief and this is what
 * happens when it is not, so it is a ceiling the API refuses at rather than a
 * hint it rounds off.
 *
 * Note the neighbour it is easy to confuse: `ticketSummarySchema` above is a
 * ticket's *list row* and has nothing to do with this. That name predates the
 * feature, and renaming it would touch the queue, its cursor and both test
 * suites for a word.
 */
export const TICKET_SUMMARY_MAX_LENGTH = 2_000;

/**
 * POST /api/tickets/:id/summary — what a language model made of the ticket and
 * everything said on it since.
 *
 * **The request carries no body, and that is the design decision here.** The
 * material is the ticket's email plus its whole reply thread, and the server
 * already holds both; a body would let a caller hand in text of their own and
 * be answered with a summary of something that is not on the ticket. It is the
 * mirror image of `polishTicketReplyBodySchema`, where the draft is the point
 * and only the agent has it.
 *
 * Nothing is stored. Each press regenerates — there is no `summarizedAt`
 * column, no cache key, and a second press on a thread that has grown by one
 * reply is expected to answer differently. A stored summary would need
 * invalidating every time anyone replied, and a stale one is worse than none:
 * it is wrong in exactly the way nobody checks.
 *
 * A separate request from the ticket rather than a field on
 * `ticketDetailSchema`, for the reason the thread is one — a summary costs a
 * model call, and putting it on that shape would mean paying for one every time
 * someone changed a status.
 */
export const summarizeTicketResponseSchema = z.object({
  summary: z.string().max(TICKET_SUMMARY_MAX_LENGTH),
});
export type SummarizeTicketResponse = z.infer<
  typeof summarizeTicketResponseSchema
>;

/**
 * How many days of arrivals the dashboard's trend chart covers.
 *
 * One constant for the SQL window, the chart's bar count and the sentence that
 * says "30 days", for the reason `TICKET_PAGE_SIZE` is one: three numbers that
 * have to match are three numbers that drift, and the one that drifts silently
 * here is the label — a chart of 30 bars captioned "the last 14 days" is wrong
 * in a way nobody can see.
 */
export const TICKET_TREND_DAYS = 30;

/** `YYYY-MM-DD`, the calendar day in the zone the counts were bucketed by. */
const calendarDaySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date.");

/**
 * One day's arrivals: tickets whose `created_at` falls on this calendar day.
 *
 * A bare date rather than a timestamp, and that is the whole point of the
 * bucketing — the server has already decided which day each ticket belongs to,
 * because only the server knows the zone that decision was made in. A
 * timestamp here would invite the browser to re-derive the day and land on a
 * different one.
 */
export const ticketsPerDaySchema = z.object({
  date: calendarDaySchema,
  count: z.number().int().nonnegative(),
});
export type TicketsPerDay = z.infer<typeof ticketsPerDaySchema>;

/**
 * Is this a zone Postgres and `Intl` will both accept?
 *
 * Validated here rather than left to the database, because an unknown zone
 * reaches `timezone(?, …)` as a runtime error — a 500 blaming this API for a
 * caller's typo. `Intl` throws a `RangeError` for anything its tz database does
 * not know, which is the same IANA database Postgres ships, so this is the
 * cheapest check that agrees with the thing that will actually run.
 */
function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Query params for `GET /api/stats`.
 *
 * **`tz` exists because "tickets per day" has no answer without one.** A day is
 * a range of instants and which range depends on where you are standing:
 * bucketing in UTC puts a ticket that arrived at 9pm in Tehran on the following
 * day, so an agent's busiest evening shows up on a bar labelled tomorrow and
 * today's bar is missing its last few hours. The reader's own zone is the only
 * one under which the chart says what it appears to say.
 *
 * Defaulted to UTC rather than required, so a `curl` still works and so a
 * browser that reports no zone gets a defined answer rather than a 400. The SPA
 * always sends one.
 */
export const ticketStatsQuerySchema = z.object({
  tz: z.string().refine(isTimeZone, "Unknown time zone.").default("UTC"),
});
export type TicketStatsQuery = z.infer<typeof ticketStatsQuerySchema>;

/**
 * The dashboard's numbers, in one response.
 *
 * Counts rather than percentages and rates, on purpose. A percentage is a
 * division, and a division shipped over the wire is a second place the
 * numerator and denominator can be chosen — so a tile reading "38% resolved by
 * AI" beside tiles reading 100 and 38 could disagree with them and nothing on
 * screen would say which was wrong. The SPA derives the share from `aiResolved`
 * and `total`, which is the only reading that can be checked against the tiles
 * next to it.
 *
 * Unfiltered, and that is the point of a dashboard as opposed to the queue.
 * `GET /api/tickets` defaults `handledBy` to `human` and therefore hides the
 * assistant's tickets; counting what it returns would answer "how many tickets
 * has the AI resolved" with a number that excludes exactly those. These counts
 * are over the whole table.
 */
export const ticketStatsSchema = z.object({
  /** Every ticket ever ingested, whoever handled it and whatever became of it. */
  total: z.number().int().nonnegative(),
  /** `status = 'open'` — the work outstanding, including what the assistant is mid-way through. */
  open: z.number().int().nonnegative(),
  /** `status = 'resolved'`, however it got there: by a person or by the assistant. */
  resolved: z.number().int().nonnegative(),
  /**
   * `auto_resolution = 'resolved'` — the assistant answered the student from
   * the knowledge base and closed the ticket behind it.
   *
   * Read off `autoResolution` rather than `status`, because the two answer
   * different questions and only this one is about the assistant. A ticket the
   * assistant resolved and a colleague then reopened is no longer `resolved`
   * and was still resolved by the AI; a ticket a person closed by hand is
   * `resolved` and was not.
   */
  aiResolved: z.number().int().nonnegative(),
  /**
   * `auto_resolution = 'escalated'` — the assistant read the ticket and handed
   * it back. Here so `aiResolved` has something to be a share *of*: a
   * resolution rate with no view of the refusals is a number that cannot be
   * told from an assistant nobody ever asked.
   */
  aiEscalated: z.number().int().nonnegative(),
  /**
   * Mean seconds from `created_at` to `resolved_at`, over the tickets that
   * carry both.
   *
   * Null rather than 0 when nothing qualifies, because "no ticket has been
   * resolved yet" and "every ticket was resolved instantly" are opposite facts
   * and 0 is how a dashboard states the second one by accident.
   */
  averageResolutionSeconds: z.number().nonnegative().nullable(),
  /**
   * How many tickets that average was taken over.
   *
   * It is not `resolved` and it is not `total`: `resolved_at` is only recorded
   * from the migration that added the column onward, so every ticket resolved
   * before it reads as null and is excluded. Shipping the sample size is what
   * lets the page say "across 12 tickets" instead of presenting an average of
   * twelve as an average of the whole queue.
   */
  resolutionSampleSize: z.number().int().nonnegative(),
  /**
   * Arrivals per calendar day over the last `TICKET_TREND_DAYS` days, oldest
   * first, in the zone named by the request's `tz`.
   *
   * **Always exactly `TICKET_TREND_DAYS` entries, including the empty days.**
   * A `GROUP BY` answers only about days that have rows, so a quiet weekend
   * would arrive as two missing entries and a 30-bar chart would draw 28 — not
   * as a visible gap, but by sliding every later bar left onto the wrong date.
   * The zero-fill is the server's job because the response has to be a complete
   * statement about the window it names.
   *
   * On the same response as the counts above rather than behind its own route,
   * so a reader gets one screen describing one moment. Two requests would be
   * two moments, and the version that ships is the one where they disagree.
   */
  daily: z.array(ticketsPerDaySchema),
});
export type TicketStats = z.infer<typeof ticketStatsSchema>;

/**
 * Who a ticket may be assigned to: every staff account that has not been
 * deleted, in one unpaginated list.
 *
 * Unpaginated deliberately, unlike `GET /api/users` beside it. This feeds a
 * picker, and a picker needs every option at once — a cursor would mean the
 * person you are looking for might be on a page the control never fetched. The
 * two lists also answer different questions: the user list is the admin
 * directory and carries `createdAt`, this is "who can own a ticket" and is open
 * to every signed-in agent, because agents claim and hand off their own work.
 *
 * When a support team outgrows a select this wants a search, not a cursor.
 */
export const listAssigneesResponseSchema = z.object({
  data: z.array(userSchema),
});
export type ListAssigneesResponse = z.infer<typeof listAssigneesResponseSchema>;

/**
 * Query params for GET /api/users. Admin-only; parsed with this on the server.
 *
 * No `sort`/`order` pair, unlike the ticket list: the order is fixed at
 * `email asc`. `email` is the only NOT NULL UNIQUE column on the user table, so
 * it is a total order on its own and its unique index already provides the sort
 * — which is what makes the keyset cursor a single opaque string. `createdAt`
 * has no index and cannot get one without hand-editing generated auth schema.
 */
export const listUsersQuerySchema = z.object({
  role: userRoleSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

export const listUsersResponseSchema = z.object({
  data: z.array(userSummarySchema),
  nextCursor: z.string().nullable(),
});
export type ListUsersResponse = z.infer<typeof listUsersResponseSchema>;

/**
 * Body for POST /api/users. Admin-only. The server parses requests with it and
 * the SPA's create-user form resolves against it, so "valid" has exactly one
 * definition and the two sides cannot drift into disagreeing about it.
 *
 * `role` is absent deliberately rather than forgotten. `role` is `input: false`
 * on the Better Auth user model (apps/api/src/auth.ts), so no payload can grant
 * one — every account created here starts on the column default, "agent", and
 * promoting someone stays a separate act.
 *
 * The trims run before the length checks, so "  Al  " fails the 3-character
 * floor instead of being stored as a 2-character name. The password is trimmed
 * on the same reasoning — surrounding whitespace in one is almost always a paste
 * artefact. Note the asymmetry that buys: the login form's schema
 * (apps/web/src/routes/LoginPage.tsx) does not trim, so a password whose
 * leading or trailing spaces are deliberate can be set here and then never
 * typed back in. Trim in both places or neither; today it is only here.
 *
 * Strict, unlike the read schemas: a plain `z.object` *strips* unknown keys, so
 * a payload carrying `role: "admin"` would be accepted and quietly downgraded.
 * On a write that mints credentials, an attempt to set a field this endpoint
 * refuses to honour should be answered, not ignored.
 */
export const createUserBodySchema = z.strictObject({
  name: z.string().trim().min(3, "Name must be at least 3 characters."),
  // Lowercased, and that is not cosmetic. Better Auth stores the address
  // lowercased at sign-up and its `findUserByEmail` lowercases the address it
  // is given before comparing it to the column, so a stored address carrying a
  // capital can never be matched by any sign-in — and no password reset helps,
  // because the lookup fails before a password is ever checked. Creating a user
  // goes through Better Auth and is normalised for free; editing one writes the
  // column directly, so without this an admin who types "Ada@..." locks the
  // account out permanently.
  email: z.string().trim().toLowerCase().email("Enter a valid email address."),
  // Better Auth enforces a floor of 8 itself; stating it here turns a rejected
  // API call into a message under the field.
  password: z.string().trim().min(8, "Password must be at least 8 characters."),
});
export type CreateUserBody = z.infer<typeof createUserBodySchema>;

/** POST /api/users answers 201 with the created row, shaped like a list entry. */
export const createUserResponseSchema = userSummarySchema;
export type CreateUserResponse = z.infer<typeof createUserResponseSchema>;

/**
 * Body for PATCH /api/users/:id. Admin-only, and reuses `createUserBodySchema`'s
 * own field schemas rather than restating them, so "valid name" has one
 * definition across create and edit instead of two that drift.
 *
 * `role` is absent for the same reason it is absent from create: it is
 * `input: false` on the Better Auth user model, so no payload can grant one.
 * Editing a user therefore cannot promote them, and `strictObject` answers an
 * attempt rather than silently dropping the field.
 *
 * The password is the one field that differs, and it carries the feature's
 * central rule: **absent or blank means leave the existing password alone**.
 * That is expressed as trim → allow-empty → transform-to-undefined rather than
 * as a union, because a `z.union` reports a failure as "invalid input" and
 * would replace the per-field message the form renders under the input. By the
 * time a handler sees the parsed body, "" and "   " and omitted are all
 * `undefined`, so the route has exactly one case to branch on.
 */
export const updateUserBodySchema = z.strictObject({
  name: createUserBodySchema.shape.name,
  email: createUserBodySchema.shape.email,
  password: z
    .string()
    .trim()
    .refine(
      (value) => value === "" || value.length >= 8,
      "Password must be at least 8 characters.",
    )
    .optional()
    .transform((value) => (value === "" ? undefined : value)),
});
export type UpdateUserBody = z.infer<typeof updateUserBodySchema>;

/**
 * What the edit form holds, which is not what the API receives: the password
 * input is always a string, and only the transform above turns a blank one into
 * "unchanged". `useForm` is typed with this so an untouched field is "" rather
 * than an input React would call uncontrolled.
 */
export type UpdateUserFormValues = z.input<typeof updateUserBodySchema>;

/** PATCH /api/users/:id answers 200 with the updated row, shaped like a list entry. */
export const updateUserResponseSchema = userSummarySchema;
export type UpdateUserResponse = z.infer<typeof updateUserResponseSchema>;

/**
 * DELETE /api/users/:id answers 200 with the row it marked, not 204.
 *
 * A body at all, because `request()` in the SPA parses every response with a
 * schema and a 204 carries nothing to parse. `deletedAt` rather than a bare
 * `{ ok: true }`, because the deletion is soft: the timestamp is the whole
 * state change, and returning it means a caller never has to assume the
 * server's clock agreed with its own.
 *
 * No `role` and no `email`: the row is gone from every list the moment this
 * returns, and the SPA's only job with the response is to stop showing it.
 */
export const deleteUserResponseSchema = z.object({
  id: z.string().uuid(),
  deletedAt: z.string().datetime(),
});
export type DeleteUserResponse = z.infer<typeof deleteUserResponseSchema>;

/**
 * Body for POST /api/inbound-email — one email that arrived at the support
 * address, already normalised.
 *
 * This is the seam a mail provider plugs into rather than the provider's own
 * payload. There is no provider yet, so the shape is chosen to be the small
 * intersection every one of them can produce: a Mailgun or SES adapter's whole
 * job becomes mapping its webhook onto this and posting it. Nothing downstream
 * ever sees a provider-shaped object, so adding a second provider later is a
 * new adapter and no change here.
 *
 * `strictObject`, like the user writes and for a sharper version of the same
 * reason: a plain `z.object` strips unknown keys, so an adapter that spelled a
 * field `bodyText` instead of `text` would have the email's entire contents
 * silently dropped and still be answered 201. On an endpoint whose only job is
 * not to lose mail, a key this schema does not know is a bug worth reporting.
 */
export const inboundEmailBodySchema = z.strictObject({
  /**
   * The sender, which becomes the ticket's `studentEmail`. Lowercased for the
   * same reason `createUserBodySchema.email` is: it is the key everything about
   * this person is later grouped by, and "Ada@…" and "ada@…" are one student.
   */
  from: z.string().trim().toLowerCase().email("Enter a valid sender address."),
  /**
   * The display name half of `From: "Ada Student" <ada@example.com>`, already
   * split off the address. Splitting it is the adapter's job, not this
   * schema's: RFC 5322 allows quoted strings, escapes and RFC 2047 encoded
   * words in there, and a regex over the raw header in a package the browser
   * also imports would be the wrong place to get that wrong.
   *
   * Blank becomes undefined so a source that always sends the field, empty,
   * does not store an empty string the UI would render as a nameless gap.
   */
  fromName: z
    .string()
    .trim()
    .max(255)
    .optional()
    .transform((value) => value || undefined),
  /**
   * The support address it was delivered to. Required rather than assumed: the
   * route checks it against SUPPORT_EMAIL, which is what stops this endpoint
   * from being a general-purpose "create a ticket for any address" API.
   */
  to: z.string().trim().toLowerCase().email("Enter a valid support address."),
  /**
   * Real mail arrives with an empty subject often enough that rejecting it
   * would lose tickets. Normalised here instead, so the column is NOT NULL and
   * every renderer has something to print.
   */
  subject: z
    .string()
    .trim()
    .max(998, "Subject exceeds the RFC 5322 line limit.")
    .transform((value) => value || "(no subject)"),
  /** The plain-text body. An email with nothing in it is not a ticket. */
  text: z.string().trim().min(1, "The email body is empty."),
  /**
   * The provider's Message-ID. Optional because not every source has one, but
   * supplying it is what makes delivery idempotent: the column is UNIQUE, so a
   * provider that retries its webhook gets the ticket it already created rather
   * than a duplicate. Without one, a retry is indistinguishable from a student
   * sending the same thing twice, and both make a new ticket.
   */
  messageId: z.string().trim().min(1).max(998).optional(),
  /**
   * When the mail was received, per the provider. Optional and defaulted at the
   * route rather than here, because "now" belongs to the server's clock and a
   * schema shared with the browser must not read it.
   */
  receivedAt: z.string().datetime().optional(),
  /**
   * Only set by a source that genuinely knows — a category-specific alias, or a
   * web form that asked. Nothing infers it: there is no classifier, and a guess
   * would be indistinguishable from a fact to everyone downstream.
   */
  category: ticketCategorySchema.optional(),
});
export type InboundEmailBody = z.infer<typeof inboundEmailBodySchema>;

/**
 * POST /api/inbound-email answers with the ticket, 201 when it created one and
 * 200 when `messageId` matched a delivery it had already handled. The body is
 * the same either way — a retrying provider that reads the body gets the truth
 * about where its email ended up, and the status code carries which case it was.
 */
export const inboundEmailResponseSchema = ticketDetailSchema;
export type InboundEmailResponse = z.infer<typeof inboundEmailResponseSchema>;
