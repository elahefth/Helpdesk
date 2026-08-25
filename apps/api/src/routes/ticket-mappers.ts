import type { TicketDetail, TicketSummary } from "@helpdesk/shared";
import type { ticket } from "../db/schema.ts";

type TicketRow = typeof ticket.$inferSelect;

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

export function toTicketDetail(row: TicketRow): TicketDetail {
  return {
    ...toTicketSummary(row),
    body: row.body,
    supportEmail: row.supportEmail,
  };
}
