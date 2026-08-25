import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import type { TicketDetail } from "@helpdesk/shared";
import { renderWithQuery } from "../test/render-with-query.tsx";
import { TicketDetailPage } from "./TicketDetailPage.tsx";

/**
 * Stubs `fetch`, not `lib/api.ts`, like the other page tests here: the response
 * then still goes through `ticketDetailSchema`, so a field the API stops
 * sending fails this file the way it fails the browser rather than satisfying a
 * hand-written mock.
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

function errorResponse(status: number, code: string, message: string) {
  return jsonResponse({ error: { code, message } }, status);
}

/** A response the test releases by hand, so the pending state is assertable. */
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

const TICKET_ID = "33333333-3333-4333-8333-333333333333";

function ticket(overrides: Partial<TicketDetail> = {}): TicketDetail {
  return {
    id: TICKET_ID,
    subject: "Cannot log in to the course portal",
    studentName: "Ada Student",
    studentEmail: "ada.student@example.com",
    status: "open",
    category: "technical",
    body: "Hi,\n\nThe portal rejects my password.\n\nThanks,\nAda",
    supportEmail: "support@example.edu",
    receivedAt: "2026-08-20T09:15:00.000Z",
    createdAt: "2026-08-20T09:15:01.000Z",
    updatedAt: "2026-08-21T10:00:00.000Z",
    ...overrides,
  };
}

/**
 * Mounted behind the real route pattern rather than by passing an id as a prop,
 * because the id comes from `useParams` — the whole point of the page having an
 * address. A prop would test a component this app never renders.
 */
function renderDetail(id: string = TICKET_ID) {
  return renderWithQuery(
    <MemoryRouter initialEntries={[`/tickets/${id}`]}>
      <Routes>
        <Route path="/tickets/:id" element={<TicketDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("TicketDetailPage", () => {
  it("fetches the ticket named by the URL and renders it", async () => {
    responders.push(jsonResponse(ticket()));

    renderDetail();

    expect(
      await screen.findByRole("heading", {
        name: "Cannot log in to the course portal",
      }),
    ).toBeDefined();

    // The id in the path is the id in the request — the link from the queue is
    // otherwise a page showing somebody else's ticket.
    expect(requestedUrls).toEqual([`/api/tickets/${TICKET_ID}`]);

    expect(screen.getByText("Ada Student")).toBeDefined();
    expect(screen.getByText("<ada.student@example.com>")).toBeDefined();
    expect(screen.getByText("support@example.edu")).toBeDefined();
    expect(screen.getByText("open")).toBeDefined();
    expect(screen.getByText("Technical")).toBeDefined();
  });

  /**
   * The body is the reason this page exists — the list response omits it
   * deliberately, so nothing else in the SPA can show it.
   */
  it("renders the email body with its line breaks intact", async () => {
    responders.push(jsonResponse(ticket()));

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
    responders.push(jsonResponse(ticket({ studentName: null })));

    renderDetail();
    await screen.findByRole("heading", { name: /Cannot log in/ });

    expect(screen.getByText("ada.student@example.com")).toBeDefined();
    // The bare address, not one wrapped in the angle brackets that only make
    // sense beside a name.
    expect(screen.queryByText("<ada.student@example.com>")).toBeNull();
  });

  it("says unclassified rather than showing an empty category", async () => {
    responders.push(jsonResponse(ticket({ category: null })));

    renderDetail();
    await screen.findByRole("heading", { name: /Cannot log in/ });

    expect(screen.getByText("unclassified")).toBeDefined();
  });

  it("shows a placeholder while the ticket loads", async () => {
    const { responder, release } = gatedResponse(ticket());
    responders.push(responder);

    renderDetail();

    expect(
      document.querySelectorAll('[data-slot="skeleton"]').length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("Loading ticket…")).toBeDefined();

    release();

    await screen.findByRole("heading", { name: /Cannot log in/ });
    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBe(0);
  });

  /**
   * A 404 is a dead link, not a failure — the reader's next move is the queue,
   * so it must not be dressed up as something worth retrying.
   */
  it("reports a missing ticket without retrying it", async () => {
    responders.push(
      errorResponse(404, "not_found", `Ticket ${TICKET_ID} not found`),
    );

    renderDetail();

    expect(await screen.findByText("No such ticket")).toBeDefined();
    // One request. A retry re-asks a question the API has answered, and the
    // second 404 would arrive as an unstubbed-request rejection here.
    expect(requestedUrls).toHaveLength(1);
  });

  it("reports a real failure as a failure", async () => {
    // Two responders: this one is retryable, unlike the 404 above, so the
    // second is what the retry consumes.
    responders.push(
      errorResponse(503, "service_unavailable", "Database unavailable"),
      errorResponse(503, "service_unavailable", "Database unavailable"),
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
    responders.push(errorResponse(404, "not_found", "Ticket not found"));

    renderDetail();
    await screen.findByText("No such ticket");

    expect(
      screen
        .getByRole("link", { name: /Back to tickets/ })
        .getAttribute("href"),
    ).toBe("/");
  });

  it("labels every header field", async () => {
    responders.push(jsonResponse(ticket()));

    renderDetail();
    await screen.findByRole("heading", { name: /Cannot log in/ });

    // Every value is paired with a label, and in the order a reader scans an
    // email header: who it is from, who it reached, and when.
    expect(screen.getAllByRole("term").map((dt) => dt.textContent)).toEqual([
      "From",
      "To",
      "Received",
      "Last updated",
    ]);
  });
});
