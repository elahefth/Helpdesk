import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithQuery } from "../test/render-with-query.tsx";
import { TicketSummaryCard } from "./TicketSummaryCard.tsx";

const TICKET_ID = "33333333-3333-4333-8333-333333333333";
const SUMMARY_PATH = `/api/tickets/${TICKET_ID}/summary`;

/**
 * Stubs `fetch` rather than `lib/api.ts`, like the other page tests: the
 * response still goes through `summarizeTicketResponseSchema`, so a field the
 * API stops sending fails here the way it fails the browser.
 */
type Responder = () => Promise<Response>;

const requests: { key: string; body: string | undefined }[] = [];
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
  requests.length = 0;
  handlers = {};
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = new URL(String(input), "http://localhost").pathname;
      const key = `${method} ${path}`;
      // Kept as the raw value rather than parsed: this route is supposed to
      // send no body at all, and `undefined` is the thing being asserted.
      requests.push({
        key,
        body: init?.body === undefined ? undefined : String(init.body),
      });
      const handler = handlers[key];
      return handler
        ? handler()
        : Promise.reject(new Error(`unstubbed request: ${key}`));
    }),
  );
});

afterEach(cleanup);

const summarizeButton = () =>
  screen.getByRole("button", { name: /summariz|regenerate/i });

describe("TicketSummaryCard", () => {
  /**
   * The point of the whole design: a summary costs a model call, so opening a
   * ticket must not spend one. A query here — even a lazy-looking one — is the
   * regression, and it would be invisible in the browser and expensive in the
   * bill.
   */
  it("asks for nothing until the button is pressed", async () => {
    renderWithQuery(<TicketSummaryCard ticketId={TICKET_ID} />);

    expect(
      (screen.getByRole("button", { name: "Summarize" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    // A tick for anything a mount might have queued.
    await Promise.resolve();
    expect(requests).toHaveLength(0);
  });

  it("summarizes the ticket on the button, and renders what comes back", async () => {
    handlers[`POST ${SUMMARY_PATH}`] = jsonResponse({
      summary:
        "The student was charged twice.\n\nSo far:\n- Nobody has replied.",
    });

    renderWithQuery(<TicketSummaryCard ticketId={TICKET_ID} />);
    await userEvent.click(summarizeButton());

    expect(
      await screen.findByText(/The student was charged twice/),
    ).toBeDefined();
    expect(requests.map((r) => r.key)).toEqual([`POST ${SUMMARY_PATH}`]);
  });

  /**
   * The material is the ticket and its thread, both of which the server holds.
   * A body creeping in here would be the first half of a summariser of
   * whatever the client sends, wearing a ticket's URL.
   */
  it("sends no body — the server has the ticket and the thread", async () => {
    handlers[`POST ${SUMMARY_PATH}`] = jsonResponse({ summary: "All quiet." });

    renderWithQuery(<TicketSummaryCard ticketId={TICKET_ID} />);
    await userEvent.click(summarizeButton());

    await screen.findByText("All quiet.");
    expect(requests[0]?.body).toBeUndefined();
  });

  it("disables the button and says so while the model is working", async () => {
    const gate = gatedResponse({ summary: "Done." });
    handlers[`POST ${SUMMARY_PATH}`] = gate.responder;

    renderWithQuery(<TicketSummaryCard ticketId={TICKET_ID} />);
    await userEvent.click(summarizeButton());

    const button = await screen.findByRole("button", { name: "Summarizing…" });
    expect((button as HTMLButtonElement).disabled).toBe(true);

    gate.release();
    await screen.findByText("Done.");
  });

  /**
   * "Re-generate every time" is the feature, not an implementation detail: the
   * second press asks the model again rather than showing what the first press
   * returned. An agent who has just replied and wants the summary to know about
   * it is the ordinary reason to press it twice.
   */
  it("regenerates on a second press rather than reusing the first answer", async () => {
    handlers[`POST ${SUMMARY_PATH}`] = jsonResponse({ summary: "First pass." });

    renderWithQuery(<TicketSummaryCard ticketId={TICKET_ID} />);
    await userEvent.click(summarizeButton());
    await screen.findByText("First pass.");

    // The label changes, because the second press does something different.
    const again = await screen.findByRole("button", { name: "Regenerate" });
    handlers[`POST ${SUMMARY_PATH}`] = jsonResponse({
      summary: "Second pass.",
    });
    await userEvent.click(again);

    await screen.findByText("Second pass.");
    expect(screen.queryByText("First pass.")).toBeNull();
    expect(requests).toHaveLength(2);
  });

  /**
   * Both a missing model (503) and a failed one (502) carry a message the API
   * writes to be shown as-is — it names the next move, so translating it here
   * would throw that away.
   */
  it.each([
    [503, "Ticket summaries are not configured on this server."],
    [502, "The model is rate-limited right now. Please try again in a minute."],
  ])("shows the API's own message for a %i", async (status, message) => {
    handlers[`POST ${SUMMARY_PATH}`] = errorResponse(
      status,
      status === 503 ? "service_unavailable" : "bad_gateway",
      message,
    );

    renderWithQuery(<TicketSummaryCard ticketId={TICKET_ID} />);
    await userEvent.click(summarizeButton());

    expect((await screen.findByRole("alert")).textContent).toContain(message);
    // Still pressable: a rate limit clears, and trying again is the next move
    // the message just named.
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Summarize" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
  });
});
