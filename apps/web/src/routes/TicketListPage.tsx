import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  CATEGORY_LABELS,
  TICKET_CATEGORIES,
  TICKET_STATUSES,
  type TicketCategory,
  type TicketStatus,
  type TicketSummary,
} from "@helpdesk/shared";
import { listTickets } from "../lib/api.ts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

/** Base UI's Select renders labels from `items` rather than the raw value. */
const STATUS_ITEMS = [
  { label: "All", value: "all" },
  ...TICKET_STATUSES.map((value) => ({ label: value, value })),
];

const CATEGORY_ITEMS = [
  { label: "All", value: "all" },
  ...TICKET_CATEGORIES.map((value) => ({
    label: CATEGORY_LABELS[value],
    value,
  })),
];

/** Same shape the users table uses for `createdAt` — a date, not a timestamp. */
const formatCreated = (iso: string) => new Date(iso).toLocaleDateString();

/**
 * The support queue.
 *
 * The table is hand-rolled for the same reason `UsersPage`'s is: five columns
 * of static markup do not need a table primitive's eight wrapper components,
 * and the two screens reading the same way matters more than either of them
 * being clever. When a screen finally needs sorting or column control, that is
 * the one that should pick the table layer — and then both move together.
 *
 * Filters are server-side — the values go into the query string that
 * `listTicketsQuerySchema` parses — rather than a filter over the fetched page,
 * which would only ever narrow the rows already on screen.
 */
export function TicketListPage() {
  const [status, setStatus] = useState<TicketStatus | "all">("all");
  const [category, setCategory] = useState<TicketCategory | "all">("all");

  const {
    data,
    isPending,
    isError,
    error,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ["tickets", { status, category }],
    queryFn: ({ pageParam }) =>
      listTickets({
        ...(status === "all" ? {} : { status }),
        ...(category === "all" ? {} : { category }),
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: undefined as string | undefined,
    // `nextCursor` is null on the last page; undefined is what switches
    // hasNextPage off.
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const tickets = data?.pages.flatMap((page) => page.data) ?? [];

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-semibold tracking-tight">Tickets</h2>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor="status" className="text-muted-foreground">
          Status
        </Label>
        <Select
          items={STATUS_ITEMS}
          value={status}
          onValueChange={(value) => setStatus(value as TicketStatus | "all")}
        >
          <SelectTrigger id="status" className="min-w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {STATUS_ITEMS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>

        <Label htmlFor="category" className="ml-4 text-muted-foreground">
          Category
        </Label>
        <Select
          items={CATEGORY_ITEMS}
          value={category}
          onValueChange={(value) =>
            setCategory(value as TicketCategory | "all")
          }
        >
          <SelectTrigger id="category" className="min-w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {CATEGORY_ITEMS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      {isPending && <TicketsTableSkeleton />}

      {isError && (
        <Alert variant="destructive">
          <AlertTitle>Could not load tickets</AlertTitle>
          <AlertDescription>{(error as Error).message}</AlertDescription>
        </Alert>
      )}

      {data && tickets.length === 0 && (
        <Card className="border-dashed">
          <CardContent className="py-10 text-center">
            <p className="font-medium">No tickets match that filter</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Tickets appear here when email arrives at the support address.
              Deliver one with <code>bun run email:send</code>.
            </p>
          </CardContent>
        </Card>
      )}

      {data && tickets.length > 0 && (
        <div className="space-y-4">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <TicketsTableHead />
              <tbody className="divide-y">
                {tickets.map((ticket) => (
                  <tr key={ticket.id}>
                    <td className="py-3 pr-4 font-medium">{ticket.subject}</td>
                    <td className="py-3 pr-4">
                      <Sender ticket={ticket} />
                    </td>
                    <td className="py-3 pr-4">
                      <Badge
                        variant={
                          ticket.status === "open" ? "default" : "secondary"
                        }
                      >
                        {ticket.status}
                      </Badge>
                    </td>
                    <td className="py-3 pr-4">
                      {/*
                       * The null is the feature — nothing classifies — so it
                       * renders as a stated absence rather than an empty cell
                       * that reads like a rendering bug.
                       */}
                      {ticket.category ? (
                        <Badge variant="outline">
                          {CATEGORY_LABELS[ticket.category]}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">
                          unclassified
                        </span>
                      )}
                    </td>
                    <td className="py-3 text-muted-foreground">
                      {formatCreated(ticket.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {hasNextPage && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void fetchNextPage()}
              disabled={isFetchingNextPage}
            >
              {isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * The From header, as one cell.
 *
 * `studentName` is null for mail that carried a bare address and for every
 * ticket ingested before the column existed, so the address is the fallback
 * rather than the second line. Showing the name alone would hide the only part
 * of a sender that is actually an identity — two people can share a display
 * name, and one person can change theirs between emails.
 */
function Sender({ ticket }: { ticket: TicketSummary }) {
  if (!ticket.studentName) {
    return <span className="text-muted-foreground">{ticket.studentEmail}</span>;
  }

  return (
    <div>
      <div>{ticket.studentName}</div>
      <div className="text-muted-foreground">{ticket.studentEmail}</div>
    </div>
  );
}

function TicketsTableHead() {
  return (
    <thead>
      <tr className="border-b text-left text-muted-foreground">
        <th scope="col" className="py-2 pr-4 font-medium">
          Subject
        </th>
        <th scope="col" className="py-2 pr-4 font-medium">
          Sender
        </th>
        <th scope="col" className="py-2 pr-4 font-medium">
          Status
        </th>
        <th scope="col" className="py-2 pr-4 font-medium">
          Category
        </th>
        <th scope="col" className="py-2 font-medium">
          Created
        </th>
      </tr>
    </thead>
  );
}

/**
 * Placeholder rows shaped like the real table so the header and column widths
 * do not shift when the first page arrives — the same bargain UsersPage makes,
 * and the reason both skeletons render the real `<thead>`.
 */
function TicketsTableSkeleton() {
  return (
    <div className="overflow-x-auto" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading tickets…</span>
      <table className="w-full text-sm">
        <TicketsTableHead />
        <tbody className="divide-y">
          {Array.from({ length: 5 }, (_, i) => (
            <tr key={i}>
              <td className="py-3 pr-4">
                <Skeleton className="h-4 w-56" />
              </td>
              <td className="py-3 pr-4">
                <Skeleton className="h-4 w-40" />
              </td>
              <td className="py-3 pr-4">
                <Skeleton className="h-5 w-16 rounded-full" />
              </td>
              <td className="py-3 pr-4">
                <Skeleton className="h-5 w-28 rounded-full" />
              </td>
              <td className="py-3">
                <Skeleton className="h-4 w-20" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
