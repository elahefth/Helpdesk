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

/**
 * What the automatic resolver did with a ticket — the third state machine on a
 * ticket row, beside `status` and `classification`, and the one that decides
 * whether a human ever sees it.
 *
 * It answers a question neither of the others can. `status` says where the
 * ticket stands; `resolved` is the same word whether a person closed it out or
 * the assistant answered it from the knowledge base, and those are not the same
 * event to anyone auditing the queue. `classification` says what the sorter
 * did, which is a different model doing a different job.
 *
 * - `skipped` — nobody asked, or the answer stopped mattering. The column's
 *   default, so every ticket that predates the assistant reads as this rather
 *   than as work queued against something that will never run; also the state
 *   of an install with no model or no knowledge base, of a bulk replay, and —
 *   the case worth knowing — of a ticket a human touched while the assistant
 *   was still thinking. A person taking the ticket cancels the machine.
 * - `pending` — queued, or in flight. Written by ingestion in the INSERT that
 *   creates the row, so it is true from the instant the ticket exists rather
 *   than from whenever a worker reached it.
 * - `resolved` — the assistant answered the student from the knowledge base and
 *   moved the ticket to `resolved`. There is a reply on the thread signed by it.
 * - `escalated` — the assistant read the email and declined: the knowledge base
 *   does not cover it, or its own escalation rules say a person must. The
 *   ticket is an ordinary open ticket and nothing was said to the student.
 * - `failed` — the model was asked and could not answer: unreachable, throttled
 *   past the fallback chain, or replying with something unusable. Like
 *   `escalated` in every way that matters to the queue — a human has it — and
 *   distinct because only one of the two is a fault worth looking into.
 *
 * `escalated` and `failed` are deliberately *not* collapsed into `skipped`.
 * All three put the ticket in front of a person, and a reader who wants to know
 * whether the assistant is working at all cannot tell "it declined, correctly"
 * from "it was never asked" from "it broke" once they are one value.
 */
export const TICKET_AUTO_RESOLUTIONS = [
  "skipped",
  "pending",
  "resolved",
  "escalated",
  "failed",
] as const;
export const ticketAutoResolutionSchema = z.enum(TICKET_AUTO_RESOLUTIONS);
export type TicketAutoResolution = z.infer<typeof ticketAutoResolutionSchema>;

/**
 * The auto-resolution states that mean "the assistant has this, or had it".
 *
 * The queue hides exactly these by default, which is the whole of the
 * `handledBy` filter — see `ticketHandlerSchema`. Spelled once, here, because
 * the predicate lives in the API and the wording of the empty state lives in
 * the SPA, and a queue whose filter and whose explanation disagree about which
 * rows are missing is worse than either.
 *
 * `pending` is in the list because a ticket the assistant is still reading is
 * work a human should not start: the two would answer the same student twice,
 * seconds apart. `resolved` is in it because the ticket is done — the student
 * has their answer and the thread says who wrote it.
 */
export const AI_HANDLED_AUTO_RESOLUTIONS = [
  "pending",
  "resolved",
] as const satisfies readonly TicketAutoResolution[];

/**
 * Who the queue is being asked about.
 *
 * `human` is the default, and it is the reason this parameter exists: tickets
 * the assistant is answering must not sit in the queue alongside tickets
 * somebody has to pick up. It excludes `AI_HANDLED_AUTO_RESOLUTIONS` and leaves
 * everything else — including `escalated` and `failed`, which are precisely the
 * tickets the assistant handed back.
 *
 * The other two exist so the hidden rows are reachable at all. A row no view
 * can show is not a filtered row, it is a lost one, and "the assistant answered
 * a student and I cannot see what it said" is the failure this feature would
 * otherwise ship with.
 */
export const TICKET_HANDLERS = ["human", "ai", "all"] as const;
export const ticketHandlerSchema = z.enum(TICKET_HANDLERS);
export type TicketHandler = z.infer<typeof ticketHandlerSchema>;

export const TICKET_HANDLER_LABELS: Record<TicketHandler, string> = {
  human: "Needs a human",
  ai: "Handled by AI",
  all: "All",
};
