import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  ListTicketsResponse,
  TicketDetail,
  TicketSummary,
} from "@helpdesk/shared";
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
  studentEmail: "ben.student@example.com",
  status: "resolved",
  category: "refund_request",
});

function detailOf(row: TicketSummary, body: string): TicketDetail {
  return { ...row, body, supportEmail: "support@helpdesk.test" };
}

function pageOf(
  data: TicketSummary[],
  nextCursor: string | null = null,
): ListTicketsResponse {
  return { data, nextCursor };
}

describe("TicketListPage", () => {
  it("renders one row per ingested email and asks for no filters by default", async () => {
    responders.push(jsonResponse(pageOf([ticketRow(), REFUND])));

    renderWithQuery(<TicketListPage />);

    expect(
      await screen.findByText("Cannot log in to the course portal"),
    ).toBeDefined();
    expect(screen.getByText("ada.student@example.com")).toBeDefined();
    expect(screen.getByText("Refund for the January cohort")).toBeDefined();

    // No status or category param: the unfiltered list must not silently narrow.
    expect(requestedUrls[0]).toBe("/api/tickets");
  });

  // The null is the feature — nothing classifies — so it has to render as a
  // stated absence rather than as a blank space that reads like a layout bug.
  it("labels an unclassified ticket rather than leaving a gap", async () => {
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

  it("passes both filters at once", async () => {
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
   * The body is a second request by design, and this is what pins it: the list
   * response carries no `body` field at all, so if the row rendered the email
   * without opening it, it could only be rendering something it invented.
   */
  it("fetches the email body only when a row is opened", async () => {
    const row = ticketRow();
    responders.push(jsonResponse(pageOf([row])));

    renderWithQuery(<TicketListPage />);
    const trigger = await screen.findByRole("button", {
      name: /Cannot log in/,
    });

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(requestedUrls).toHaveLength(1);

    responders.push(
      jsonResponse(detailOf(row, "I have reset my password twice.")),
    );
    await userEvent.click(trigger);

    expect(
      await screen.findByText("I have reset my password twice."),
    ).toBeDefined();
    expect(requestedUrls[1]).toBe(`/api/tickets/${row.id}`);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
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
    // "No tickets yet" here would tell an agent their queue is clear when the
    // API never answered — the one wrong thing this screen could say.
    expect(screen.queryByText("No tickets yet")).toBeNull();
  });

  it("points at the ingestion path when the queue really is empty", async () => {
    responders.push(jsonResponse(pageOf([])));

    renderWithQuery(<TicketListPage />);

    expect(await screen.findByText("No tickets yet")).toBeDefined();
  });
});
