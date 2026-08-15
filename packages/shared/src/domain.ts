import { z } from "zod";

/**
 * Domain vocabulary from project-scope.md.
 *
 * These are the single source of truth for both sides of the API boundary:
 * the Drizzle enums in apps/api derive from them, and the SPA imports the
 * same values. Adding a category here is a type error everywhere it matters.
 */

export const TICKET_STATUSES = [
  "new",
  "open",
  "pending",
  "resolved",
  "closed",
] as const;
export const ticketStatusSchema = z.enum(TICKET_STATUSES);
export type TicketStatus = z.infer<typeof ticketStatusSchema>;

/** Legal lifecycle moves. `resolved -> open` is the student-replied reopen. */
export const TICKET_STATUS_TRANSITIONS: Record<
  TicketStatus,
  readonly TicketStatus[]
> = {
  new: ["open", "closed"],
  open: ["pending", "resolved", "closed"],
  pending: ["open", "resolved", "closed"],
  resolved: ["open", "closed"],
  closed: [],
};

export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
  return TICKET_STATUS_TRANSITIONS[from].includes(to);
}

export const TICKET_CATEGORIES = [
  "enrollment_registration",
  "payments_billing_refunds",
  "course_access_login",
  "technical_issues",
  "curriculum_content",
  "certificates_completion",
  "career_services",
  "other_needs_human",
] as const;
export const ticketCategorySchema = z.enum(TICKET_CATEGORIES);
export type TicketCategory = z.infer<typeof ticketCategorySchema>;

export const CATEGORY_LABELS: Record<TicketCategory, string> = {
  enrollment_registration: "Enrollment & Registration",
  payments_billing_refunds: "Payments, Billing & Refunds",
  course_access_login: "Course Access & Login",
  technical_issues: "Technical Issues",
  curriculum_content: "Curriculum & Course Content",
  certificates_completion: "Certificates & Completion",
  career_services: "Career Services",
  other_needs_human: "Other / Needs Human",
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
