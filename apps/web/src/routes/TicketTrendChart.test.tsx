import { afterEach, describe, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { TICKET_TREND_DAYS, type TicketsPerDay } from "@helpdesk/shared";
import { TicketTrendChart } from "./TicketTrendChart.tsx";

afterEach(cleanup);

/**
 * A fixed window rather than one built from `Date.now()`, so a test never
 * changes its mind at midnight or in another time zone.
 */
function windowOf(counts: number[]): TicketsPerDay[] {
  return Array.from({ length: TICKET_TREND_DAYS }, (_, index) => ({
    date: `2026-09-${String(index + 1).padStart(2, "0")}`,
    count: counts[index] ?? 0,
  }));
}

/** One day's full-height hit target — the element the readout listens on. */
function hoverColumn(index: number): Element {
  const column = document.querySelectorAll(".group")[index];
  if (!column) throw new Error(`no column at ${index}`);
  return column;
}

/**
 * The readout line above the plot.
 *
 * Read as whole text rather than matched with a date-shaped regex: the labels
 * come from `toLocaleDateString`, so "2 September" and "September 2" are both
 * correct depending on where the test runs. Asserting the parts separately is
 * what keeps this from passing in one locale and failing in another.
 */
const readout = () =>
  screen.getByText((_, node) => node?.getAttribute("aria-live") === "polite")
    .textContent ?? "";

/** The accessible table is the chart's data, so assertions read it. */
const dataRows = () =>
  within(screen.getByRole("table")).getAllByRole("row").slice(1);

describe("TicketTrendChart", () => {
  it("renders one entry per day in the window", () => {
    render(<TicketTrendChart daily={windowOf([1, 2, 3])} />);

    expect(dataRows()).toHaveLength(TICKET_TREND_DAYS);
  });

  /**
   * The zero days are the point of the server's zero-fill, and dropping them
   * here would undo it: a chart that skips empty days slides every later bar
   * onto the wrong date rather than showing a gap.
   */
  it("keeps empty days", () => {
    render(<TicketTrendChart daily={windowOf([5, 0, 5])} />);

    const cells = dataRows().map(
      (row) => within(row).getAllByRole("cell")[0]?.textContent,
    );
    expect(cells[0]).toBe("5");
    expect(cells[1]).toBe("0");
    expect(cells[2]).toBe("5");
  });

  /**
   * `new Date("2026-09-01")` parses as UTC midnight, so a naive renderer shows
   * the 31st of August to anyone west of Greenwich. The day the server chose
   * has to survive to the label.
   */
  it("labels a day as the day the server named", () => {
    render(<TicketTrendChart daily={windowOf([1])} />);

    const first = dataRows()[0];
    expect(within(first!).getByRole("rowheader").textContent).toContain("1");
    expect(within(first!).getByRole("rowheader").textContent).toContain(
      "September",
    );
  });

  it("summarises the window until a bar is hovered", () => {
    render(<TicketTrendChart daily={windowOf([4, 6])} />);

    expect(screen.getByText(/10 tickets over 30 days/)).toBeTruthy();
    expect(screen.getByText(/busiest day 6 tickets/)).toBeTruthy();
  });

  it("reads out the hovered day", () => {
    render(<TicketTrendChart daily={windowOf([4, 6])} />);

    // `fireEvent` rather than `userEvent.hover`, which drives the pointer
    // through mouseover and never reaches React's onPointerEnter under
    // happy-dom. The readout is what the hover is for, so the test asserts the
    // handler the component actually listens on.
    fireEvent.pointerEnter(hoverColumn(1));

    expect(readout()).toContain("September");
    expect(readout()).toContain("2");
    expect(readout()).toContain("6 tickets");
  });

  /** Singular matters in a readout that is read as a sentence. */
  it("does not pluralise a single ticket", () => {
    render(<TicketTrendChart daily={windowOf([1])} />);

    fireEvent.pointerEnter(hoverColumn(0));

    expect(readout()).toContain("1 ticket");
    expect(readout()).not.toContain("1 tickets");
  });

  /**
   * A count of 1 against a busy day's scale rounds to a sub-pixel bar. The
   * distinction between "one ticket" and "none" is the one this chart cannot
   * lose, so a nonzero day always has a mark and a zero day never does.
   */
  it("keeps a tiny count visible and leaves an empty day blank", () => {
    const { container } = render(
      <TicketTrendChart daily={windowOf([500, 1, 0])} />,
    );

    const bars = container.querySelectorAll<HTMLElement>(".bg-primary");
    expect(bars[1]?.style.minHeight).toBe("2px");
    expect(bars[2]?.style.minHeight).toBe("0");
    expect(bars[2]?.style.height).toBe("0%");
  });

  it("scales bars against the busiest day", () => {
    const { container } = render(
      <TicketTrendChart daily={windowOf([10, 5])} />,
    );

    const bars = container.querySelectorAll<HTMLElement>(".bg-primary");
    expect(bars[0]?.style.height).toBe("100%");
    expect(bars[1]?.style.height).toBe("50%");
  });

  /**
   * An all-zero window is a real answer — a new install, or a quiet month — and
   * a flat axis with thirty invisible bars reads as a chart that failed to
   * load.
   */
  it("says so when nothing arrived", () => {
    render(<TicketTrendChart daily={windowOf([])} />);

    expect(
      screen.getByText("No tickets arrived in the last 30 days."),
    ).toBeTruthy();
    expect(document.querySelectorAll(".bg-primary")).toHaveLength(0);
    // The table still carries the window, so the data is never unreachable.
    expect(dataRows()).toHaveLength(TICKET_TREND_DAYS);
  });

  /**
   * Thirty date labels do not fit. The window's last day is the one a reader
   * looks for, so it is always drawn.
   */
  it("labels a readable subset of days, always including the last", () => {
    const { container } = render(<TicketTrendChart daily={windowOf([1])} />);

    const ticks = [...container.querySelectorAll("[data-axis-tick]")].map(
      (node) => node.textContent ?? "",
    );

    expect(ticks.length).toBeGreaterThan(1);
    expect(ticks.length).toBeLessThan(TICKET_TREND_DAYS / 2);
    // 2026-09-30 is the last day of the fixture window.
    expect(ticks.at(-1)).toContain("30");
  });
});
