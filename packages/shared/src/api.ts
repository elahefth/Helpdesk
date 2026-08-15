import { z } from "zod";
import {
  messageDirectionSchema,
  ticketCategorySchema,
  ticketPrioritySchema,
  ticketStatusSchema,
  routingQueueSchema,
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

export const messageSchema = z.object({
  id: z.string().uuid(),
  direction: messageDirectionSchema,
  fromAddress: z.string(),
  body: z.string(),
  createdAt: z.string().datetime(),
});
export type Message = z.infer<typeof messageSchema>;

export const ticketSummarySchema = z.object({
  id: z.string().uuid(),
  subject: z.string(),
  studentEmail: z.string().email(),
  status: ticketStatusSchema,
  category: ticketCategorySchema.nullable(),
  priority: ticketPrioritySchema.nullable(),
  routingQueue: routingQueueSchema.nullable(),
  assigneeId: z.string().uuid().nullable(),
  needsHuman: z.boolean(),
  messageCount: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type TicketSummary = z.infer<typeof ticketSummarySchema>;

export const ticketDetailSchema = ticketSummarySchema.extend({
  messages: z.array(messageSchema),
  aiSummary: z.string().nullable(),
});
export type TicketDetail = z.infer<typeof ticketDetailSchema>;

/** Query params for GET /api/tickets. Parsed with this on the server. */
export const listTicketsQuerySchema = z.object({
  status: ticketStatusSchema.optional(),
  category: ticketCategorySchema.optional(),
  priority: ticketPrioritySchema.optional(),
  assigneeId: z.string().uuid().optional(),
  sort: z.enum(["createdAt", "updatedAt", "priority"]).default("updatedAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});
export type ListTicketsQuery = z.infer<typeof listTicketsQuerySchema>;

export const listTicketsResponseSchema = z.object({
  data: z.array(ticketSummarySchema),
  nextCursor: z.string().nullable(),
});
export type ListTicketsResponse = z.infer<typeof listTicketsResponseSchema>;
