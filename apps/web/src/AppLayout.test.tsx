import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { UserRole } from "@helpdesk/shared";
import { AppLayout } from "./AppLayout.tsx";

/**
 * The nav is a role boundary the SPA draws, and the one place a wrong answer is
 * visible rather than merely refused: `RequireAdmin` and the API's
 * `requireRole` are the actual rules, but an agent offered a Users link is told
 * something untrue about what they can do.
 *
 * `useSession` is mocked rather than stubbing `fetch`, unlike the page tests.
 * Better Auth's client resolves a session through its own nanostore, so a
 * stubbed response would have to satisfy that machinery to reach this
 * component — which would be a test of Better Auth, not of the nav.
 */
const session = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("./lib/auth-client.ts", () => ({
  useSession: () => ({ data: session.current }),
  authClient: { signOut: vi.fn() },
}));

function signedInAs(role: UserRole) {
  session.current = {
    user: { id: "u1", name: "Ada Admin", email: "ada@helpdesk.test", role },
  };
}

/**
 * Renders the layout at "/" with a stub for the readiness badge's query. The
 * badge fetches on mount and is not what any of this is about, so it gets a
 * response that never resolves rather than an unstubbed-request rejection.
 */
function renderLayout() {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>(() => {})),
  );

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route index element={<p>queue</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  session.current = null;
  cleanup();
});

describe("AppLayout nav", () => {
  it("offers an admin both destinations", () => {
    signedInAs("admin");
    renderLayout();

    const nav = screen.getByRole("navigation");
    expect(within(nav).getByRole("link", { name: "Tickets" })).toBeDefined();
    expect(within(nav).getByRole("link", { name: "Users" })).toBeDefined();
  });

  it("offers an agent Tickets but not Users", () => {
    signedInAs("agent");
    renderLayout();

    const nav = screen.getByRole("navigation");
    expect(within(nav).getByRole("link", { name: "Tickets" })).toBeDefined();
    expect(within(nav).queryByRole("link", { name: "Users" })).toBeNull();
  });

  it("renders no nav at all with no session", () => {
    renderLayout();

    expect(screen.queryByRole("navigation")).toBeNull();
  });

  /**
   * The layout the request was about: both links on the left, grouped with the
   * wordmark rather than with the session controls.
   *
   * Asserted as containment, not document order — the header is
   * `justify-between` with a group at each end, so a nav moved to the right
   * still *follows* the wordmark and still *precedes* the sign-out button. An
   * order check passes on both layouts and tests nothing; which group the nav
   * shares a parent with is the difference between them.
   *
   * Not asserted on class names either, so a restyle does not fail this.
   */
  it("groups the nav with the wordmark on the left, away from the session controls", () => {
    signedInAs("admin");
    renderLayout();

    const header = screen.getByRole("banner");
    const nav = within(header).getByRole("navigation");
    const wordmark = within(header).getByRole("link", { name: "Helpdesk" });
    const signOut = within(header).getByRole("button", { name: "Sign out" });

    const leftGroup = nav.parentElement;
    expect(leftGroup).not.toBeNull();
    expect(leftGroup?.contains(wordmark)).toBe(true);
    expect(leftGroup?.contains(signOut)).toBe(false);
  });

  it("marks the current destination for assistive tech", () => {
    signedInAs("admin");
    renderLayout();

    // At "/", Tickets is the active link and Users is not — `end` on the
    // Tickets NavLink is what keeps it from also matching /users.
    expect(
      screen
        .getByRole("link", { name: "Tickets" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      screen.getByRole("link", { name: "Users" }).getAttribute("aria-current"),
    ).toBeNull();
  });
});
