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
 * floor instead of being stored as a 2-character name. The password is not
 * trimmed: leading and trailing spaces are legitimate characters in one, and
 * silently removing them would lock the account out of its own password.
 *
 * Strict, unlike the read schemas: a plain `z.object` *strips* unknown keys, so
 * a payload carrying `role: "admin"` would be accepted and quietly downgraded.
 * On a write that mints credentials, an attempt to set a field this endpoint
 * refuses to honour should be answered, not ignored.
 */
export const createUserBodySchema = z.strictObject({
  name: z.string().trim().min(3, "Name must be at least 3 characters."),
  email: z.string().trim().email("Enter a valid email address."),
  // Better Auth enforces a floor of 8 itself; stating it here turns a rejected
  // API call into a message under the field.
  password: z.string().min(8, "Password must be at least 8 characters."),
});
export type CreateUserBody = z.infer<typeof createUserBodySchema>;

/** POST /api/users answers 201 with the created row, shaped like a list entry. */
export const createUserResponseSchema = userSummarySchema;
export type CreateUserResponse = z.infer<typeof createUserResponseSchema>;
