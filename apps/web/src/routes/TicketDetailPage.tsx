import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { CATEGORY_LABELS, type TicketDetail } from "@helpdesk/shared";
import { ArrowLeft } from "lucide-react";
import { ApiRequestError, getTicket } from "../lib/api.ts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Full timestamp, unlike the list's date-only `formatCreated`.
 *
 * The queue is scanned, so a date is all a row can carry without crowding the
 * columns; a detail page is read, and "when exactly did this arrive" is one of
 * the few questions it exists to answer.
 */
const formatMoment = (iso: string) => new Date(iso).toLocaleString();

/**
 * One ticket.
 *
 * Reached from the queue by clicking a subject, and by URL — the id is in the
 * path rather than in component state precisely so the page is linkable: an
 * agent pasting a ticket link into chat is the normal way work gets handed
 * over, and that only works if the address names the ticket.
 */
export function TicketDetailPage() {
  // Typed as possibly-undefined by React Router, because a param is only
  // guaranteed by the route that declares it. The query is disabled rather
  // than the value asserted, so a future route that mounts this without an id
  // renders "not found" instead of fetching /api/tickets/undefined.
  const { id } = useParams<{ id: string }>();

  const { data, isPending, isError, error } = useQuery({
    queryKey: ["ticket", id],
    queryFn: () => getTicket(id ?? ""),
    enabled: Boolean(id),
    // A 404 is the API's final answer about this id — retrying re-asks a
    // question that has been answered. Anything else may be transient and
    // keeps the client's default retry.
    retry: (failureCount, err) =>
      err instanceof ApiRequestError && err.status === 404
        ? false
        : failureCount < 1,
  });

  const notFound =
    !id || (error instanceof ApiRequestError && error.status === 404);

  return (
    <section className="space-y-6">
      <BackToQueue />

      {id && isPending && <TicketDetailSkeleton />}

      {isError && notFound && (
        <Alert>
          <AlertTitle>No such ticket</AlertTitle>
          <AlertDescription>
            It may have been removed, or the link may be wrong.
          </AlertDescription>
        </Alert>
      )}

      {isError && !notFound && (
        <Alert variant="destructive">
          <AlertTitle>Could not load this ticket</AlertTitle>
          <AlertDescription>{(error as Error).message}</AlertDescription>
        </Alert>
      )}

      {!id && (
        <Alert>
          <AlertTitle>No such ticket</AlertTitle>
          <AlertDescription>This address names no ticket.</AlertDescription>
        </Alert>
      )}

      {data && <TicketView ticket={data} />}
    </section>
  );
}

/**
 * Rendered above the outcome rather than inside it, so the way back is there
 * while the page is loading and while it is an error — the two states a reader
 * is most likely to want to leave from.
 */
function BackToQueue() {
  return (
    <Link
      to="/"
      className="inline-flex items-center gap-1.5 rounded-sm text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ArrowLeft aria-hidden="true" className="size-4" />
      Back to tickets
    </Link>
  );
}

function TicketView({ ticket }: { ticket: TicketDetail }) {
  return (
    <article className="space-y-6">
      <header className="space-y-3">
        {/*
          The subject is the page's heading, and the `h2` continues the layout's
          `h1` wordmark — the same level TicketListPage's "Tickets" uses, so the
          document outline does not gain a level by navigating.
        */}
        <h2 className="text-2xl font-semibold tracking-tight">
          {ticket.subject}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={ticket.status === "open" ? "default" : "secondary"}>
            {ticket.status}
          </Badge>
          {/*
            The same stated absence the queue renders, and for the same reason:
            nothing classifies, so an empty space would read as a missing value
            rather than as the answer.
          */}
          {ticket.category ? (
            <Badge variant="outline">{CATEGORY_LABELS[ticket.category]}</Badge>
          ) : (
            <span className="text-sm text-muted-foreground">unclassified</span>
          )}
        </div>
      </header>

      <Card>
        <CardContent className="space-y-4">
          <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
            <Field label="From">
              {/* studentName is null for mail that carried a bare address, so
                  the email is the fallback here exactly as it is in the queue's
                  Sender cell. */}
              {ticket.studentName ? (
                <>
                  <span>{ticket.studentName}</span>{" "}
                  <span className="text-muted-foreground">
                    &lt;{ticket.studentEmail}&gt;
                  </span>
                </>
              ) : (
                ticket.studentEmail
              )}
            </Field>
            <Field label="To">{ticket.supportEmail}</Field>
            {/*
              Received, not created: they differ by design — replaying an
              archive must not make every ticket look like it arrived today —
              and the one a reader working the queue cares about is when the
              student sent it.
            */}
            <Field label="Received">{formatMoment(ticket.receivedAt)}</Field>
            <Field label="Last updated">{formatMoment(ticket.updatedAt)}</Field>
          </dl>

          <Separator />

          {/*
            `whitespace-pre-wrap` because the body is the plain-text email, and
            its line breaks are the only structure it has — collapsed, a
            paragraph-and-a-signature becomes one run-on block. `break-words`
            keeps a pasted URL from widening the card past the viewport.
          */}
          <div className="whitespace-pre-wrap break-words text-sm">
            {ticket.body}
          </div>
        </CardContent>
      </Card>
    </article>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

/**
 * Shaped like the real page — heading, badge row, field grid, body — so the
 * layout does not jump when the ticket arrives.
 */
function TicketDetailSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading ticket…</span>
      <div className="space-y-3">
        <Skeleton className="h-8 w-96 max-w-full" />
        <Skeleton className="h-5 w-24" />
      </div>
      <Card>
        <CardContent className="space-y-4">
          <div className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="space-y-1.5">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-4 w-48 max-w-full" />
              </div>
            ))}
          </div>
          <Separator />
          <div className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
