import type {
  TicketDetail,
  TicketReply,
  TicketSummary,
  User,
} from "@helpdesk/shared";
import type { ticket, ticketReply, user } from "../db/schema.ts";

type TicketRow = typeof ticket.$inferSelect;
type TicketReplyRow = typeof ticketReply.$inferSelect;
type UserRow = typeof user.$inferSelect;

/**
 * The row-to-wire projections, shared by the two routers that produce tickets
 * so a column added to the table appears in both places or neither.
 *
 * They exist at all because the row is not the response: `timestamp` columns
 * come back as `Date`, and `ticketSummarySchema` describes ISO strings. The SPA
 * parses every response with that schema, so a `Date` here is not a cosmetic
 * difference — it is a throw in the browser.
 */
export function toTicketSummary(row: TicketRow): TicketSummary {
  return {
    id: row.id,
    subject: row.subject,
    studentName: row.studentName,
    studentEmail: row.studentEmail,
    status: row.status,
    category: row.category,
    classification: row.classification,
    autoResolution: row.autoResolution,
    receivedAt: row.receivedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The assignee is a second argument rather than a lookup, because the row alone
 * cannot answer it — `assigned_to_id` is an id, and the response carries a
 * name. Required rather than defaulted to null so a new call site has to say
 * which it is: a ticket that has just been ingested genuinely has no assignee,
 * and a caller that simply forgot to join would otherwise report the same thing
 * and look right.
 */
export function toTicketDetail(
  row: TicketRow,
  assignee: UserRow | null,
): TicketDetail {
  return {
    ...toTicketSummary(row),
    body: row.body,
    supportEmail: row.supportEmail,
    assignee: assignee ? toUser(assignee) : null,
  };
}

/**
 * A user row as the API describes one.
 *
 * Extracted when the reply thread gave the projection a second caller, and the
 * one line worth keeping is the `role` guard: the generated auth schema types
 * the column nullable even though it defaults to 'agent', and `userSchema`
 * requires it — so an unguarded NULL is not a missing badge, it is a throw
 * inside the SPA's response parse.
 */
export function toUser(row: UserRow): User {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role ?? "agent",
  };
}

/**
 * One reply, with its author resolved.
 *
 * The author is a required second argument for the reason `toTicketDetail`'s
 * assignee is — the row holds an id and the response carries a name — but it is
 * not nullable here, because `ticket_reply.author_id` is NOT NULL and the route
 * inner-joins. A reply that could not say who wrote it would be a byline the UI
 * has to invent a fallback for, and there is no honest one.
 *
 * It takes a `User` rather than a `UserRow`, unlike `toTicketDetail`, because
 * its two callers hold different things: the thread has joined rows and maps
 * them through `toUser`, while the write already has the session's user and has
 * no reason to go back to the database for a name it was handed.
 */
export function toTicketReply(row: TicketReplyRow, author: User): TicketReply {
  return {
    id: row.id,
    ticketId: row.ticketId,
    body: row.body,
    author,
    createdAt: row.createdAt.toISOString(),
  };
}
