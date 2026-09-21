import { z } from "zod";

/**
 * Domain vocabulary.
 *
 * These are the single source of truth for both sides of the API boundary:
 * the Drizzle enums in apps/api derive from them, and the SPA imports the
 * same values. Adding a category here is a type error everywhere it matters.
 *
 * The status and category lists are deliberately shorter than the ones in
 * project-scope.md. Those describe the classified queue an AI pipeline would
 * fill; ingestion today is plain email-to-ticket with no classifier, so a
 * vocabulary the code never writes would be a filter that always returns
 * nothing. `TICKET_PRIORITIES` and `ROUTING_QUEUES` below are the exception —
 * nothing consumes them yet, and they are kept as the shape a later phase
 * grows into.
 */

export const TICKET_STATUSES = ["open", "resolved", "closed"] as const;
export const ticketStatusSchema = z.enum(TICKET_STATUSES);
export type TicketStatus = z.infer<typeof ticketStatusSchema>;

/**
 * Legal lifecycle moves. `resolved -> open` is the student-replied reopen.
 *
 * There is no `new`: a ticket exists because an email arrived, so it is already
 * something a human has to answer. A separate "arrived but not yet looked at"
 * state would have to be cleared by someone, and nothing in this codebase does
 * that — the queue would fill with rows in a status that never changes.
 */
export const TICKET_STATUS_TRANSITIONS: Record<
  TicketStatus,
  readonly TicketStatus[]
> = {
  open: ["resolved", "closed"],
  resolved: ["open", "closed"],
  closed: [],
};

export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
  return TICKET_STATUS_TRANSITIONS[from].includes(to);
}

/**
 * How a status is written when it is a choice rather than a tag.
 *
 * The queue renders the raw value inside a badge, where lowercase reads as a
 * label; a select is a sentence the reader is completing ("Status: Resolved"),
 * and lowercase there reads as a bug. `CATEGORY_LABELS` below exists for the
 * same reason and this is its counterpart, so the two controls on the ticket
 * page are written the same way.
 */
export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  open: "Open",
  resolved: "Resolved",
  closed: "Closed",
};

export const TICKET_CATEGORIES = [
  "general_questions",
  "technical",
  "refund_request",
] as const;
export const ticketCategorySchema = z.enum(TICKET_CATEGORIES);
export type TicketCategory = z.infer<typeof ticketCategorySchema>;

export const CATEGORY_LABELS: Record<TicketCategory, string> = {
  general_questions: "General Questions",
  technical: "Technical",
  refund_request: "Refund Request",
};

/**
 * What the automatic classifier did with a ticket — which is a different
 * question from what category it ended up in, and the queue needs both.
 *
 * `category` alone cannot answer it. A ticket with no category might be one the
 * model has not reached yet, one it looked at and declined to place, one it
 * could not reach a model to ask about, or one nobody ever tried to classify —
 * and those call for four different things from the person reading the queue.
 * Rendering all four as "unclassified" is what makes a classifier that runs
 * *after* the response indistinguishable from one that is broken.
 *
 * - `skipped` — nothing was asked. The column's default, so every ticket that
 *   predates the classifier reads as this rather than as a job stuck pending;
 *   also the state of a delivery that stated its own category, of an install
 *   with no model configured, and of a ticket whose category a human has since
 *   decided. It is the terminal "the classifier is not the author of this".
 * - `pending` — queued, or in flight. Written by ingestion in the same INSERT
 *   that creates the row, so it is true from the moment the ticket exists and
 *   not from whenever a background worker got to it.
 * - `done` — the model answered. With a category, or with "I cannot tell",
 *   which is why `done` does not imply `category` is set.
 * - `failed` — the model was asked and could not answer: unreachable,
 *   throttled past the fallback chain, or replying with something that is not a
 *   category. The one state where asking again might help.
 */
export const TICKET_CLASSIFICATIONS = [
  "skipped",
  "pending",
  "done",
  "failed",
] as const;
export const ticketClassificationSchema = z.enum(TICKET_CLASSIFICATIONS);
export type TicketClassification = z.infer<typeof ticketClassificationSchema>;

export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const ticketPrioritySchema = z.enum(TICKET_PRIORITIES);
export type TicketPriority = z.infer<typeof ticketPrioritySchema>;

export const ROUTING_QUEUES = [
  "tier1_support",
  "billing",
  "technical",
  "academic",
  "career_services",
  "escalations",
] as const;
export const routingQueueSchema = z.enum(ROUTING_QUEUES);
export type RoutingQueue = z.infer<typeof routingQueueSchema>;

export const USER_ROLES = ["admin", "agent"] as const;
export const userRoleSchema = z.enum(USER_ROLES);
export type UserRole = z.infer<typeof userRoleSchema>;

export const MESSAGE_DIRECTIONS = ["inbound", "outbound"] as const;
export const messageDirectionSchema = z.enum(MESSAGE_DIRECTIONS);
export type MessageDirection = z.infer<typeof messageDirectionSchema>;

/**
 * How far the agent moved the AI's draft before sending. Computed at send
 * time (see implementation-plan.md 7.9) so the measurement dashboard is a
 * GROUP BY rather than a diff over all history.
 */
export const EDIT_BUCKETS = [
  "unedited",
  "light",
  "heavy",
  "discarded",
] as const;
export const editBucketSchema = z.enum(EDIT_BUCKETS);
export type EditBucket = z.infer<typeof editBucketSchema>;
