import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import type { ListAssigneesResponse, TicketDetail } from "@helpdesk/shared";
import type { QueryClient } from "@tanstack/react-query";
import { renderWithQuery } from "../test/render-with-query.tsx";
import { TicketDetailPage } from "./TicketDetailPage.tsx";

const TICKET_ID = "33333333-3333-4333-8333-333333333333";
const TICKET_PATH = `/api/tickets/${TICKET_ID}`;

/**
 * `useSession` is mocked rather than driven through a stubbed fetch, for the
 * reason AppLayout.test.tsx gives: Better Auth's client resolves a session
 * through its own nanostore, and satisfying that machinery would be a test of
 * Better Auth. The page only reads the id, to mark your own row in the picker.
 */
const session = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("../lib/auth-client.ts", () => ({
  useSession: () => ({ data: session.current }),
}));

/**
 * Stubs `fetch`, not `lib/api.ts`, like the other page tests here: responses
 * then still go through `ticketDetailSchema`, so a field the API stops sending
 * fails this file the way it fails the browser.
 *
 * Dispatch is by `METHOD /path` rather than the queue TicketListPage.test.tsx
 * uses, because this page issues two requests on mount — the ticket and the
 * staff list — and nothing orders them. A queue would make every assertion
 * depend on which of the two React Query happened to start first.
 */
type Responder = () => Promise<Response>;

const requests: string[] = [];
let handlers: Record<string, Responder> = {};

function jsonResponse(body: unknown, status = 200): Responder {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
}

function errorResponse(status: number, code: string, message: string) {
  return jsonResponse({ error: { code, message } }, status);
}

/** A response the test releases by hand, so a pending state is assertable. */
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

/** The bodies of the PATCHes that were sent, in order, for the write tests. */
const patched: unknown[] = [];

beforeEach(() => {
  requests.length = 0;
  patched.length = 0;
  // Every loaded page fetches its reply thread as well, and almost none of the
  // tests here are about it — so it is answered empty by default rather than
  // stubbed once per test. TicketThread.test.tsx is where the thread itself is
  // covered; a test here that leaves this unstubbed would fail with a thread
  // error alert beside whatever it was actually asserting.
  handlers = { [`GET ${TICKET_PATH}/replies`]: jsonResponse({ data: [] }) };
  session.current = null;
  // unstubGlobals in vitest.config.ts puts happy-dom's fetch back afterwards.
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = new URL(String(input), "http://localhost").pathname;
      const key = `${method} ${path}`;
      requests.push(key);
      if (method === "PATCH") {
        patched.push(JSON.parse(String(init?.body)));
      }
      const handler = handlers[key];
      return handler
        ? handler()
        : Promise.reject(new Error(`unstubbed request: ${key}`));
    }),
  );
});

afterEach(cleanup);

const CASS = {
  id: "55555555-5555-4555-8555-555555555555",
  name: "Cass Agent",
  email: "cass@helpdesk.test",
  role: "agent",
} as const;

const DANA = {
  id: "66666666-6666-4666-8666-666666666666",
  name: "Dana Admin",
  email: "dana@helpdesk.test",
  role: "admin",
} as const;

const STAFF: ListAssigneesResponse = { data: [CASS, DANA] };

function ticket(overrides: Partial<TicketDetail> = {}): TicketDetail {
  return {
    id: TICKET_ID,
    subject: "Cannot log in to the course portal",
    studentName: "Ada Student",
    studentEmail: "ada.student@example.com",
    status: "open",
    category: "technical",
    classification: "skipped",
    autoResolution: "skipped",
    body: "Hi,\n\nThe portal rejects my password.\n\nThanks,\nAda",
    supportEmail: "support@example.edu",
    receivedAt: "2026-08-20T09:15:00.000Z",
    createdAt: "2026-08-20T09:15:01.000Z",
    updatedAt: "2026-08-21T10:00:00.000Z",
    assignee: null,
    ...overrides,
  };
}

/** The two requests a loaded page makes, answered. */
function serve(detail: TicketDetail, staff: ListAssigneesResponse = STAFF) {
  handlers[`GET ${TICKET_PATH}`] = jsonResponse(detail);
  handlers["GET /api/assignees"] = jsonResponse(staff);
}

/**
 * Mounted behind the real route pattern rather than by passing an id as a prop,
 * because the id comes from `useParams` — the whole point of the page having an
 * address. A prop would test a component this app never renders.
 */
function renderDetail(id: string = TICKET_ID, from?: string) {
  return renderWithQuery(
    // `state` is what the queue's own link attaches when it opens a ticket:
    // the address the reader is coming from, page and filters included. Absent
    // here means the ticket was reached some other way — a pasted link, a
    // reload — which is the fallback case.
    <MemoryRouter
      initialEntries={[
        from
          ? { pathname: `/tickets/${id}`, state: { from } }
          : { pathname: `/tickets/${id}` },
      ]}
    >
      <Routes>
        <Route path="/tickets/:id" element={<TicketDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** The "Back to tickets" link's destination. */
const backHref = () =>
  screen.getByRole("link", { name: /Back to tickets/ }).getAttribute("href");

/** Opens one of the sidebar selects and picks the option with this label. */
async function choose(control: RegExp, label: string | RegExp) {
  await userEvent.click(screen.getByRole("combobox", { name: control }));
  await userEvent.click(await screen.findByRole("option", { name: label }));
}

const STATUS = /^status/i;
const CATEGORY = /^category/i;
const ASSIGNEE = /assigned to/i;

/** What a sidebar select is currently showing. */
const shown = (control: RegExp) =>
  screen.getByRole("combobox", { name: control }).textContent;

describe("TicketDetailPage", () => {
  it("fetches the ticket named by the URL and renders it", async () => {
    serve(ticket());

    renderDetail();

    expect(
      await screen.findByRole("heading", {
        name: "Cannot log in to the course portal",
      }),
    ).toBeDefined();

    // The id in the path is the id in the request — the link from the queue is
    // otherwise a page showing somebody else's ticket.
    expect(requests).toContain(`GET ${TICKET_PATH}`);

    expect(
      screen.getByText("From: Ada Student (ada.student@example.com)"),
    ).toBeDefined();
    // Status and category are the sidebar's controls now, not badges — the
    // mock made them the two things you change rather than two things you read.
    expect(
      screen.getByRole("combobox", { name: /^status/i }).textContent,
    ).toContain("Open");
    expect(
      screen.getByRole("combobox", { name: /^category/i }).textContent,
    ).toContain("Technical");
  });

  /**
   * The body is the reason this page exists — the list response omits it
   * deliberately, so nothing else in the SPA can show it.
   */
  it("renders the email body with its line breaks intact", async () => {
    serve(ticket());

    renderDetail();
    await screen.findByRole("heading", { name: /Cannot log in/ });

    const body = screen.getByText(/The portal rejects my password/);
    // Not a cosmetic class: a plain-text email's newlines are the only
    // structure it has, and collapsed they turn a signed message into one run.
    expect(body.className).toContain("whitespace-pre-wrap");
    expect(body.textContent).toContain("Thanks,\nAda");
  });

  /** Same fallback the queue's Sender cell makes, for the same nullable column. */
  it("falls back to the address when the sender has no display name", async () => {
    serve(ticket({ studentName: null }));

    renderDetail();
    await screen.findByRole("heading", { name: /Cannot log in/ });

    // The bare address, with none of the parenthesised-name shape that only
    // makes sense when there is a name to parenthesise it beside.
    expect(screen.getByText("From: ada.student@example.com")).toBeDefined();
    expect(screen.getByText("From ada.student@example.com")).toBeDefined();
  });

  it("says None rather than showing an empty category", async () => {
    serve(ticket({ category: null }));

    renderDetail();
    await screen.findByRole("heading", { name: /Cannot log in/ });

    expect(
      screen.getByRole("combobox", { name: /^category/i }).textContent,
    ).toContain("None");
  });

  /**
   * The select reads "None" for a ticket whose category is thirty seconds
   * away, which is the same thing it reads for a ticket nobody will ever
   * classify. This line is the only thing separating them.
   */
  it("says so while the classifier still owes an answer", async () => {
    serve(ticket({ category: null, classification: "pending" }));

    renderDetail();
    await screen.findByRole("heading", { name: /Cannot log in/ });

    expect(screen.getByText(/classifying automatically/i)).toBeDefined();
  });

  /**
   * The reader is looking at an empty category that *was* going to be filled
   * in. Handing the decision back explicitly beats leaving them to wonder
   * whether something is still running.
   */
  it("says when automatic classification failed", async () => {
    serve(ticket({ category: null, classification: "failed" }));

    renderDetail();
    await screen.findByRole("heading", { name: /Cannot log in/ });

    expect(screen.getByText(/could not be classified/i)).toBeDefined();
  });

  /**
   * A category the model chose and a category a colleague chose are the same
   * fact about the ticket. Labelling one of them would invite the reader to
   * trust it differently from the work in front of them.
   */
  it.each([["done"], ["skipped"]])(
    "says nothing about a %s classification",
    async (classification) => {
      serve(ticket({ classification: classification as "done" | "skipped" }));

      renderDetail();
      await screen.findByRole("heading", { name: /Cannot log in/ });

      expect(screen.queryByText(/classif/i)).toBeNull();
    },
  );

  it("shows a placeholder while the ticket loads", async () => {
    const { responder, release } = gatedResponse(ticket());
    handlers[`GET ${TICKET_PATH}`] = responder;
    handlers["GET /api/assignees"] = jsonResponse(STAFF);

    renderDetail();

    expect(
      document.querySelectorAll('[data-slot="skeleton"]').length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("Loading ticket…")).toBeDefined();

    release();

    await screen.findByRole("heading", { name: /Cannot log in/ });
    // The page's own placeholder, named rather than counted: the reply thread
    // renders a second skeleton of its own while it loads, so a count of every
    // skeleton in the document no longer answers "has the ticket arrived".
    expect(screen.queryByText("Loading ticket…")).toBeNull();
  });

  /**
   * A 404 is a dead link, not a failure — the reader's next move is the queue,
   * so it must not be dressed up as something worth retrying.
   */
  it("reports a missing ticket without retrying it", async () => {
    handlers[`GET ${TICKET_PATH}`] = errorResponse(
      404,
      "not_found",
      `Ticket ${TICKET_ID} not found`,
    );

    renderDetail();

    expect(await screen.findByText("No such ticket")).toBeDefined();
    // One request for the ticket. A retry re-asks a question the API has
    // answered, and the second attempt would arrive as a second entry here.
    expect(requests.filter((key) => key.endsWith(TICKET_PATH))).toHaveLength(1);
  });

  it("reports a real failure as a failure", async () => {
    handlers[`GET ${TICKET_PATH}`] = errorResponse(
      503,
      "service_unavailable",
      "Database unavailable",
    );

    renderDetail();

    // A longer wait than the default: this page overrides the query client's
    // retry policy so a 404 is never re-asked, and the function form of `retry`
    // replaces `renderWithQuery`'s `retry: false` wholesale — so a retryable
    // status really does retry here, after React Query's ~1s backoff.
    expect(
      await screen.findByText("Could not load this ticket", undefined, {
        timeout: 4000,
      }),
    ).toBeDefined();
    expect(screen.getByText("Database unavailable")).toBeDefined();
    expect(screen.queryByText("No such ticket")).toBeNull();
  });

  /**
   * The way back has to survive the states a reader most wants to leave from,
   * which is why it renders outside the loaded/error branches.
   */
  it("offers a way back to the queue even when the ticket is missing", async () => {
    handlers[`GET ${TICKET_PATH}`] = errorResponse(
      404,
      "not_found",
      "Ticket not found",
    );

    renderDetail();
    await screen.findByText("No such ticket");

    expect(backHref()).toBe("/");
  });

  /**
   * The queue unmounts when a ticket is opened, so the page, filter and sort a
   * reader had set are gone unless something carries them. The URL does that
   * for the browser's Back button; this link is a fresh navigation and needs
   * handing the address explicitly, or it lands on page 1 of everything.
   */
  it("returns to the queue page the reader came from", async () => {
    serve(ticket());

    renderDetail(TICKET_ID, "/?status=open&page=3");
    await screen.findByRole("heading", { name: /Cannot log in/ });

    expect(backHref()).toBe("/?status=open&page=3");
  });

  it("falls back to the queue when the ticket was reached by a bare link", async () => {
    serve(ticket());

    renderDetail();
    await screen.findByRole("heading", { name: /Cannot log in/ });

    expect(backHref()).toBe("/");
  });

  // History state survives a reload and is not this page's to trust: anything
  // that is not a path of our own gets the plain queue rather than being
  // handed to the router as a destination.
  it("ignores a destination that is not a path in this app", async () => {
    serve(ticket());

    renderDetail(TICKET_ID, "https://example.com/phish");
    await screen.findByRole("heading", { name: /Cannot log in/ });

    expect(backHref()).toBe("/");
  });

  it("labels each header line", async () => {
    serve(ticket());

    renderDetail();
    await screen.findByRole("heading", { name: /Cannot log in/ });

    // Prefixed rather than bare, so three timestamps in a column are not three
    // dates a reader has to guess the meaning of.
    expect(
      screen.getByText("From: Ada Student (ada.student@example.com)"),
    ).toBeDefined();
    expect(screen.getByText(/^Created: /)).toBeDefined();
    expect(screen.getByText(/^Updated: /)).toBeDefined();
  });

  /** The card the body lives in, which the mock gives its own heading. */
  it("heads the message with who sent it", async () => {
    serve(ticket());

    renderDetail();
    await screen.findByRole("heading", { name: /Cannot log in/ });

    expect(screen.getByText("Message")).toBeDefined();
    expect(screen.getByText("From Ada Student")).toBeDefined();
  });

  /**
   * Where the summary button sits is the requirement, not a detail: it is a
   * thing you press having read the email, about the email and everything under
   * it. Asserted as document order rather than containment — unlike
   * AppLayout.test.tsx, where the header is `justify-between` and order says
   * nothing — because here the page is one column and the order *is* the
   * reading order.
   */
  it("offers a summary between the message and the replies", async () => {
    serve(ticket());

    renderDetail();
    await screen.findByRole("heading", { name: /Cannot log in/ });

    const summarize = screen.getByRole("button", { name: "Summarize" });
    const message = screen.getByText("Message");
    const replies = screen.getByRole("heading", { name: "Replies" });

    // `compareDocumentPosition` returns FOLLOWING (4) when the argument comes
    // after the node it is called on.
    expect(message.compareDocumentPosition(summarize) & 4).toBe(4);
    expect(summarize.compareDocumentPosition(replies) & 4).toBe(4);
  });

  /**
   * A summary costs a model call, so opening a ticket must not spend one —
   * pinned here as well as in TicketSummaryCard.test.tsx because this is the
   * mount that would pay for it.
   */
  it("summarizes nothing until asked", async () => {
    serve(ticket());

    renderDetail();
    await screen.findByRole("heading", { name: /Cannot log in/ });

    expect(requests).not.toContain(`POST ${TICKET_PATH}/summary`);
  });

  /**
   * The queue and this page are two cache entries, and a change made here shows
   * in both. Nothing refetches while this page is open — the queue is unmounted
   * and its queries are inactive — so the row is marked stale instead, and
   * re-fetched the moment the reader lands back on it.
   */
  describe("the queue's cache", () => {
    /** A page of the queue, cached the way TicketListPage leaves it behind. */
    const cacheQueue = (queryClient: QueryClient, key: unknown = {}) =>
      queryClient.setQueryData(["tickets", key], {
        pages: [{ data: [], nextCursor: null, total: 1 }],
        pageParams: [undefined],
      });

    const isStale = (queryClient: QueryClient, key: unknown = {}) =>
      queryClient.getQueryState(["tickets", key])?.isInvalidated;

    it("goes stale when a status changes, so Back does not show the old one", async () => {
      serve(ticket());
      handlers[`PATCH ${TICKET_PATH}`] = jsonResponse(
        ticket({ status: "resolved" }),
      );

      const { queryClient } = renderDetail();
      await screen.findByRole("heading", { name: /Cannot log in/ });
      cacheQueue(queryClient);

      await choose(STATUS, "Resolved");

      await waitFor(() => expect(isStale(queryClient)).toBe(true));
    });

    it("goes stale when a category changes too", async () => {
      serve(ticket());
      handlers[`PATCH ${TICKET_PATH}`] = jsonResponse(
        ticket({ category: "refund_request" }),
      );

      const { queryClient } = renderDetail();
      await screen.findByRole("heading", { name: /Cannot log in/ });
      cacheQueue(queryClient);

      await choose(CATEGORY, "Refund Request");

      await waitFor(() => expect(isStale(queryClient)).toBe(true));
    });

    /**
     * Every filter and sort the reader has visited is its own cache entry, and
     * a resolved ticket is wrong in all of them — gone from `status=open`,
     * moved under `sort=status`. Matching on the key's prefix is what covers
     * them without naming any.
     */
    it("goes stale under every filter and sort, not just the one on screen", async () => {
      serve(ticket());
      handlers[`PATCH ${TICKET_PATH}`] = jsonResponse(
        ticket({ status: "resolved" }),
      );

      const { queryClient } = renderDetail();
      await screen.findByRole("heading", { name: /Cannot log in/ });
      const openQueue = { status: "open", sortKey: "createdAt" };
      const sorted = { status: "all", sortKey: "status" };
      cacheQueue(queryClient, openQueue);
      cacheQueue(queryClient, sorted);

      await choose(STATUS, "Resolved");

      await waitFor(() => expect(isStale(queryClient, openQueue)).toBe(true));
      expect(isStale(queryClient, sorted)).toBe(true);
    });

    it("leaves this page's own ticket alone", async () => {
      serve(ticket());
      handlers[`PATCH ${TICKET_PATH}`] = jsonResponse(
        ticket({ status: "resolved" }),
      );

      const { queryClient } = renderDetail();
      await screen.findByRole("heading", { name: /Cannot log in/ });

      await choose(STATUS, "Resolved");
      await waitFor(() => expect(shown(STATUS)).toContain("Resolved"));

      // The PATCH answered with the whole updated ticket, so this cache is
      // written rather than invalidated: invalidating would re-fetch what the
      // response already carried and blink a skeleton over the page the reader
      // is looking at.
      expect(
        queryClient.getQueryState(["ticket", TICKET_ID])?.isInvalidated,
      ).toBe(false);
      expect(requests.filter((r) => r === `GET ${TICKET_PATH}`)).toHaveLength(
        1,
      );
    });
  });

  describe("status", () => {
    it("sends only the field that changed", async () => {
      serve(ticket());
      handlers[`PATCH ${TICKET_PATH}`] = jsonResponse(
        ticket({ status: "resolved" }),
      );

      renderDetail();
      await screen.findByRole("heading", { name: /Cannot log in/ });

      await choose(STATUS, "Resolved");

      // Not the whole ticket: a PATCH that restated the category and assignee
      // would overwrite whatever a colleague changed while this page was open.
      expect(patched).toEqual([{ status: "resolved" }]);
      await waitFor(() => expect(shown(STATUS)).toContain("Resolved"));
    });

    /**
     * Title case, from `TICKET_STATUS_LABELS`. The queue renders the raw value
     * in a badge, where lowercase reads as a tag; a select is a sentence the
     * reader is completing, and "Status: resolved" reads as a bug.
     */
    it("offers every status, written as a choice", async () => {
      serve(ticket({ status: "open" }));

      renderDetail();
      await screen.findByRole("heading", { name: /Cannot log in/ });
      await userEvent.click(screen.getByRole("combobox", { name: STATUS }));

      expect(
        (await screen.findAllByRole("option")).map((o) => o.textContent),
      ).toEqual(["Open", "Resolved", "Closed"]);
    });

    /**
     * Closed is terminal, so every other option would be disabled — a select
     * where nothing can be picked is better spelled as a disabled control with
     * the reason beside it.
     */
    it("closes the control on a terminal status, and says why", async () => {
      serve(ticket({ status: "closed" }));

      renderDetail();
      await screen.findByRole("heading", { name: /Cannot log in/ });

      expect(
        screen.getByRole("combobox", { name: STATUS }).hasAttribute("disabled"),
      ).toBe(true);
      expect(
        screen.getByText("A closed ticket cannot change status."),
      ).toBeDefined();
    });

    /**
     * The server re-checks the move whatever this sidebar offered, and its
     * refusal has to reach the reader — the select snapping back on its own is
     * indistinguishable from a misclick.
     */
    it("reports a move the server refuses", async () => {
      serve(ticket({ status: "open" }));
      handlers[`PATCH ${TICKET_PATH}`] = errorResponse(
        409,
        "conflict",
        "A closed ticket cannot become open.",
      );

      renderDetail();
      await screen.findByRole("heading", { name: /Cannot log in/ });

      await choose(STATUS, "Resolved");

      expect(
        await screen.findByRole("alert", undefined, { timeout: 4000 }),
      ).toBeDefined();
      expect(
        screen.getByText(/A closed ticket cannot become open/),
      ).toBeDefined();
    });
  });

  describe("category", () => {
    it("classifies an unclassified ticket", async () => {
      serve(ticket({ category: null }));
      handlers[`PATCH ${TICKET_PATH}`] = jsonResponse(
        ticket({ category: "refund_request" }),
      );

      renderDetail();
      await screen.findByRole("heading", { name: /Cannot log in/ });

      await choose(CATEGORY, "Refund Request");

      expect(patched).toEqual([{ category: "refund_request" }]);
      await waitFor(() => expect(shown(CATEGORY)).toContain("Refund Request"));
    });

    /**
     * "None" is a real answer, not an empty state — every ticket starts there,
     * because nothing classifies — so taking a category back off sends an
     * explicit null rather than omitting the key, which would mean "leave it".
     */
    it("sends an explicit null when the category is taken off", async () => {
      serve(ticket({ category: "technical" }));
      handlers[`PATCH ${TICKET_PATH}`] = jsonResponse(
        ticket({ category: null }),
      );

      renderDetail();
      await screen.findByRole("heading", { name: /Cannot log in/ });

      await choose(CATEGORY, "None");

      expect(patched).toEqual([{ category: null }]);
    });
  });

  describe("assignment", () => {
    it("shows an unowned ticket as unassigned", async () => {
      serve(ticket());

      renderDetail();
      await screen.findByRole("heading", { name: /Cannot log in/ });

      expect(shown(ASSIGNEE)).toContain("Unassigned");
    });

    it("names the assignee when there is one", async () => {
      serve(ticket({ assignee: CASS }));

      renderDetail();
      await screen.findByRole("heading", { name: /Cannot log in/ });

      expect(shown(ASSIGNEE)).toContain("Cass Agent");
    });

    /**
     * "is this mine" is the question a reader is actually asking, and matching
     * a name against their own is work the label can do for them.
     */
    it("marks your own row as yours", async () => {
      session.current = { user: { ...CASS } };
      serve(ticket());

      renderDetail();
      await screen.findByRole("heading", { name: /Cannot log in/ });

      await userEvent.click(screen.getByRole("combobox", { name: ASSIGNEE }));

      expect(
        await screen.findByRole("option", { name: "Cass Agent (you)" }),
      ).toBeDefined();
      // Somebody else is named plainly.
      expect(screen.getByRole("option", { name: "Dana Admin" })).toBeDefined();
    });

    it("assigns the ticket and shows the new owner", async () => {
      serve(ticket());
      handlers[`PATCH ${TICKET_PATH}`] = jsonResponse(
        ticket({ assignee: DANA }),
      );

      renderDetail();
      await screen.findByRole("heading", { name: /Cannot log in/ });

      await choose(ASSIGNEE, "Dana Admin");

      expect(patched).toEqual([{ assigneeId: DANA.id }]);
      // The response carried the whole updated ticket, so the page shows the
      // new owner without a second GET.
      await waitFor(() => expect(shown(ASSIGNEE)).toContain("Dana Admin"));
      expect(
        requests.filter((key) => key === `GET ${TICKET_PATH}`),
      ).toHaveLength(1);
    });

    /**
     * Handing a ticket back is the move an agent makes when they cannot take it
     * after all, and the API reads an explicit null as exactly that — an absent
     * key would mean "change nothing".
     */
    it("sends an explicit null when unassigning", async () => {
      serve(ticket({ assignee: CASS }));
      handlers[`PATCH ${TICKET_PATH}`] = jsonResponse(ticket());

      renderDetail();
      await screen.findByRole("heading", { name: /Cannot log in/ });

      await choose(ASSIGNEE, "Unassigned");

      expect(patched).toEqual([{ assigneeId: null }]);
    });

    it("reports a failed save without losing the ticket", async () => {
      serve(ticket());
      handlers[`PATCH ${TICKET_PATH}`] = errorResponse(
        400,
        "bad_request",
        "That user does not exist, or has been deleted.",
      );

      renderDetail();
      await screen.findByRole("heading", { name: /Cannot log in/ });

      await choose(ASSIGNEE, "Cass Agent");

      expect(
        await screen.findByRole("alert", undefined, { timeout: 4000 }),
      ).toBeDefined();
      expect(
        screen.getByText(/That user does not exist, or has been deleted/),
      ).toBeDefined();
      // The email is still on screen: what failed was the one control, not the
      // page.
      expect(
        screen.getByRole("heading", { name: /Cannot log in/ }),
      ).toBeDefined();
    });

    /**
     * An assignee `GET /api/assignees` does not carry — a soft-deleted
     * colleague on a ticket assigned before the delete route started
     * unassigning them. Both halves matter and they pull opposite ways: the
     * trigger has to keep naming them, because Base UI renders its label out of
     * `items` and an empty box would read as unassigned, while the listbox must
     * not offer them, because handing new work to someone who has left is the
     * thing `GET /api/assignees`' filter exists to prevent. That is what the
     * `hidden` item spec is for.
     */
    it("names an assignee who is no longer assignable, without offering them", async () => {
      const departed = {
        id: "77777777-7777-4777-8777-777777777777",
        name: "Eve Former",
        email: "eve@helpdesk.test",
        role: "agent",
      } as const;

      serve(ticket({ assignee: departed }), { data: [CASS] });

      renderDetail();
      await screen.findByRole("heading", { name: /Cannot log in/ });

      expect(shown(ASSIGNEE)).toContain("Eve Former");

      await userEvent.click(screen.getByRole("combobox", { name: ASSIGNEE }));

      // Awaited on a colleague who *is* offered, so the listbox is open before
      // the absence below is asserted — a queryBy against an unopened popup
      // passes for the wrong reason.
      expect(
        await screen.findByRole("option", { name: "Cass Agent" }),
      ).toBeDefined();
      expect(screen.queryByRole("option", { name: "Eve Former" })).toBeNull();
    });
  });
});
