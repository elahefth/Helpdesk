import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ListUsersResponse, UserSummary } from "@helpdesk/shared";
import { renderWithQuery } from "../test/render-with-query.tsx";
import { UsersPage } from "./UsersPage.tsx";

/**
 * Stubs `fetch` rather than `lib/api.ts` so the response still goes through
 * `listUsersResponseSchema`. A contract drift then fails these tests the same
 * way it would fail in the browser — with a Zod throw — instead of sailing past
 * a hand-written mock that satisfies only the TypeScript type.
 */
type Responder = () => Promise<Response>;

const requestedUrls: string[] = [];
let responders: Responder[] = [];

function jsonResponse(body: unknown, status = 200): Responder {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
}

/** A response the test releases by hand, so the pending state can be asserted. */
function gatedResponse(body: unknown) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const responder: Responder = async () => {
    await gate;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { responder, release };
}

beforeEach(() => {
  requestedUrls.length = 0;
  responders = [];
  // unstubGlobals in vitest.config.ts puts happy-dom's fetch back afterwards.
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      requestedUrls.push(String(input));
      const next = responders.shift();
      return next
        ? next()
        : Promise.reject(new Error(`unstubbed request: ${String(input)}`));
    }),
  );
});

afterEach(cleanup);

function userRow(overrides: Partial<UserSummary> = {}): UserSummary {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    email: "ada@helpdesk.test",
    name: "Ada Admin",
    role: "admin",
    createdAt: "2026-01-05T09:00:00.000Z",
    ...overrides,
  };
}

const BEN = userRow({
  id: "22222222-2222-4222-8222-222222222222",
  email: "ben@helpdesk.test",
  name: "Ben Agent",
  role: "agent",
  createdAt: "2026-02-11T09:00:00.000Z",
});

function pageOf(
  data: UserSummary[],
  nextCursor: string | null = null,
): ListUsersResponse {
  return { data, nextCursor };
}

const skeletons = () =>
  document.querySelectorAll('[data-slot="skeleton"]').length;

describe("UsersPage", () => {
  it("shows skeleton rows under a real header while the first page loads", async () => {
    const { responder, release } = gatedResponse(pageOf([userRow()]));
    responders.push(responder);

    renderWithQuery(<UsersPage />);

    expect(skeletons()).toBeGreaterThan(0);
    // The placeholder must not be silent for a screen reader.
    expect(screen.getByText("Loading users…")).toBeDefined();
    // The header renders during loading too — that is the point of shaping the
    // placeholder like the table rather than swapping in a paragraph.
    expect(screen.getByRole("columnheader", { name: "Name" })).toBeDefined();

    release();

    expect(await screen.findByText("Ada Admin")).toBeDefined();
    expect(skeletons()).toBe(0);
    expect(screen.queryByText("Loading users…")).toBeNull();
  });

  it("renders a row per user and asks for no role filter by default", async () => {
    responders.push(jsonResponse(pageOf([userRow(), BEN])));

    renderWithQuery(<UsersPage />);

    const ada = await screen.findByRole("row", { name: /Ada Admin/ });
    expect(within(ada).getByText("ada@helpdesk.test")).toBeDefined();
    expect(within(ada).getByText("admin")).toBeDefined();
    // Formatted through the same call the component makes, so the assertion
    // does not depend on the runner's locale.
    expect(
      within(ada).getByText(
        new Date("2026-01-05T09:00:00.000Z").toLocaleDateString(),
      ),
    ).toBeDefined();

    const ben = screen.getByRole("row", { name: /Ben Agent/ });
    expect(within(ben).getByText("agent")).toBeDefined();

    // Header row plus one row per user.
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(requestedUrls).toEqual(["/api/users"]);
  });

  it("shows the empty state when no user matches the filter", async () => {
    responders.push(jsonResponse(pageOf([])));

    renderWithQuery(<UsersPage />);

    expect(await screen.findByText("No users match that filter")).toBeDefined();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("surfaces the API's error message instead of a table", async () => {
    responders.push(
      jsonResponse(
        { error: { code: "forbidden", message: "Admin role required" } },
        403,
      ),
    );

    renderWithQuery(<UsersPage />);

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Could not load users")).toBeDefined();
    expect(within(alert).getByText("Admin role required")).toBeDefined();
    expect(screen.queryByRole("table")).toBeNull();
    expect(skeletons()).toBe(0);
  });

  it("appends the next page and hides the button on the last one", async () => {
    responders.push(
      jsonResponse(pageOf([userRow()], "cursor-1")),
      jsonResponse(pageOf([BEN])),
    );

    const user = userEvent.setup();
    renderWithQuery(<UsersPage />);

    await screen.findByText("Ada Admin");
    await user.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByText("Ben Agent")).toBeDefined();
    // Appended, not replaced.
    expect(screen.getByText("Ada Admin")).toBeDefined();
    expect(requestedUrls[1]).toBe("/api/users?cursor=cursor-1");

    // nextCursor was null on page two, so there is nothing left to load.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Load more" })).toBeNull(),
    );
  });

  it("has no Load more button when the first page is the only one", async () => {
    responders.push(jsonResponse(pageOf([userRow()])));

    renderWithQuery(<UsersPage />);

    await screen.findByText("Ada Admin");
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  /**
   * The dialog's own behaviour is covered in CreateUserDialog.test.tsx. What is
   * only observable from here is the seam between them: the invalidation has to
   * name a key prefix that actually matches this page's ["users", { role }]
   * entry, or the account is created and the table never shows it.
   */
  it("shows a newly created user without a manual reload", async () => {
    responders.push(
      jsonResponse(pageOf([userRow()])),
      // POST /api/users
      jsonResponse(
        {
          id: "33333333-3333-4333-8333-333333333333",
          name: "Cass Agent",
          email: "cass@helpdesk.test",
          role: "agent",
          createdAt: "2026-08-17T09:00:00.000Z",
        },
        201,
      ),
      // The refetch the invalidation triggers.
      jsonResponse(pageOf([userRow(), BEN])),
    );

    const user = userEvent.setup();
    renderWithQuery(<UsersPage />);
    await screen.findByText("Ada Admin");

    await user.click(screen.getByRole("button", { name: /New user/ }));
    await user.type(screen.getByLabelText("Name"), "Cass Agent");
    await user.type(screen.getByLabelText("Email"), "cass@helpdesk.test");
    await user.type(screen.getByLabelText("Password"), "correct-horse");
    await user.click(screen.getByRole("button", { name: "Create user" }));

    expect(await screen.findByText("Ben Agent")).toBeDefined();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(requestedUrls).toEqual(["/api/users", "/api/users", "/api/users"]);
  });

  it("refetches with role=agent when the filter changes", async () => {
    responders.push(
      jsonResponse(pageOf([userRow(), BEN])),
      jsonResponse(pageOf([BEN])),
    );

    const user = userEvent.setup();
    renderWithQuery(<UsersPage />);

    await screen.findByText("Ada Admin");

    await user.click(screen.getByRole("combobox", { name: "Role" }));
    await user.click(await screen.findByRole("option", { name: "agent" }));

    await waitFor(() => expect(requestedUrls).toHaveLength(2));
    expect(requestedUrls[1]).toBe("/api/users?role=agent");

    // The filtered result replaces the unfiltered one — a fresh query key means
    // a fresh cache entry, not a merge.
    await waitFor(() => expect(screen.queryByText("Ada Admin")).toBeNull());
    expect(screen.getByText("Ben Agent")).toBeDefined();
  });
});
