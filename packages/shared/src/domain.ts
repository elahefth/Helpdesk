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
