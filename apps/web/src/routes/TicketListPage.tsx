import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CATEGORY_LABELS,
  TICKET_CATEGORIES,
  TICKET_STATUSES,
  type TicketCategory,
  type TicketStatus,
} from "@helpdesk/shared";
import { getTicket, listTickets } from "../lib/api.ts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
  { label: "All statuses", value: "all" },
  ...TICKET_STATUSES.map((value) => ({ label: value, value })),
];

const CATEGORY_ITEMS = [
  { label: "All categories", value: "all" },
  ...TICKET_CATEGORIES.map((value) => ({
    label: CATEGORY_LABELS[value],
    value,
  })),
];

const formatReceived = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

/**
 * The email body, fetched only when a row is opened.
 *
 * A second request rather than a field on the list row: the list is a page of
 * subject lines, and shipping every full email to render them would grow the
 * response by the size of the inbox. The query key is per-ticket, so reopening
 * a row it has already fetched is instant and silent.
 */
function TicketBody({ id }: { id: string }) {
  const { data, isPending, isError, error } = useQuery({
    queryKey: ["ticket", id],
    queryFn: () => getTicket(id),
  });

  if (isPending) {
    return (
      <div className="space-y-2" aria-busy="true">
        <span className="sr-only">Loading message…</span>
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-4/5" />
      </div>
    );
  }

  if (isError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load the message</AlertTitle>
        <AlertDescription>{(error as Error).message}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">
        To {data.supportEmail} · received {formatReceived(data.receivedAt)}
      </p>
      {/* whitespace-pre-wrap, because this is the email as it was sent: the
          student's paragraph breaks are the only structure a plain-text body
          has, and collapsing them turns a readable message into a wall. */}
      <p className="whitespace-pre-wrap text-sm">{data.body}</p>
    </div>
  );
}

/**
 * The support queue: one row per email that arrived at the support address.
 *
 * Filters are server-side — the values go into the query string that
 * `listTicketsQuerySchema` parses — rather than a filter over a fetched page,
 * which would only ever narrow the 25 rows already on screen.
 */
export function TicketListPage() {
  const [status, setStatus] = useState<TicketStatus | "all">("all");
  const [category, setCategory] = useState<TicketCategory | "all">("all");
  const [openId, setOpenId] = useState<string | null>(null);

  const { data, isPending, isError, error } = useQuery({
    queryKey: ["tickets", { status, category }],
    queryFn: () =>
      listTickets({
        ...(status === "all" ? {} : { status }),
        ...(category === "all" ? {} : { category }),
      }),
  });

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor="status" className="text-muted-foreground">
          Status
        </Label>
        <Select
          items={STATUS_ITEMS}
          value={status}
          onValueChange={(value) => setStatus(value as TicketStatus | "all")}
        >
          <SelectTrigger id="status" className="min-w-36">
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
          <SelectTrigger id="category" className="min-w-48">
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

      {isPending && (
        <p className="text-sm text-muted-foreground">Loading tickets…</p>
      )}

      {isError && (
        <Alert variant="destructive">
          <AlertTitle>Could not load tickets</AlertTitle>
          <AlertDescription>{(error as Error).message}</AlertDescription>
        </Alert>
      )}

      {data && data.data.length === 0 && (
        <Card className="border-dashed">
          <CardContent className="py-10 text-center">
            <p className="font-medium">No tickets yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Tickets appear here when email arrives at the support address.
              Deliver one with <code>bun run email:send</code>.
            </p>
          </CardContent>
        </Card>
      )}

      {data && data.data.length > 0 && (
        <ul className="divide-y">
          {data.data.map((ticket) => {
            const isOpen = openId === ticket.id;
            return (
              <li key={ticket.id} className="py-3">
                {/* A button rather than a link: there is no ticket route yet,
                    and a link to nowhere is worse than a disclosure. */}
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => setOpenId(isOpen ? null : ticket.id)}
                  className="w-full rounded-sm text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <p className="font-medium">{ticket.subject}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                    <span>{ticket.studentEmail}</span>
                    <Badge variant="secondary">{ticket.status}</Badge>
                    <Badge variant="outline">
                      {ticket.category
                        ? CATEGORY_LABELS[ticket.category]
                        : "unclassified"}
                    </Badge>
                    <span>{formatReceived(ticket.receivedAt)}</span>
                  </p>
                </button>

                {isOpen && (
                  <div className="mt-3 border-l-2 pl-4">
                    <TicketBody id={ticket.id} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
