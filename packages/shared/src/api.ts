import { z } from "zod";
import {
  ticketCategorySchema,
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
 * support address; there is no thread yet, so there is no message count and no
 * assignee — both would be columns nothing writes.
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
  status: ticketStatusSchema,
  category: ticketCategorySchema.nullable(),
  receivedAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type TicketSummary = z.infer<typeof ticketSummarySchema>;

/**
 * The list deliberately does not carry `body`: a page of 25 tickets would then
 * ship 25 full emails to render 25 subject lines. Fetching one is what
 * GET /api/tickets/:id is for.
 */
export const ticketDetailSchema = ticketSummarySchema.extend({
  body: z.string(),
  supportEmail: z.string().email(),
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
