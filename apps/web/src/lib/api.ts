import {
  apiErrorSchema,
  createTicketReplyResponseSchema,
  createUserResponseSchema,
  deleteUserResponseSchema,
  listAssigneesResponseSchema,
  listTicketRepliesResponseSchema,
  listTicketsResponseSchema,
  listUsersResponseSchema,
  polishTicketReplyResponseSchema,
  readinessSchema,
  summarizeTicketResponseSchema,
  ticketDetailSchema,
  updateUserResponseSchema,
  type CreateTicketReplyBody,
  type CreateTicketReplyResponse,
  type CreateUserBody,
  type CreateUserResponse,
  type DeleteUserResponse,
  type ListAssigneesResponse,
  type ListTicketRepliesResponse,
  type ListTicketsQuery,
  type ListTicketsResponse,
  type ListUsersQuery,
  type ListUsersResponse,
  type PolishTicketReplyBody,
  type PolishTicketReplyResponse,
  type Readiness,
  type SummarizeTicketResponse,
  type TicketDetail,
  type UpdateTicketBody,
  type UpdateTicketResponse,
  type UpdateUserBody,
  type UpdateUserResponse,
} from "@helpdesk/shared";

/**
 * Thin fetch wrapper. Responses are parsed with the same Zod schemas the API
 * builds them from, so a contract drift surfaces here as a loud error rather
 * than as `undefined` three components deep.
 */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function request<T>(
  path: string,
  schema: { parse: (input: unknown) => T },
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "include",
    headers: { "content-type": "application/json", ...init?.headers },
  });

  const payload: unknown = await res.json().catch(() => null);

  if (!res.ok) {
    const parsed = apiErrorSchema.safeParse(payload);
    if (parsed.success) {
      throw new ApiRequestError(
        res.status,
        parsed.data.error.code,
        parsed.data.error.message,
        parsed.data.error.requestId,
      );
    }
    throw new ApiRequestError(res.status, "unknown", res.statusText);
  }

  return schema.parse(payload);
}

export function getReadiness(): Promise<Readiness> {
  return request("/readyz", readinessSchema);
}

/**
 * Skips undefined so a caller can spread an optional filter in without the
 * string "undefined" reaching the API's Zod parse as a value.
 */
function toQueryString(query: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export function listTickets(
  query: Partial<ListTicketsQuery> = {},
): Promise<ListTicketsResponse> {
  return request(
    `/api/tickets${toQueryString(query)}`,
    listTicketsResponseSchema,
  );
}

/**
 * One ticket, with the body the list deliberately omits.
 *
 * The id is encoded for the same reason `updateUser` encodes its own: it is a
 * UUID this API issued today, and the cost of not assuming that forever is
 * nothing.
 *
 * A 404 arrives here as an `ApiRequestError` with `status` 404, which is what
 * lets the detail page tell "no such ticket" from "the request failed" — the
 * first is a dead link and the reader's next move is the queue, the second is
 * worth retrying.
 */
export function getTicket(id: string): Promise<TicketDetail> {
  return request(`/api/tickets/${encodeURIComponent(id)}`, ticketDetailSchema);
}

/**
 * Assign a ticket, or hand it back to the unassigned pool with a null
 * `assigneeId`. Open to any signed-in staff member, unlike the user routes.
 *
 * `JSON.stringify` keeps an explicit null and drops an undefined key, which is
 * exactly the wire distinction the API reads — absent is "leave it alone" — so
 * neither case needs special handling here.
 */
export function updateTicket(
  id: string,
  body: UpdateTicketBody,
): Promise<UpdateTicketResponse> {
  return request(`/api/tickets/${encodeURIComponent(id)}`, ticketDetailSchema, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

/**
 * One ticket's reply thread, oldest first.
 *
 * A separate request from `getTicket`, which is what keeps the two independent
 * in the cache: writing a reply must not refetch the ticket, and changing a
 * status must not refetch the thread. It is unpaginated by design — a
 * conversation with a "load more" in the middle is one the reader reassembles —
 * so there is no query parameter.
 */
export function listTicketReplies(
  id: string,
): Promise<ListTicketRepliesResponse> {
  return request(
    `/api/tickets/${encodeURIComponent(id)}/replies`,
    listTicketRepliesResponseSchema,
  );
}

/**
 * Write a reply. Open to any signed-in staff member, like `updateTicket`.
 *
 * The author is not in the body and cannot be: the API takes it from the
 * session, so a reply is always signed by whoever is actually typing.
 *
 * Nothing is delivered anywhere — there is no email provider in this repo yet —
 * so this records what was said. The page says so beneath the form rather than
 * letting an agent believe a student has been written to.
 */
export function createTicketReply(
  id: string,
  body: CreateTicketReplyBody,
): Promise<CreateTicketReplyResponse> {
  return request(
    `/api/tickets/${encodeURIComponent(id)}/replies`,
    createTicketReplyResponseSchema,
    { method: "POST", body: JSON.stringify(body) },
  );
}

/**
 * Hand a draft reply to a language model and get a tidier version of the same
 * reply back.
 *
 * Nothing is written: the response is text for the box the agent is still
 * typing in, which is why it is a `{ body }` rather than a `TicketReply`. The
 * send is a separate call they make afterwards, having read it.
 *
 * A 503 here means the server has no model configured rather than that the
 * request was wrong, and a 502 means the model failed — both arrive as an
 * `ApiRequestError` carrying a message written to be shown as-is.
 */
export function polishTicketReply(
  id: string,
  body: PolishTicketReplyBody,
): Promise<PolishTicketReplyResponse> {
  return request(
    `/api/tickets/${encodeURIComponent(id)}/replies/polish`,
    polishTicketReplyResponseSchema,
    { method: "POST", body: JSON.stringify(body) },
  );
}

/**
 * Ask a language model what this ticket and its replies amount to.
 *
 * POST for something that reads, which looks wrong until you notice what a GET
 * would license: a browser, a proxy and React Query all treat one as free to
 * repeat and safe to cache, and here every repeat is a model call somebody pays
 * for and a fresh answer. There is no body — the server has the ticket and the
 * thread, and taking text from the caller would make this a summariser of
 * anything rather than of this ticket.
 *
 * Nothing is stored, so there is nothing to invalidate and nothing to go stale:
 * each call summarises the ticket as it stands when it is asked.
 *
 * A 503 means the server has no model configured, a 502 that the model failed —
 * both carrying a message the API writes to be shown as-is.
 */
export function summarizeTicket(id: string): Promise<SummarizeTicketResponse> {
  return request(
    `/api/tickets/${encodeURIComponent(id)}/summary`,
    summarizeTicketResponseSchema,
    { method: "POST" },
  );
}

/**
 * Who a ticket can be assigned to. Unpaginated by design — this fills a picker,
 * and a picker needs every option at once — so there is no query parameter.
 */
export function listAssignees(): Promise<ListAssigneesResponse> {
  return request("/api/assignees", listAssigneesResponseSchema);
}

/** Admin-only server-side; a non-admin session gets a 403 here, not a redirect. */
export function listUsers(
  query: Partial<ListUsersQuery> = {},
): Promise<ListUsersResponse> {
  return request(`/api/users${toQueryString(query)}`, listUsersResponseSchema);
}

/**
 * Admin-only, like listUsers. The new account is always an "agent": `role` is
 * not part of the body because the API cannot accept one (see
 * `createUserBodySchema`).
 */
export function createUser(body: CreateUserBody): Promise<CreateUserResponse> {
  return request("/api/users", createUserResponseSchema, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Admin-only, like the rest of the user routes. `body.password` is optional and
 * `JSON.stringify` drops an undefined one entirely, which is exactly the wire
 * shape the API reads as "leave the existing password alone" — so a blank
 * password field never has to be special-cased here.
 *
 * The id is encoded even though it is a UUID this API itself issued: the cost
 * is nothing and it keeps a future non-UUID identifier from splitting the path.
 */
export function updateUser(
  id: string,
  body: UpdateUserBody,
): Promise<UpdateUserResponse> {
  return request(
    `/api/users/${encodeURIComponent(id)}`,
    updateUserResponseSchema,
    { method: "PATCH", body: JSON.stringify(body) },
  );
}

/**
 * Admin-only, and a soft delete: the row is marked, not removed. The API
 * refuses to delete an admin account, so a 403 here is a policy answer rather
 * than a session problem — the caller is an admin or it would not have got a
 * list to click from.
 */
export function deleteUser(id: string): Promise<DeleteUserResponse> {
  return request(
    `/api/users/${encodeURIComponent(id)}`,
    deleteUserResponseSchema,
    { method: "DELETE" },
  );
}
