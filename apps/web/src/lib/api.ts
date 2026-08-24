import {
  apiErrorSchema,
  createUserResponseSchema,
  listTicketsResponseSchema,
  listUsersResponseSchema,
  readinessSchema,
  type CreateUserBody,
  type CreateUserResponse,
  type ListTicketsQuery,
  type ListTicketsResponse,
  type ListUsersQuery,
  type ListUsersResponse,
  type Readiness,
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
