import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { TicketStats } from "@helpdesk/shared";
import { getTicketStats } from "../lib/api.ts";
import { TicketTrendChart } from "./TicketTrendChart.tsx";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The em dash every tile falls back to when its number does not exist yet.
 *
 * Not "0", and the distinction is the whole reason this constant is named: an
 * average of zero seconds and no resolution times recorded are opposite facts,
 * and a dashboard that renders the second one as the first is a dashboard
 * reporting instant resolutions it invented. The caption under each tile says
 * which case it is.
 */
const NO_VALUE = "—";

/**
 * Thousands separators, from the reader's own locale.
 *
 * Deliberately *not* `tabular-nums` at the point of use: these are large
 * standalone figures rather than a column that has to align, and tabular
 * digits give every glyph the width of a `0`, which reads as loose spacing at
 * display sizes.
 */
const formatCount = (value: number) => value.toLocaleString();

/**
 * A count as a share of a whole.
 *
 * Derived here rather than sent by the API, because a percentage is a division
 * and a division on the wire is a second place the numerator and denominator
 * get chosen — a tile reading "38%" beside tiles reading 100 and 38 could
 * disagree with both and nothing on screen would say which had drifted. This
 * way the arithmetic is the one the reader can do themselves.
 *
 * A zero whole is `NO_VALUE` rather than 0%: on an empty install nothing has
 * been resolved *and* nothing has been asked, and "0%" states the first while
 * hiding the second.
 */
function formatShare(part: number, whole: number): string {
  if (whole <= 0) return NO_VALUE;
  return `${Math.round((part / whole) * 100)}%`;
}

/**
 * Seconds as a duration a person reads at a glance.
 *
 * Two units at most, largest first, and the smaller one dropped when it is
 * zero. Support durations span minutes to weeks, so a single unit is wrong at
 * both ends — "0.004 days" and "9,312 minutes" are the same unreadable number
 * — and three units is a precision the average of a handful of tickets does
 * not have.
 */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return NO_VALUE;

  // Rounds to the minute below a minute rather than showing "0m", which reads
  // as a missing value rather than as a fast answer.
  if (seconds < 60) return "under a minute";

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const restMinutes = minutes % 60;
    return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days}d ${restHours}h` : `${days}d`;
}

interface StatTileProps {
  /** Sentence case, no trailing colon — it labels the number, it does not introduce it. */
  label: string;
  value: string;
  /**
   * What the number is of, or why it is missing. Always present: a bare figure
   * on a dashboard is one the reader has to guess the denominator for, and they
   * guess wrong in whichever direction flatters the number.
   */
  caption: string;
  /**
   * The one oversized figure on the page. Exactly one tile sets it — a view
   * with two hero numbers has none, because the size is what says "start here".
   */
  hero?: boolean;
  /** An optional mark under the value, for a tile whose number is a proportion. */
  children?: ReactNode;
  className?: string;
}

function StatTile({
  label,
  value,
  caption,
  hero = false,
  children,
  className,
}: StatTileProps) {
  return (
    <Card className={className}>
      <CardContent className="space-y-2">
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
        <p
          className={
            hero
              ? "text-5xl leading-none font-semibold tracking-tight"
              : "text-3xl leading-none font-semibold tracking-tight"
          }
        >
          {value}
        </p>
        {children}
        <p className="text-sm text-muted-foreground">{caption}</p>
      </CardContent>
    </Card>
  );
}

/**
 * A single proportion, drawn.
 *
 * The bar is redundant with the percentage above it and that is deliberate:
 * it is the only mark on the page, so it carries no identity and needs no
 * legend — it exists so "is the assistant doing most of this or a corner of
 * it" is answerable without reading a number. Track and fill are two steps of
 * the one ramp, which keeps it legible where a fill against a neutral track
 * would vanish.
 *
 * `aria-hidden`, because the value is already in the text beside it and a
 * second announcement of the same figure is noise rather than access.
 */
function ShareBar({ part, whole }: { part: number; whole: number }) {
  const fraction = whole > 0 ? Math.min(part / whole, 1) : 0;

  return (
    <div
      aria-hidden="true"
      className="h-2 w-full overflow-hidden rounded-full bg-primary/15"
    >
      <div
        className="h-full rounded-full bg-primary"
        style={{ width: `${fraction * 100}%` }}
      />
    </div>
  );
}

/** Five tiles' worth of placeholder, in the grid the real tiles land in. */
function StatsSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {[
        "lg:col-span-2",
        "",
        "",
        "",
        "lg:col-span-3",
        // Keys are positional and the list is static, so the index is stable —
        // there is nothing here to reorder.
      ].map((span, index) => (
        <Card key={index} className={span}>
          <CardContent className="space-y-3">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-9 w-20" />
            <Skeleton className="h-4 w-32" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function StatTiles({ stats }: { stats: TicketStats }) {
  /**
   * Everything the assistant was asked about and answered one way or the
   * other — the honest denominator for "how often does it resolve a ticket",
   * and not the one the headline share uses.
   *
   * Both readings are on the page, and they are different questions. The
   * headline is "what share of all tickets did the AI close", which is what a
   * team is measuring when they ask whether this feature is paying for itself;
   * this one is "when it looks at a ticket, how often can it answer", which is
   * about the assistant rather than about the workload. A single percentage
   * would have to be one of them and would be read as the other.
   */
  const aiHandled = stats.aiResolved + stats.aiEscalated;

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatTile
        hero
        className="lg:col-span-2"
        label="Total tickets"
        value={formatCount(stats.total)}
        caption="Every email that has arrived at the support address."
      />

      <StatTile
        label="Open tickets"
        value={formatCount(stats.open)}
        caption={
          stats.total > 0
            ? `${formatShare(stats.open, stats.total)} of all tickets`
            : "Nothing has arrived yet."
        }
      />

      <StatTile
        label="Average resolution time"
        value={formatDuration(stats.averageResolutionSeconds)}
        /*
         * The sample size is not decoration. `resolved_at` is only recorded
         * from the migration that added it onward, so tickets resolved before
         * then are excluded — naming the count is what stops an average of
         * twelve reading as an average of the whole queue.
         */
        caption={
          stats.resolutionSampleSize > 0
            ? `Across ${formatCount(stats.resolutionSampleSize)} resolved ${
                stats.resolutionSampleSize === 1 ? "ticket" : "tickets"
              }`
            : "No resolution times recorded yet."
        }
      />

      <StatTile
        label="Resolved by AI"
        value={formatCount(stats.aiResolved)}
        caption={
          stats.aiEscalated > 0
            ? `${formatCount(stats.aiEscalated)} handed back to a person`
            : "Answered from the knowledge base."
        }
      />

      {/*
        A second tile about the same column as the one above it, and not a
        duplicate of it: that one is how much work the assistant took off the
        team, this is what fraction of the whole that was. A count with no share
        flatters a busy week and a share with no count flatters a quiet one, so
        neither is shippable alone.
      */}
      <StatTile
        className="lg:col-span-3"
        label="AI resolution rate"
        value={formatShare(stats.aiResolved, stats.total)}
        caption={
          aiHandled > 0
            ? `${formatCount(stats.aiResolved)} of ${formatCount(
                stats.total,
              )} tickets — and ${formatShare(
                stats.aiResolved,
                aiHandled,
              )} of the ${formatCount(aiHandled)} the assistant looked at`
            : "The assistant has not answered a ticket yet."
        }
      >
        <ShareBar part={stats.aiResolved} whole={stats.total} />
      </StatTile>
    </div>
  );
}

/**
 * The numbers behind the queue.
 *
 * A separate screen rather than a strip above `TicketListPage`, because the two
 * answer different questions and one of them is not asked every day: the queue
 * is where work happens and a row of aggregates above it is a permanent tax on
 * the screen an agent actually reads.
 *
 * It does not poll, unlike the queue. The queue refetches while a ticket on
 * screen is mid-classification — something there will change on its own within
 * seconds — whereas these counts move as tickets arrive all day and no single
 * reading of them is the one the reader is waiting for. The client's 30s
 * `staleTime` means coming back to the tab refetches; a tile that ticks while
 * being read is movement bought for nothing.
 */
export function DashboardPage() {
  const { data, isPending, isError, error } = useQuery({
    queryKey: ["ticket-stats"],
    queryFn: getTicketStats,
  });

  return (
    <section className="space-y-6">
      <header className="space-y-1">
        {/*
          `h2` continues the layout's `h1` wordmark, the level TicketListPage
          and TicketDetailPage both use — navigating between screens must not
          add or drop a level in the document outline.
        */}
        <h2 className="text-2xl font-semibold tracking-tight">Dashboard</h2>
        <p className="text-muted-foreground">
          Counts over every ticket, including the ones the assistant handled —
          the queue hides those by default.
        </p>
      </header>

      {isPending && (
        <>
          <StatsSkeleton />
          <Card>
            <CardContent className="space-y-3">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-40 w-full" />
            </CardContent>
          </Card>
        </>
      )}

      {isError && (
        <Alert variant="destructive">
          <AlertTitle>Could not load the dashboard</AlertTitle>
          <AlertDescription>{(error as Error).message}</AlertDescription>
        </Alert>
      )}

      {data && (
        <>
          <StatTiles stats={data} />
          {/*
            Under the tiles, which is the order the two are read in: the tiles
            say where the queue stands, the chart says how it got there. It
            comes from the same response, so the two cannot describe different
            moments.
          */}
          <TicketTrendChart daily={data.daily} />
        </>
      )}
    </section>
  );
}
