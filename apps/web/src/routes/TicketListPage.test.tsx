import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

function pageOf(
  data: TicketSummary[],
  nextCursor: string | null = null,
): ListTicketsResponse {
  return { data, nextCursor };
}

const skeletons = () =>
  document.querySelectorAll('[data-slot="skeleton"]').length;

describe("TicketListPage", () => {
  it("shows skeleton rows under a real header while the first page loads", async () => {
    const { responder, release } = gatedResponse(pageOf([ticketRow()]));
    responders.push(responder);

    renderWithQuery(<TicketListPage />);

    expect(skeletons()).toBeGreaterThan(0);
    // The placeholder must not be silent for a screen reader.
    expect(screen.getByText("Loading tickets…")).toBeDefined();
    // The header renders during loading too — that is the point of shaping the
    // placeholder like the table rather than swapping in a paragraph.
    expect(screen.getByRole("columnheader", { name: "Subject" })).toBeDefined();

    release();

    expect(
      await screen.findByText("Cannot log in to the course portal"),
    ).toBeDefined();
    expect(skeletons()).toBe(0);
  });

  it("renders the five columns asked for, in order", async () => {
    responders.push(jsonResponse(pageOf([ticketRow()])));

    renderWithQuery(<TicketListPage />);
    await screen.findByText("Cannot log in to the course portal");

    expect(
      screen.getAllByRole("columnheader").map((th) => th.textContent),
    ).toEqual(["Subject", "Sender", "Status", "Category", "Created"]);
  });

  it("renders a row per ticket and asks for no filters by default", async () => {
    responders.push(jsonResponse(pageOf([ticketRow(), REFUND])));

    renderWithQuery(<TicketListPage />);

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

    renderWithQuery(<TicketListPage />);

    const row = await screen.findByRole("row", { name: /Cannot log in/ });
    expect(within(row).getByText("ada.student@example.com")).toBeDefined();
    expect(within(row).queryByText("Ada Student")).toBeNull();
  });

  it("labels an unclassified ticket rather than leaving the cell blank", async () => {
    responders.push(jsonResponse(pageOf([ticketRow()])));

    renderWithQuery(<TicketListPage />);

    expect(await screen.findByText("unclassified")).toBeDefined();
  });

  it("shows the human label for a category the sender stated", async () => {
    responders.push(jsonResponse(pageOf([REFUND])));

    renderWithQuery(<TicketListPage />);

    expect(await screen.findByText("Refund Request")).toBeDefined();
    // The wire value is an enum member; showing it raw would leak the schema.
    expect(screen.queryByText("refund_request")).toBeNull();
  });

  it("filters server-side, not over the page already fetched", async () => {
    responders.push(jsonResponse(pageOf([ticketRow(), REFUND])));
    renderWithQuery(<TicketListPage />);
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
    renderWithQuery(<TicketListPage />);
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

  /**
   * Pagination is keyset, so the second page is defined entirely by the cursor
   * the first one returned. Asserting the cursor is in the URL — rather than
   * just that more rows appeared — is what would catch it being dropped, which
   * silently re-fetches page one forever.
   */
  it("follows the cursor for the next page and appends to the table", async () => {
    responders.push(jsonResponse(pageOf([ticketRow()], "cursor-page-2")));

    renderWithQuery(<TicketListPage />);
    await screen.findByText("Cannot log in to the course portal");

    responders.push(jsonResponse(pageOf([REFUND])));
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));

    expect(
      await screen.findByText("Refund for the January cohort"),
    ).toBeDefined();
    // The first page is still on screen: pages accumulate, they do not replace.
    expect(
      screen.getByText("Cannot log in to the course portal"),
    ).toBeDefined();
    expect(requestedUrls[1]).toBe("/api/tickets?cursor=cursor-page-2");
  });

  it("offers no Load more when the last page came back", async () => {
    responders.push(jsonResponse(pageOf([ticketRow()], null)));

    renderWithQuery(<TicketListPage />);
    await screen.findByText("Cannot log in to the course portal");

    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
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

    renderWithQuery(<TicketListPage />);

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Could not load tickets")).toBeDefined();
    expect(within(alert).getByText("Database unavailable")).toBeDefined();
    // "No tickets" here would tell an agent their queue is clear when the API
    // never answered — the one wrong thing this screen could say.
    expect(screen.queryByText("No tickets match that filter")).toBeNull();
  });

  it("points at the ingestion path when the queue really is empty", async () => {
    responders.push(jsonResponse(pageOf([])));

    renderWithQuery(<TicketListPage />);

    expect(
      await screen.findByText("No tickets match that filter"),
    ).toBeDefined();
  });
});
