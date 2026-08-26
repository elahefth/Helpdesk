import type { TicketDetail, TicketSummary } from "@helpdesk/shared";
import type { ticket, user } from "../db/schema.ts";

type TicketRow = typeof ticket.$inferSelect;
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
    assignee: assignee
      ? {
          id: assignee.id,
          name: assignee.name,
          email: assignee.email,
          // `role` is nullable in the generated auth schema even though the
          // column defaults to 'agent' — the same guard the user routes make,
          // and for the same reason: `userSchema` requires it, so an unguarded
          // NULL throws inside the SPA's response parse.
          role: assignee.role ?? "agent",
        }
      : null,
  };
}
