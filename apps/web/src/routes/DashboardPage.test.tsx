import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { TICKET_TREND_DAYS, type TicketStats } from "@helpdesk/shared";
import { renderWithQuery } from "../test/render-with-query.tsx";
import { DashboardPage, formatDuration } from "./DashboardPage.tsx";

/**
 * Stubs `fetch` rather than `lib/api.ts`, like `UsersPage.test.tsx`: the
 * response then still goes through `ticketStatsSchema`, so a contract drift
 * fails here as a Zod throw — the way it fails in the browser — rather than
 * sailing past a mock that satisfies only the TypeScript type.
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

/**
 * A full window of zero-filled days, the shape the API guarantees. Counts
 * ascend so a test can tell one bar from another by height.
 */
function windowOf(counts: number[] = []): TicketStats["daily"] {
  return Array.from({ length: TICKET_TREND_DAYS }, (_, index) => ({
    // A fixed window, so a test never depends on the day it runs.
    date: `2026-09-${String(index + 1).padStart(2, "0")}`,
    count: counts[index] ?? 0,
  }));
}

function stats(overrides: Partial<TicketStats> = {}): TicketStats {
  return {
    daily: windowOf([3, 0, 7]),
    total: 100,
    open: 42,
    resolved: 51,
    aiResolved: 30,
    aiEscalated: 10,
    averageResolutionSeconds: 22_500,
    resolutionSampleSize: 58,
    ...overrides,
  };
}

/** The tile's value, found through its label rather than by position. */
function tileValue(label: string): string {
  const labelNode = screen.getByText(label);
  const value = labelNode.nextElementSibling;
  if (!value) throw new Error(`no value rendered under "${label}"`);
  return value.textContent ?? "";
}

describe("DashboardPage", () => {
  it("renders every headline figure", async () => {
    responders.push(jsonResponse(stats()));

    renderWithQuery(<DashboardPage />);

    await waitFor(() => {
      expect(tileValue("Total tickets")).toBe("100");
    });

    expect(tileValue("Open tickets")).toBe("42");
    expect(tileValue("Resolved by AI")).toBe("30");
    // 30 of 100.
    expect(tileValue("AI resolution rate")).toBe("30%");
    // 22,500s = 6h 15m.
    expect(tileValue("Average resolution time")).toBe("6h 15m");
  });

  /**
   * The dashboard exists to count what the queue hides, so it must not inherit
   * the queue's `handledBy=human` default — a request carrying one would report
   * "resolved by AI: 0" forever, which looks exactly like an assistant that
   * never works.
   */
  it("asks for unfiltered counts", async () => {
    responders.push(jsonResponse(stats()));

    renderWithQuery(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByText("Total tickets")).toBeTruthy();
    });

    expect(requestedUrls).toHaveLength(1);
    const url = requestedUrls[0] ?? "";
    expect(url.startsWith("/api/stats?")).toBe(true);
    // The queue's filter must not follow the dashboard: `handledBy=human` would
    // hide precisely the tickets this page exists to count.
    expect(url).not.toContain("handled");
    // The chart's day boundaries are the reader's, so the zone rides along.
    expect(url).toContain("tz=");
  });

  /**
   * The sample the average was taken over is part of the average. `resolved_at`
   * is only recorded from the migration that added it onward, so a figure that
   * covers 58 of 100 tickets and says nothing is a figure read as covering all
   * of them.
   */
  it("names the sample the average covers", async () => {
    responders.push(jsonResponse(stats()));

    renderWithQuery(<DashboardPage />);

    expect(await screen.findByText("Across 58 resolved tickets")).toBeTruthy();
  });

  /**
   * An empty install must not read as a fast one. Nothing has been resolved, so
   * the average has no value — and 0, or "0m", would be the page asserting that
   * every ticket was answered instantly.
   */
  it("shows no average rather than zero when nothing has been resolved", async () => {
    responders.push(
      jsonResponse(
        stats({
          total: 0,
          open: 0,
          resolved: 0,
          aiResolved: 0,
          aiEscalated: 0,
          averageResolutionSeconds: null,
          resolutionSampleSize: 0,
        }),
      ),
    );

    renderWithQuery(<DashboardPage />);

    await waitFor(() => {
      expect(tileValue("Total tickets")).toBe("0");
    });

    expect(tileValue("Average resolution time")).toBe("—");
    // A share of nothing is not 0% — nothing was asked of the assistant either.
    expect(tileValue("AI resolution rate")).toBe("—");
    expect(screen.getByText("No resolution times recorded yet.")).toBeTruthy();
  });

  it("shows placeholders before the counts arrive", () => {
    // No responder is pushed, so the request never settles.
    responders.push(() => new Promise<Response>(() => {}));

    renderWithQuery(<DashboardPage />);

    expect(
      document.querySelectorAll('[data-slot="skeleton"]').length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("Total tickets")).toBeNull();
  });

  it("reports a failure instead of rendering empty tiles", async () => {
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

    renderWithQuery(<DashboardPage />);

    expect(
      await screen.findByText("Could not load the dashboard"),
    ).toBeTruthy();
    expect(screen.queryByText("Total tickets")).toBeNull();
  });
});

/**
 * Pinned separately from the page because the boundaries are where it goes
 * wrong, and a rendered tile only ever exercises one of them.
 */
describe("formatDuration", () => {
  it("has no value for a missing average", () => {
    expect(formatDuration(null)).toBe("—");
  });

  /** "0m" reads as a missing number rather than as a fast answer. */
  it("does not round a fast resolution down to zero", () => {
    expect(formatDuration(30)).toBe("under a minute");
  });

  it("drops the smaller unit when it is zero", () => {
    expect(formatDuration(2 * 3600)).toBe("2h");
    expect(formatDuration(3 * 86_400)).toBe("3d");
  });

  it("carries two units, largest first", () => {
    expect(formatDuration(45 * 60)).toBe("45m");
    expect(formatDuration(6 * 3600 + 15 * 60)).toBe("6h 15m");
    expect(formatDuration(2 * 86_400 + 5 * 3600)).toBe("2d 5h");
  });
});
