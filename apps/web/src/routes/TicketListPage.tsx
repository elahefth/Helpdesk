import { useQuery } from "@tanstack/react-query";
import { CATEGORY_LABELS, TICKET_STATUSES } from "@helpdesk/shared";
import { useState } from "react";
import { listTickets } from "../lib/api.ts";
import type { TicketStatus } from "@helpdesk/shared";

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
        <label
          htmlFor="status"
          className="text-sm text-neutral-500 dark:text-neutral-400"
        >
          Status
        </label>
        <select
          id="status"
          value={status}
          onChange={(event) =>
            setStatus(event.target.value as TicketStatus | "all")
          }
          className="rounded-md border border-neutral-300 bg-transparent px-2.5 py-1.5 text-sm dark:border-neutral-700"
        >
          <option value="all">All</option>
          {TICKET_STATUSES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </div>

      {isPending && (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Loading tickets…
        </p>
      )}

      {isError && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          Could not load tickets: {(error as Error).message}
        </div>
      )}

      {data && data.data.length === 0 && (
        <div className="rounded-lg border border-dashed border-neutral-300 p-10 text-center dark:border-neutral-700">
          <p className="font-medium">No tickets yet</p>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            Seed the corpus (plan phase 3) or run the ingestion pipeline
            (phase 5) to populate the queue.
          </p>
        </div>
      )}

      {data && data.data.length > 0 && (
        <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
          {data.data.map((ticket) => (
            <li key={ticket.id} className="py-3">
              <p className="font-medium">{ticket.subject}</p>
              <p className="text-sm text-neutral-500 dark:text-neutral-400">
                {ticket.studentEmail} · {ticket.status} ·{" "}
                {ticket.category ? CATEGORY_LABELS[ticket.category] : "unclassified"}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
