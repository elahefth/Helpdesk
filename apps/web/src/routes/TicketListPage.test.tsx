import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import type { ListTicketsResponse, TicketSummary } from "@helpdesk/shared";
import { renderWithQuery } from "../test/render-with-query.tsx";
import { TicketListPage } from "./TicketListPage.tsx";

/**
 * Stubs `fetch` rather than `lib/api.ts`, like UsersPage.test.tsx, so responses
 * still go through the shared Zod schemas. A ticket shape that drifts from
 * `ticketSummarySchema` then fails here the way it fails in the browser — with
 * a throw — instead of satisfying a hand-written mock and nothing else.
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

function ticketRow(overrides: Partial<TicketSummary> = {}): TicketSummary {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    subject: "Cannot log in to the course portal",
    studentName: "Ada Student",
    studentEmail: "ada.student@example.com",
    status: "open",
    category: null,
    classification: "skipped",
    receivedAt: "2026-08-20T09:15:00.000Z",
    createdAt: "2026-08-20T09:15:01.000Z",
    updatedAt: "2026-08-20T09:15:01.000Z",
    ...overrides,
  };
}

const REFUND = ticketRow({
  id: "44444444-4444-4444-8444-444444444444",
  subject: "Refund for the January cohort",
  studentName: "Ben Student",
  studentEmail: "ben.student@example.com",
  status: "resolved",
  category: "refund_request",
});

/**
 * `total` defaults to the page's own length, which is the single-page case.
 * Pass it explicitly to describe a queue longer than the rows in hand — that is
 * what the pager divides to get "Page 1 of 10".
 */
function pageOf(
  data: TicketSummary[],
  nextCursor: string | null = null,
  total = data.length,
): ListTicketsResponse {
  return { data, nextCursor, total };
}

/**
 * The router is not only there to keep `<Link>` from throwing: the queue's
 * filters, sort and page all live in the query string, so it is the state
 * container the component reads from. This probe is how a test reads back what
 * the controls wrote there, and `initialEntry` is how one arrives at a queue
 * somebody had already narrowed — a reload, a pasted link, or the Back button
 * after a ticket was opened.
 *
 * Still no routes: nothing here navigates to another page, and a destination is
 * proven by asserting the href rather than by rendering what it points at.
 */
function LocationProbe() {
  const location = useLocation();

  // Rendered rather than assigned to a module variable: writing to one during
  // render is a side effect, and a probe that breaks the rules of React is a
  // poor witness to a component that keeps them.
  return (
    <>
      <span data-testid="queue-url">
        {`${location.pathname}${location.search}`}
      </span>
      <span data-testid="queue-state">{JSON.stringify(location.state)}</span>
    </>
  );
}

const queueUrl = () => screen.getByTestId("queue-url").textContent;

/** What the last navigation carried in history state, or null for none. */
const queueState = () =>
  JSON.parse(
    screen.getByTestId("queue-state").textContent || "null",
  ) as unknown;

const renderList = (initialEntry = "/") =>
  renderWithQuery(
    <MemoryRouter initialEntries={[initialEntry]}>
      <TicketListPage />
      <LocationProbe />
    </MemoryRouter>,
  );

const skeletons = () =>
  document.querySelectorAll('[data-slot="skeleton"]').length;

describe("TicketListPage", () => {
  it("shows skeleton rows under a real header while the first page loads", async () => {
    const { responder, release } = gatedResponse(pageOf([ticketRow()]));
    responders.push(responder);

    renderList();

    expect(skeletons()).toBeGreaterThan(0);
    // The placeholder must not be silent for a screen reader.
    expect(screen.getByText("Loading tickets…")).toBeDefined();
    // The header renders during loading too — that is the point of shaping the
    // placeholder like the table rather than swapping in a paragraph.
    // A regex, not the exact string: each header carries a visually hidden hint
    // about what the next click will do, and that is part of its accessible
    // name.
    expect(screen.getByRole("columnheader", { name: /Subject/ })).toBeDefined();

    release();

    expect(
      await screen.findByText("Cannot log in to the course portal"),
    ).toBeDefined();
    expect(skeletons()).toBe(0);
  });

  it("renders the five columns asked for, in order", async () => {
    responders.push(jsonResponse(pageOf([ticketRow()])));

    renderList();
    await screen.findByText("Cannot log in to the course portal");

    // Each header carries a visually hidden hint about what a click will do, so
    // the assertion is on the visible label rather than the whole cell.
    expect(
      screen
        .getAllByRole("columnheader")
        .map((th) => th.querySelector("button")?.firstChild?.textContent),
    ).toEqual(["Subject", "Sender", "Status", "Category", "Created"]);
  });

  it("links each subject to that ticket's own page", async () => {
    responders.push(jsonResponse(pageOf([ticketRow(), REFUND])));

    renderList();

    // By role rather than by text: the assertion is that the subject *is* the
    // link, not that a link happens to sit somewhere in the row. That is what
    // keeps cmd-click and "copy link address" working — the two ways a ticket
    // actually gets handed to another agent.
    const link = await screen.findByRole("link", {
      name: "Cannot log in to the course portal",
    });
    expect(link.getAttribute("href")).toBe(
      "/tickets/33333333-3333-4333-8333-333333333333",
    );

    expect(
      screen
        .getByRole("link", { name: "Refund for the January cohort" })
        .getAttribute("href"),
    ).toBe("/tickets/44444444-4444-4444-8444-444444444444");
  });

  it("renders a row per ticket and asks for no filters by default", async () => {
    responders.push(jsonResponse(pageOf([ticketRow(), REFUND])));

    renderList();

    const row = await screen.findByRole("row", { name: /Cannot log in/ });
    expect(within(row).getByText("Ada Student")).toBeDefined();
    expect(within(row).getByText("ada.student@example.com")).toBeDefined();
    expect(within(row).getByText("open")).toBeDefined();
    expect(
      screen.getByRole("row", { name: /Refund for the January/ }),
    ).toBeDefined();

    // No status or category param: the unfiltered list must not silently narrow.
    expect(requestedUrls[0]).toBe("/api/tickets");
  });

  // Mail with a bare From header, and every ticket ingested before the column
  // existed. The address is the fallback, so the cell is never empty.
  it("falls back to the address when the email carried no display name", async () => {
    responders.push(jsonResponse(pageOf([ticketRow({ studentName: null })])));

    renderList();

    const row = await screen.findByRole("row", { name: /Cannot log in/ });
    expect(within(row).getByText("ada.student@example.com")).toBeDefined();
    expect(within(row).queryByText("Ada Student")).toBeNull();
  });

  it("labels an unclassified ticket rather than leaving the cell blank", async () => {
    responders.push(jsonResponse(pageOf([ticketRow()])));

    renderList();

    expect(await screen.findByText("unclassified")).toBeDefined();
  });

  /**
   * The other reason a category cell can be empty, and the one the reader
   * cannot otherwise tell from the permanent kind. Classification runs after
   * ingestion has already answered, so a ticket that arrived seconds ago has
   * no category *yet* — and a working classifier that looks identical to an
   * absent one is the failure this whole field exists to prevent.
   */
  it("says a pending ticket is being classified, not that it is unclassified", async () => {
    responders.push(
      jsonResponse(pageOf([ticketRow({ classification: "pending" })])),
    );

    renderList();

    expect(await screen.findByText("classifying…")).toBeDefined();
    expect(screen.queryByText("unclassified")).toBeNull();
  });

  /**
   * A category that arrived wins over the state that was tracking it. The two
   * can disagree on a ticket a human categorised while a job was queued — the
   * API closes that job in the same statement, but the row in hand may predate
   * it, and "classifying…" beside a category nobody is going to change is the
   * wrong half to show.
   */
  it("shows the category rather than the state once one is set", async () => {
    responders.push(
      jsonResponse(
        pageOf([
          ticketRow({ category: "technical", classification: "pending" }),
        ]),
      ),
    );

    renderList();

    expect(await screen.findByText("Technical")).toBeDefined();
    expect(screen.queryByText("classifying…")).toBeNull();
  });

  it("shows the human label for a category the sender stated", async () => {
    responders.push(jsonResponse(pageOf([REFUND])));

    renderList();

    expect(await screen.findByText("Refund Request")).toBeDefined();
    // The wire value is an enum member; showing it raw would leak the schema.
    expect(screen.queryByText("refund_request")).toBeNull();
  });

  it("filters server-side, not over the page already fetched", async () => {
    responders.push(jsonResponse(pageOf([ticketRow(), REFUND])));
    renderList();
    await screen.findByText("Cannot log in to the course portal");

    responders.push(jsonResponse(pageOf([REFUND])));
    await userEvent.click(screen.getByRole("combobox", { name: /status/i }));
    await userEvent.click(
      await screen.findByRole("option", { name: "resolved" }),
    );

    await waitFor(() => {
      expect(requestedUrls).toContain("/api/tickets?status=resolved");
    });
  });

  it("passes the category filter too", async () => {
    responders.push(jsonResponse(pageOf([REFUND])));
    renderList();
    await screen.findByText("Refund for the January cohort");

    responders.push(jsonResponse(pageOf([REFUND])));
    await userEvent.click(screen.getByRole("combobox", { name: /category/i }));
    await userEvent.click(
      await screen.findByRole("option", { name: "Refund Request" }),
    );

    await waitFor(() => {
      expect(requestedUrls).toContain("/api/tickets?category=refund_request");
    });
  });

  it("surfaces a failed list rather than showing an empty queue", async () => {
    responders.push(
      jsonResponse(
        {
          error: {
            code: "service_unavailable",
            message: "Database unavailable",
          },
        },
        503,
      ),
    );

    renderList();

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Could not load tickets")).toBeDefined();
    expect(within(alert).getByText("Database unavailable")).toBeDefined();
    // "No tickets" here would tell an agent their queue is clear when the API
    // never answered — the one wrong thing this screen could say.
    expect(screen.queryByText("No tickets match that filter")).toBeNull();
  });

  it("points at the ingestion path when the queue really is empty", async () => {
    responders.push(jsonResponse(pageOf([])));

    renderList();

    expect(
      await screen.findByText("No tickets match that filter"),
    ).toBeDefined();
  });
});

/**
 * Sorting is TanStack Table's state and Postgres's ORDER BY, with the query
 * string as the only thing between them. These cover that seam: that a header
 * click reaches the API as `sort`/`order`, and that the table does not quietly
 * re-sort the page it holds on top of what the server sent.
 */
describe("TicketListPage sorting", () => {
  /**
   * The sort control in a column header. Matched by pattern rather than exact
   * text: the button carries a visually hidden hint about what the next click
   * will do, and that hint is part of its accessible name.
   */
  const header = (name: RegExp) => screen.getByRole("button", { name });

  it("starts newest-first without asking for it in the query string", async () => {
    responders.push(jsonResponse(pageOf([ticketRow()])));

    renderList();
    await screen.findByText("Cannot log in to the course portal");

    // createdAt desc is the server's own default, so sending it would be a
    // redundant pair on every unsorted request.
    expect(requestedUrls[0]).toBe("/api/tickets");
    expect(
      screen
        .getByRole("columnheader", { name: /Created/ })
        .getAttribute("aria-sort"),
    ).toBe("descending");
  });

  it("sends a clicked column as sort and order", async () => {
    responders.push(jsonResponse(pageOf([ticketRow(), REFUND])));
    renderList();
    await screen.findByText("Cannot log in to the course portal");

    responders.push(jsonResponse(pageOf([REFUND, ticketRow()])));
    await userEvent.click(header(/Subject/));

    await waitFor(() => {
      expect(requestedUrls).toContain("/api/tickets?sort=subject&order=asc");
    });
  });

  it("toggles direction on a second click of the same column", async () => {
    responders.push(jsonResponse(pageOf([ticketRow()])));
    renderList();
    await screen.findByText("Cannot log in to the course portal");

    responders.push(jsonResponse(pageOf([ticketRow()])));
    await userEvent.click(header(/Sender/));
    await waitFor(() => {
      expect(requestedUrls).toContain("/api/tickets?sort=sender&order=asc");
    });

    responders.push(jsonResponse(pageOf([ticketRow()])));
    await userEvent.click(header(/Sender/));
    await waitFor(() => {
      expect(requestedUrls).toContain("/api/tickets?sort=sender&order=desc");
    });
  });

  // Sorting changes the ORDER BY, which makes any cursor from the old ordering
  // meaningless — it names a position in a list that no longer exists. The
  // query key has to change with it so the list restarts.
  it("restarts pagination when the sort changes", async () => {
    responders.push(jsonResponse(pageOf([ticketRow()], "cursor-page-2")));
    renderList();
    await screen.findByText("Cannot log in to the course portal");

    responders.push(jsonResponse(pageOf([REFUND])));
    await userEvent.click(header(/Status/));

    await waitFor(() => {
      expect(requestedUrls).toContain("/api/tickets?sort=status&order=asc");
    });
    // Not `…&cursor=cursor-page-2`: that cursor belongs to the createdAt order.
    expect(requestedUrls.some((url) => url.includes("cursor"))).toBe(false);
  });

  it("keeps the filters while sorting", async () => {
    responders.push(jsonResponse(pageOf([REFUND])));
    renderList();
    await screen.findByText("Refund for the January cohort");

    responders.push(jsonResponse(pageOf([REFUND])));
    await userEvent.click(screen.getByRole("combobox", { name: /status/i }));
    await userEvent.click(
      await screen.findByRole("option", { name: "resolved" }),
    );
    await waitFor(() => {
      expect(requestedUrls).toContain("/api/tickets?status=resolved");
    });

    responders.push(jsonResponse(pageOf([REFUND])));
    await userEvent.click(header(/Category/));

    await waitFor(() => {
      expect(requestedUrls).toContain(
        "/api/tickets?status=resolved&sort=category&order=asc",
      );
    });
  });

  /**
   * The whole point of `manualSorting`. The SPA holds one page of a
   * cursor-paginated list, so re-ordering the rows it happens to have would
   * sort a sample and present it as the queue.
   */
  it("renders server order verbatim rather than re-sorting the page", async () => {
    // Deliberately not alphabetical: a client-side sort by subject would put
    // "Cannot log in" first, and the assertion below would catch it.
    responders.push(jsonResponse(pageOf([REFUND, ticketRow()])));
    renderList();
    await screen.findByText("Refund for the January cohort");

    responders.push(jsonResponse(pageOf([REFUND, ticketRow()])));
    await userEvent.click(header(/Subject/));
    await waitFor(() => {
      expect(requestedUrls).toContain("/api/tickets?sort=subject&order=asc");
    });

    const subjects = screen
      .getAllByRole("row")
      // Drop the header row.
      .slice(1)
      .map((row) => row.querySelector("td")?.textContent);
    expect(subjects).toEqual([
      "Refund for the January cohort",
      "Cannot log in to the course portal",
    ]);
  });

  it("marks the sorted column for assistive tech, and only that one", async () => {
    responders.push(jsonResponse(pageOf([ticketRow()])));
    renderList();
    await screen.findByText("Cannot log in to the course portal");

    responders.push(jsonResponse(pageOf([ticketRow()])));
    await userEvent.click(header(/Subject/));

    await waitFor(() => {
      expect(
        screen
          .getByRole("columnheader", { name: /Subject/ })
          .getAttribute("aria-sort"),
      ).toBe("ascending");
    });
    // The arrow glyph is aria-hidden, so without aria-sort a screen reader is
    // told the table is sorted by nothing.
    expect(
      screen
        .getAllByRole("columnheader")
        .filter((th) => th.getAttribute("aria-sort") !== "none"),
    ).toHaveLength(1);
  });
});

/**
 * The pager. Keyset pagination underneath, one page on screen at a time, and a
 * counter that has to come from the server's `total` because a cursor knows
 * only whether a next page exists — never how many follow.
 */
describe("TicketListPage pagination", () => {
  /** Ten rows, as the real page size delivers. */
  const tenRows = (offset: number) =>
    Array.from({ length: 10 }, (_, i) =>
      ticketRow({
        id: `${offset + i}`.padStart(8, "0") + "-1111-4111-8111-111111111111",
        subject: `Ticket number ${offset + i}`,
      }),
    );

  it("shows the range and the page count from the server's total", async () => {
    responders.push(jsonResponse(pageOf(tenRows(1), "cursor-2", 100)));

    renderList();
    await screen.findByText("Ticket number 1");

    expect(screen.getByText("1–10 of 100")).toBeDefined();
    expect(screen.getByText("Page 1 of 10")).toBeDefined();
  });

  it("shows one page at a time rather than accumulating", async () => {
    responders.push(jsonResponse(pageOf(tenRows(1), "cursor-2", 100)));
    renderList();
    await screen.findByText("Ticket number 1");

    responders.push(jsonResponse(pageOf(tenRows(11), "cursor-3", 100)));
    await userEvent.click(screen.getByRole("button", { name: /Next/ }));

    expect(await screen.findByText("Ticket number 11")).toBeDefined();
    // The whole point of the change: page 1's rows are gone, not appended to.
    expect(screen.queryByText("Ticket number 1")).toBeNull();
    expect(screen.getByText("11–20 of 100")).toBeDefined();
    expect(screen.getByText("Page 2 of 10")).toBeDefined();
  });

  it("follows the cursor the previous page returned", async () => {
    responders.push(jsonResponse(pageOf(tenRows(1), "cursor-2", 100)));
    renderList();
    await screen.findByText("Ticket number 1");

    responders.push(jsonResponse(pageOf(tenRows(11), "cursor-3", 100)));
    await userEvent.click(screen.getByRole("button", { name: /Next/ }));
    await screen.findByText("Ticket number 11");

    // Asserting the cursor rather than just "more rows appeared": dropping it
    // would silently re-fetch page one forever, which looks like nothing.
    expect(requestedUrls[1]).toBe("/api/tickets?cursor=cursor-2");
  });

  it("goes back without hitting the network again", async () => {
    responders.push(jsonResponse(pageOf(tenRows(1), "cursor-2", 100)));
    renderList();
    await screen.findByText("Ticket number 1");

    responders.push(jsonResponse(pageOf(tenRows(11), "cursor-3", 100)));
    await userEvent.click(screen.getByRole("button", { name: /Next/ }));
    await screen.findByText("Ticket number 11");

    const requestsBeforePrev = requestedUrls.length;
    await userEvent.click(screen.getByRole("button", { name: /Prev/ }));

    expect(await screen.findByText("Ticket number 1")).toBeDefined();
    // Pages already walked are still in the query cache, so Prev is an index
    // change. A request here would mean the cache is being thrown away.
    expect(requestedUrls).toHaveLength(requestsBeforePrev);
  });

  it("disables Prev on the first page and Next on the last", async () => {
    responders.push(jsonResponse(pageOf(tenRows(1), "cursor-2", 20)));
    renderList();
    await screen.findByText("Ticket number 1");

    expect(
      screen.getByRole("button", { name: /Prev/ }).hasAttribute("disabled"),
    ).toBe(true);

    responders.push(jsonResponse(pageOf(tenRows(11), null, 20)));
    await userEvent.click(screen.getByRole("button", { name: /Next/ }));
    await screen.findByText("Ticket number 11");

    expect(screen.getByText("Page 2 of 2")).toBeDefined();
    expect(
      screen.getByRole("button", { name: /Next/ }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: /Prev/ }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("reports a short final page honestly", async () => {
    // 24 tickets over three pages, the last holding four. The range has to come
    // from the rows in hand, not from the page size, or it claims 21–30 of 24.
    responders.push(jsonResponse(pageOf(tenRows(1), "cursor-2", 24)));
    renderList();
    await screen.findByText("Ticket number 1");

    responders.push(jsonResponse(pageOf(tenRows(11), "cursor-3", 24)));
    await userEvent.click(screen.getByRole("button", { name: /Next/ }));
    await screen.findByText("Ticket number 11");

    responders.push(jsonResponse(pageOf(tenRows(21).slice(0, 4), null, 24)));
    await userEvent.click(screen.getByRole("button", { name: /Next/ }));
    await screen.findByText("Ticket number 21");

    expect(screen.getByText("21–24 of 24")).toBeDefined();
    expect(screen.getByText("Page 3 of 3")).toBeDefined();
  });

  it("returns to page 1 when a filter changes", async () => {
    responders.push(jsonResponse(pageOf(tenRows(1), "cursor-2", 100)));
    renderList();
    await screen.findByText("Ticket number 1");

    responders.push(jsonResponse(pageOf(tenRows(11), "cursor-3", 100)));
    await userEvent.click(screen.getByRole("button", { name: /Next/ }));
    await screen.findByText("Ticket number 11");
    expect(screen.getByText("Page 2 of 10")).toBeDefined();

    // Page 2 of the resolved tickets is not page 2 of all of them, and the
    // filtered queue may not even have a page 2 — staying put would render an
    // empty table under a "Page 2 of 1" counter.
    responders.push(jsonResponse(pageOf(tenRows(1).slice(0, 3), null, 3)));
    await userEvent.click(screen.getByRole("combobox", { name: /status/i }));
    await userEvent.click(
      await screen.findByRole("option", { name: "resolved" }),
    );

    expect(await screen.findByText("Page 1 of 1")).toBeDefined();
    expect(screen.getByText("1–3 of 3")).toBeDefined();
  });

  it("returns to page 1 when the sort changes", async () => {
    responders.push(jsonResponse(pageOf(tenRows(1), "cursor-2", 100)));
    renderList();
    await screen.findByText("Ticket number 1");

    responders.push(jsonResponse(pageOf(tenRows(11), "cursor-3", 100)));
    await userEvent.click(screen.getByRole("button", { name: /Next/ }));
    await screen.findByText("Ticket number 11");

    // A cursor names a position in one ordering and means nothing in another.
    responders.push(jsonResponse(pageOf(tenRows(1), "cursor-2", 100)));
    await userEvent.click(screen.getByRole("button", { name: /Subject/ }));

    expect(await screen.findByText("Page 1 of 10")).toBeDefined();
    expect(requestedUrls).toContain("/api/tickets?sort=subject&order=asc");
  });
});

/**
 * The search box. Debounced, so the assertions have to advance fake timers
 * rather than wait — and the debounce is the part worth covering: without it
 * every keystroke is a request, and the last response to arrive wins rather
 * than the last one asked for.
 */
describe("TicketListPage search", () => {
  const typeSearch = async (text: string) => {
    const box = screen.getByRole("searchbox", { name: /search/i });
    await userEvent.type(box, text);
    return box;
  };

  it("does not search until typing pauses", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      responders.push(jsonResponse(pageOf([ticketRow()], null, 1)));
      renderList();
      await screen.findByText("Cannot log in to the course portal");

      await typeSearch("refund");
      // Six characters, and still only the initial request: a per-keystroke
      // search would have fired six more, each with its own cursor.
      expect(requestedUrls).toHaveLength(1);

      responders.push(jsonResponse(pageOf([REFUND], null, 1)));
      await vi.advanceTimersByTimeAsync(300);

      await waitFor(() => {
        expect(requestedUrls).toContain("/api/tickets?q=refund");
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends the term unencoded characters and all", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      responders.push(jsonResponse(pageOf([ticketRow()], null, 1)));
      renderList();
      await screen.findByText("Cannot log in to the course portal");

      responders.push(jsonResponse(pageOf([], null, 0)));
      await typeSearch("50% off");
      await vi.advanceTimersByTimeAsync(300);

      // URLSearchParams encodes it; the server escapes the LIKE wildcard.
      await waitFor(() => {
        expect(requestedUrls).toContain("/api/tickets?q=50%25+off");
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops the parameter entirely when the box is cleared", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      responders.push(jsonResponse(pageOf([ticketRow()], null, 1)));
      renderList();
      await screen.findByText("Cannot log in to the course portal");

      responders.push(jsonResponse(pageOf([REFUND], null, 1)));
      await typeSearch("refund");
      await vi.advanceTimersByTimeAsync(300);
      await waitFor(() => {
        expect(requestedUrls).toContain("/api/tickets?q=refund");
      });

      responders.push(jsonResponse(pageOf([ticketRow()], null, 1)));
      await userEvent.click(
        screen.getByRole("button", { name: "Clear search" }),
      );
      await vi.advanceTimersByTimeAsync(300);

      // `?q=` would reach the server as a search for nothing, which matches
      // everything by accident — the parameter has to be absent, not empty.
      await waitFor(() => {
        expect(requestedUrls.at(-1)).toBe("/api/tickets");
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns to page 1 when a search begins", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const tenRows = Array.from({ length: 10 }, (_, i) =>
        ticketRow({
          id: `${i + 1}`.padStart(8, "0") + "-1111-4111-8111-111111111111",
          subject: `Ticket number ${i + 1}`,
        }),
      );
      responders.push(jsonResponse(pageOf(tenRows, "cursor-2", 100)));
      renderList();
      await screen.findByText("Ticket number 1");

      responders.push(jsonResponse(pageOf(tenRows, "cursor-3", 100)));
      await userEvent.click(screen.getByRole("button", { name: /Next/ }));
      await screen.findByText("Page 2 of 10");

      responders.push(jsonResponse(pageOf([REFUND], null, 1)));
      await typeSearch("refund");
      await vi.advanceTimersByTimeAsync(300);

      // Page 2 of a one-page result would render an empty table under a
      // "Page 2 of 1" counter.
      expect(await screen.findByText("Page 1 of 1")).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the filters while searching", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      responders.push(jsonResponse(pageOf([REFUND], null, 1)));
      renderList();
      await screen.findByText("Refund for the January cohort");

      responders.push(jsonResponse(pageOf([REFUND], null, 1)));
      await userEvent.click(screen.getByRole("combobox", { name: /status/i }));
      await userEvent.click(
        await screen.findByRole("option", { name: "resolved" }),
      );
      await waitFor(() => {
        expect(requestedUrls).toContain("/api/tickets?status=resolved");
      });

      responders.push(jsonResponse(pageOf([REFUND], null, 1)));
      await typeSearch("cohort");
      await vi.advanceTimersByTimeAsync(300);

      await waitFor(() => {
        expect(requestedUrls).toContain(
          "/api/tickets?status=resolved&q=cohort",
        );
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("names the search, not a filter, when nothing matches", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      responders.push(jsonResponse(pageOf([ticketRow()], null, 1)));
      renderList();
      await screen.findByText("Cannot log in to the course portal");

      responders.push(jsonResponse(pageOf([], null, 0)));
      await typeSearch("nothing matches this");
      await vi.advanceTimersByTimeAsync(300);

      // The reader's next move is to edit or clear the term; blaming "that
      // filter" sends them to the wrong control.
      expect(
        await screen.findByText(/No tickets match .nothing matches this./),
      ).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The queue's state is in the URL, and this is why.
 *
 * Opening a ticket unmounts this component. Anything held in `useState` dies
 * with it, so before this the reader came back from a ticket on page 1 of an
 * unfiltered queue no matter where they had been standing — the single most
 * common thing anyone does while working a queue, undone every time.
 */
describe("TicketListPage state in the URL", () => {
  const tenRows = (offset: number) =>
    Array.from({ length: 10 }, (_, i) =>
      ticketRow({
        id: `${offset + i}`.padStart(8, "0") + "-1111-4111-8111-111111111111",
        subject: `Ticket number ${offset + i}`,
      }),
    );

  it("leaves an untouched queue at a bare /", async () => {
    responders.push(jsonResponse(pageOf([ticketRow()])));

    renderList();
    await screen.findByText("Cannot log in to the course portal");

    // Defaults are omitted rather than spelled out, so the address only ever
    // names what the reader actually changed.
    expect(queueUrl()).toBe("/");
  });

  it("puts the page number in the address", async () => {
    responders.push(jsonResponse(pageOf(tenRows(1), "cursor-2", 100)));
    renderList();
    await screen.findByText("Ticket number 1");

    responders.push(jsonResponse(pageOf(tenRows(11), "cursor-3", 100)));
    await userEvent.click(screen.getByRole("button", { name: /Next/ }));
    await screen.findByText("Ticket number 11");

    // One-based in the URL: ?page=1 is the first page, not the second.
    expect(queueUrl()).toBe("/?page=2");
  });

  it("puts the filters and the sort there too", async () => {
    responders.push(jsonResponse(pageOf([ticketRow(), REFUND])));
    renderList();
    await screen.findByText("Cannot log in to the course portal");

    responders.push(jsonResponse(pageOf([REFUND])));
    await userEvent.click(screen.getByRole("combobox", { name: /status/i }));
    await userEvent.click(
      await screen.findByRole("option", { name: "resolved" }),
    );
    await waitFor(() => expect(queueUrl()).toBe("/?status=resolved"));

    responders.push(jsonResponse(pageOf([REFUND])));
    await userEvent.click(screen.getByRole("button", { name: /Subject/ }));

    await waitFor(() =>
      expect(queueUrl()).toBe("/?status=resolved&sort=subject&order=asc"),
    );
  });

  it("starts on the page the URL names, walking the cursor to reach it", async () => {
    responders.push(jsonResponse(pageOf(tenRows(1), "cursor-2", 100)));
    responders.push(jsonResponse(pageOf(tenRows(11), "cursor-3", 100)));
    responders.push(jsonResponse(pageOf(tenRows(21), "cursor-4", 100)));

    renderList("/?page=3");

    expect(await screen.findByText("Ticket number 21")).toBeDefined();
    expect(screen.getByText("Page 3 of 10")).toBeDefined();
    // Cursor pagination cannot jump — page 3's cursor is only known once page 2
    // has come back — so a cold arrival walks forward one request at a time.
    expect(requestedUrls).toEqual([
      "/api/tickets",
      "/api/tickets?cursor=cursor-2",
      "/api/tickets?cursor=cursor-3",
    ]);
  });

  it("starts filtered and sorted when the URL says so", async () => {
    responders.push(jsonResponse(pageOf([REFUND])));

    renderList("/?status=resolved&q=cohort&sort=subject&order=asc");

    await screen.findByText("Refund for the January cohort");
    expect(requestedUrls[0]).toBe(
      "/api/tickets?status=resolved&q=cohort&sort=subject&order=asc",
    );
    // The box shows the term it is searching for, or clearing it is guesswork.
    expect(
      (screen.getByRole("searchbox", { name: /search/i }) as HTMLInputElement)
        .value,
    ).toBe("cohort");
  });

  it("ignores a filter the domain does not have", async () => {
    responders.push(jsonResponse(pageOf([ticketRow()])));

    // A stale or hand-edited link should show the queue rather than an error,
    // and the request is built from the parsed value — so `pending`, which is
    // not a status, cannot reach the API at all.
    renderList("/?status=pending");

    await screen.findByText("Cannot log in to the course portal");
    expect(requestedUrls[0]).toBe("/api/tickets");
  });

  it("clamps a page past the end of the queue", async () => {
    responders.push(jsonResponse(pageOf(tenRows(1), "cursor-2", 20)));
    responders.push(jsonResponse(pageOf(tenRows(11), null, 20)));

    renderList("/?page=9");

    // Walks until the cursors run out, then lands on the last real page and
    // corrects the address — an empty table would read as "no tickets".
    expect(await screen.findByText("Ticket number 11")).toBeDefined();
    expect(screen.getByText("Page 2 of 2")).toBeDefined();
    await waitFor(() => expect(queueUrl()).toBe("/?page=2"));
  });

  /**
   * The other half of returning from a ticket: resolving one while the status
   * filter reads "open" takes it out of the queue, and the detail page marks
   * those pages stale for exactly that reason. If the row was the last on the
   * last page, the page the reader left no longer exists.
   */
  it("clamps when the queue shrinks under the reader", async () => {
    responders.push(jsonResponse(pageOf(tenRows(1), "cursor-2", 20)));
    responders.push(jsonResponse(pageOf(tenRows(11), null, 20)));

    const { queryClient } = renderList("/?status=open&page=2");
    await screen.findByText("Ticket number 11");

    // What the detail page's mutation does, and what returning to the queue
    // then acts on: one page's worth of tickets is left.
    responders.push(jsonResponse(pageOf(tenRows(1).slice(0, 5), null, 5)));
    await queryClient.invalidateQueries({ queryKey: ["tickets"] });

    // `total` is counted with the same filters as the page, so it is the
    // authority on how many pages there are — an empty table reading "no
    // tickets match that filter" would blame the filter for a page that is
    // simply gone.
    await waitFor(() => expect(queueUrl()).toBe("/?status=open"));
    expect(screen.getByText("Page 1 of 1")).toBeDefined();
    expect(screen.getByText("Ticket number 1")).toBeDefined();
    expect(screen.queryByText(/No tickets match/)).toBeNull();
  });

  it("hands the queue's own address to each ticket link", async () => {
    responders.push(jsonResponse(pageOf(tenRows(1), "cursor-2", 20)));
    responders.push(jsonResponse(pageOf(tenRows(11), null, 20)));

    renderList("/?status=open&page=2");
    await screen.findByText("Ticket number 11");

    // The browser's Back button gets the queue back from the URL for free. The
    // detail page's own "Back to tickets" is a fresh navigation to "/", so the
    // link that opens a ticket carries the address it left in history state —
    // page and filter included, which is the whole point.
    await userEvent.click(
      screen.getByRole("link", { name: "Ticket number 11" }),
    );
    expect(queueState()).toEqual({ from: "/?status=open&page=2" });
  });
});
