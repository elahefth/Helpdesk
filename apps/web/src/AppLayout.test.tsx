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
 * Renders the layout with a stub `fetch`. By default every request hangs: the
 * readiness badge and the sidebar counts both fetch on mount, and neither is
 * what most of these tests are about, so they get a response that never
 * resolves rather than an unstubbed-request rejection.
 */
function renderLayout(
  initialEntry = "/",
  fetchImpl: (url: string) => Promise<Response> = () => new Promise(() => {}),
) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => fetchImpl(String(input))),
  );

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
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
  it("offers an admin every queue view and both pages", () => {
    signedInAs("admin");
    renderLayout();

    const nav = screen.getByRole("navigation");
    for (const name of [/Needs a human/, /Handled by AI/, /All tickets/]) {
      expect(within(nav).getByRole("link", { name })).toBeDefined();
    }
    expect(within(nav).getByRole("link", { name: "Dashboard" })).toBeDefined();
    expect(within(nav).getByRole("link", { name: "Users" })).toBeDefined();
  });

  it("offers an agent the queue but not Users", () => {
    signedInAs("agent");
    renderLayout();

    const nav = screen.getByRole("navigation");
    expect(
      within(nav).getByRole("link", { name: /Needs a human/ }),
    ).toBeDefined();
    expect(within(nav).queryByRole("link", { name: "Users" })).toBeNull();
  });

  it("renders no nav at all with no session", () => {
    renderLayout();

    expect(screen.queryByRole("navigation")).toBeNull();
  });

  /**
   * The nav sits in the sidebar with the wordmark; the session controls sit in
   * the top bar. Asserted as containment rather than document order or class
   * names, so a restyle does not fail this and a nav that wandered into the
   * top bar does.
   */
  it("groups the nav with the wordmark, away from the session controls", () => {
    signedInAs("admin");
    renderLayout();

    const nav = screen.getByRole("navigation");
    const wordmark = screen.getByRole("link", { name: "Helpdesk" });
    const signOut = screen.getByRole("button", { name: "Sign out" });

    const sidebar = nav.parentElement;
    expect(sidebar).not.toBeNull();
    expect(sidebar?.contains(wordmark)).toBe(true);
    expect(sidebar?.contains(signOut)).toBe(false);
  });

  /**
   * All three views live at "/", so `NavLink`'s pathname match would mark
   * every one of them current at once. The active view is read off
   * `?handled=`, the way the queue itself reads it.
   */
  it("marks the default view current at a bare /", () => {
    signedInAs("admin");
    renderLayout();

    const current = (name: RegExp | string) =>
      screen.getByRole("link", { name }).getAttribute("aria-current");

    expect(current(/Needs a human/)).toBe("page");
    expect(current(/Handled by AI/)).toBeNull();
    expect(current(/All tickets/)).toBeNull();
    expect(current("Users")).toBeNull();
  });

  it("marks the view the query string names", () => {
    signedInAs("admin");
    renderLayout("/?handled=ai&status=open");

    expect(
      screen
        .getByRole("link", { name: /Handled by AI/ })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      screen
        .getByRole("link", { name: /Needs a human/ })
        .getAttribute("aria-current"),
    ).toBeNull();
  });

  /**
   * The counts are the list endpoint's own `total` for each view, so the
   * sidebar cannot describe a different "Needs a human" than the page does.
   */
  it("shows each view's count from the list endpoint's total", async () => {
    signedInAs("admin");
    const totals: Record<string, number> = { human: 42, ai: 58, all: 100 };
    renderLayout("/", (url) => {
      const handledBy = new URL(url, "http://x").searchParams.get("handledBy");
      if (!handledBy) return new Promise(() => {});
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [],
            nextCursor: null,
            total: totals[handledBy],
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    });

    expect(
      await screen.findByRole("link", { name: "Handled by AI 58" }),
    ).toBeDefined();
    expect(
      screen.getByRole("link", { name: "Needs a human 42" }),
    ).toBeDefined();
    expect(screen.getByRole("link", { name: "All tickets 100" })).toBeDefined();
  });
});
