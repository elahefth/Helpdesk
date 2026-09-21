import { useState } from "react";
import { TICKET_TREND_DAYS, type TicketsPerDay } from "@helpdesk/shared";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * `YYYY-MM-DD` to a `Date` at **local** midnight.
 *
 * `new Date("2026-08-23")` is the trap this exists to avoid: a bare date string
 * is parsed as UTC midnight, so `toLocaleDateString` renders it as the 22nd for
 * every reader west of Greenwich. The server already decided which day each
 * ticket belongs to — re-deriving it here would undo that decision for half the
 * world, silently, and only ever by one day.
 */
function parseCalendarDay(iso: string): Date {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
}

/** "23 Aug" — the axis has room for a day and a month and nothing else. */
const formatTick = (iso: string) =>
  parseCalendarDay(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });

/** "Sunday, 23 August" — the readout has one line and can afford the weekday. */
const formatReadout = (iso: string) =>
  parseCalendarDay(iso).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

const plural = (count: number, noun: string) =>
  `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;

/**
 * Which bars get a date under them.
 *
 * Thirty labels do not fit, and shrinking the type until they do makes the axis
 * unreadable rather than complete. Every seventh day plus the last one lands on
 * a weekly rhythm with a fixed right-hand anchor — and the last is forced
 * because "where does this window end" is the one label a reader actually looks
 * for. The penultimate tick is dropped when the forced one would collide with
 * it.
 */
function isTick(index: number, total: number): boolean {
  const last = total - 1;
  if (index === last) return true;
  if (index % 7 !== 0) return false;
  // Within three days of the right-hand anchor the two labels overlap; the
  // anchor wins, because it is the one carrying the window's end date.
  return last - index > 3;
}

interface TicketTrendChartProps {
  daily: TicketsPerDay[];
}

/**
 * Arrivals per day over the last `TICKET_TREND_DAYS` days.
 *
 * Built out of divs rather than an SVG or a charting library, and that is a
 * decision rather than a shortcut. Thirty bars of one series need no scales, no
 * axes engine and no layout pass — flexbox gives responsive widths for free,
 * where an SVG would need a `viewBox` and a resize observer to match. A chart
 * dependency is worth adding the day this needs a second series, a time axis
 * that skips weekends, or interpolation; none of those is a bar per day.
 *
 * One series, so there is no legend: the card's title names what the bars are,
 * and a legend box repeating it is furniture. Identity is never carried by
 * colour here because there is only one thing to identify.
 */
export function TicketTrendChart({ daily }: TicketTrendChartProps) {
  /**
   * Which bar the pointer is on, or null for none.
   *
   * The readout it feeds sits *above* the plot rather than floating over the
   * hovered bar, because `Card` is `overflow-hidden` — a tooltip on the first
   * or last column would be clipped by the card's own rounded corner, and the
   * two bars most likely to be inspected are the ends of the window. A fixed
   * readout cannot be clipped, cannot escape the viewport, and needs no
   * collision logic.
   */
  const [hovered, setHovered] = useState<number | null>(null);

  const counts = daily.map((day) => day.count);
  const busiest = Math.max(0, ...counts);
  const arrived = counts.reduce((sum, count) => sum + count, 0);

  const active = hovered === null ? undefined : daily[hovered];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tickets per day</CardTitle>
        <CardDescription>
          Arrivals over the last {TICKET_TREND_DAYS} days, by the day they
          arrived in your time zone.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        {/*
          Always rendered, hovered or not, so the plot below never shifts up and
          down by a line as the pointer crosses it. Empty space would make the
          whole chart jump on hover, which reads as a rendering fault.
        */}
        <p className="text-sm" aria-live="polite">
          {active ? (
            <>
              <span className="font-medium">{formatReadout(active.date)}</span>
              <span className="text-muted-foreground">
                {" · "}
                {plural(active.count, "ticket")}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">
              {plural(arrived, "ticket")} over {TICKET_TREND_DAYS} days
              {busiest > 0 && <> · busiest day {plural(busiest, "ticket")}</>}
            </span>
          )}
        </p>

        {busiest === 0 ? (
          <div className="flex h-40 items-center justify-center rounded-lg border border-dashed">
            <p className="text-sm text-muted-foreground">
              No tickets arrived in the last {TICKET_TREND_DAYS} days.
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            <div className="flex gap-3">
              {/*
                The only two gridlines worth drawing: the scale's top and its
                floor. A full grid behind thirty bars competes with the bars for
                attention and answers a question — "what is this one worth,
                exactly" — that the readout already answers precisely.
              */}
              <div className="flex h-40 w-8 shrink-0 flex-col justify-between text-right text-xs tabular-nums text-muted-foreground">
                <span>{busiest}</span>
                <span>0</span>
              </div>

              <div
                className="relative h-40 flex-1"
                onPointerLeave={() => setHovered(null)}
              >
                <div
                  aria-hidden="true"
                  className="absolute inset-x-0 top-0 border-t border-border"
                />
                <div
                  aria-hidden="true"
                  className="absolute inset-x-0 bottom-0 border-t border-border"
                />

                {/*
                  `items-end` anchors every bar to the baseline — a bar that
                  floats is a bar whose length stops meaning its value. `gap-0.5`
                  is the 2px of surface between adjacent marks that keeps thirty
                  of them from reading as one block.
                */}
                <div className="absolute inset-0 flex items-end gap-0.5">
                  {daily.map((day, index) => {
                    const height = (day.count / busiest) * 100;

                    return (
                      // The hit target is the full-height column, not the bar:
                      // a quiet day's bar is a few pixels tall, and a target
                      // that small is one a pointer cannot land on.
                      <div
                        key={day.date}
                        className="group relative flex h-full flex-1 items-end"
                        onPointerEnter={() => setHovered(index)}
                      >
                        <div
                          aria-hidden="true"
                          className={
                            hovered === index
                              ? "absolute inset-0 bg-muted"
                              : "hidden"
                          }
                        />
                        <div
                          // `min-height` so a count of 1 against a busy day's
                          // scale is still a visible mark rather than a
                          // sub-pixel nothing — the difference between "one
                          // ticket" and "none" is the one this chart must keep.
                          // Zero gets no mark at all, which is what makes an
                          // empty day legible as empty.
                          className="relative w-full rounded-t-[4px] bg-primary transition-opacity group-hover:opacity-80"
                          style={{
                            height: `${height}%`,
                            minHeight: day.count > 0 ? "2px" : "0",
                          }}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Mirrors the plot's column widths so a label sits under its bar. */}
            <div className="flex gap-3">
              <div className="w-8 shrink-0" />
              {/*
                Fixed height, because every label inside is absolutely
                positioned and a row of nothing but absolute children collapses
                to zero.
              */}
              <div className="flex h-4 flex-1 gap-0.5">
                {daily.map((day, index) => (
                  <div key={day.date} className="relative min-w-0 flex-1">
                    {isTick(index, daily.length) && (
                      <span
                        data-axis-tick=""
                        /*
                         * Anchored rather than aligned, and that is a fix for
                         * something `text-align` cannot do. A label is far
                         * wider than the column it belongs to — thirty days
                         * across a phone leaves each about eight pixels — so
                         * the line overflows, and an overflowing nowrap line
                         * ignores `text-align` and always spills to the right.
                         * Measured: the last label ran 14px past the card,
                         * which is `overflow-hidden`, so "Sep 21" rendered as
                         * "Sep" — the one label that says where the window
                         * ends. An absolutely positioned span is sized to its
                         * own text, so anchoring its right edge actually holds
                         * it inside.
                         */
                        className={`absolute top-0 text-xs whitespace-nowrap text-muted-foreground ${
                          index === 0
                            ? "left-0"
                            : index === daily.length - 1
                              ? "right-0"
                              : "left-1/2 -translate-x-1/2"
                        }`}
                      >
                        {formatTick(day.date)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/*
          The chart's data as a table, for a reader who is not using a pointer.
          The bars carry no `tabindex` deliberately — thirty stops between the
          tiles above and whatever follows is a keyboard trap dressed as access —
          so this is the accessible path to the same numbers rather than a
          fallback nobody maintains.
        */}
        <table className="sr-only">
          <caption>
            Tickets received per day over the last {TICKET_TREND_DAYS} days
          </caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">Tickets</th>
            </tr>
          </thead>
          <tbody>
            {daily.map((day) => (
              <tr key={day.date}>
                <th scope="row">{formatReadout(day.date)}</th>
                <td>{day.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
