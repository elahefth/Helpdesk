import { useQuery } from "@tanstack/react-query";
import { CATEGORY_LABELS, TICKET_STATUSES } from "@helpdesk/shared";
import { useState } from "react";
import { listTickets } from "../lib/api.ts";
import type { TicketStatus } from "@helpdesk/shared";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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

/** Base UI's Select renders labels from `items` rather than the raw value. */
const STATUS_ITEMS = [
  { label: "All", value: "all" },
  ...TICKET_STATUSES.map((value) => ({ label: value, value })),
];

/**
 * Phase 0 skeleton. It exercises the real request path — shared Zod schemas,
 * TanStack Query, the API's filter validation — against an endpoint that
 * currently returns an empty page. Phase 7 replaces the list body with a
 * TanStack Table and adds the remaining filters.
 */
export function TicketListPage() {
  const [status, setStatus] = useState<TicketStatus | "all">("all");

  const { data, isPending, isError, error } = useQuery({
    queryKey: ["tickets", { status }],
    queryFn: () => listTickets(status === "all" ? {} : { status }),
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
              Seed the corpus (plan phase 3) or run the ingestion pipeline
              (phase 5) to populate the queue.
            </p>
          </CardContent>
        </Card>
      )}

      {data && data.data.length > 0 && (
        <ul className="divide-y">
          {data.data.map((ticket) => (
            <li key={ticket.id} className="py-3">
              <p className="font-medium">{ticket.subject}</p>
              <p className="text-sm text-muted-foreground">
                {ticket.studentEmail} · {ticket.status} ·{" "}
                {ticket.category
                  ? CATEGORY_LABELS[ticket.category]
                  : "unclassified"}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
