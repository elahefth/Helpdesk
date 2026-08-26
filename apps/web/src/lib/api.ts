import {
  apiErrorSchema,
  createUserResponseSchema,
  deleteUserResponseSchema,
  listAssigneesResponseSchema,
  listTicketsResponseSchema,
  listUsersResponseSchema,
  readinessSchema,
  ticketDetailSchema,
  updateUserResponseSchema,
  type CreateUserBody,
  type CreateUserResponse,
  type DeleteUserResponse,
  type ListAssigneesResponse,
  type ListTicketsQuery,
  type ListTicketsResponse,
  type ListUsersQuery,
  type ListUsersResponse,
  type Readiness,
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
