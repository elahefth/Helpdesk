import { useMutation } from "@tanstack/react-query";
import { ScrollText } from "lucide-react";
import { summarizeTicket } from "../lib/api.ts";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/** The same clock the page's other lines use. */
const formatMoment = (ms: number) => new Date(ms).toLocaleString();

/**
 * What this ticket amounts to, on request.
 *
 * It sits directly under the student's email and above the thread, which is
 * where it is useful: the reader arriving at a long ticket meets the summary
 * before the wall of text it summarises, and the material it was made from is
 * still right there to check it against.
 *
 * **A mutation, not a query, and that is the whole design.** Nothing is cached
 * and nothing is stored — each press asks the model again, about the ticket as
 * it stands at that moment. A query would do the opposite of what is wanted
 * here: it would fire on mount (a model call for every ticket anyone opens,
 * paid for whether or not they wanted a summary), then keep the answer and
 * serve it back while the thread grew underneath it. A summary of a
 * conversation goes out of date every time anyone replies, and a stale one is
 * worse than none: it is wrong in the way nobody checks, because the reader is
 * looking at it precisely to avoid reading the thread.
 *
 * So the pressed button is the only thing that produces one, and pressing it
 * again replaces what is there. The timestamp is the other half of that
 * contract — it is what lets a reader tell a summary written before the last
 * two replies from one written after.
 */
export function TicketSummaryCard({ ticketId }: { ticketId: string }) {
  const { mutate, data, isPending, isError, error, submittedAt } = useMutation({
    mutationFn: () => summarizeTicket(ticketId),
  });

  // No cache writes at all, unlike every other mutation in the SPA: this one
  // changed nothing on the server, so there is nothing to file or invalidate.

  const summary = data?.summary;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Summary</CardTitle>
        <CardDescription>
          {summary
            ? // The moment the request went out, which is the instant that
              // answers the question a reader actually has: does this include
              // the reply I just posted?
              `Written by AI at ${formatMoment(submittedAt)} — check it against the ticket.`
            : "Have AI read this ticket and its replies, and say where it stands."}
        </CardDescription>
        <CardAction>
          {/*
            The label changes once there is a summary, because the second press
            does something different from the first: it throws away what is on
            screen and asks again. An agent who has just replied and wants the
            summary to know about it is the ordinary reason to press it twice.
          */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => mutate()}
            disabled={isPending}
          >
            <ScrollText aria-hidden="true" />
            {isPending ? "Summarizing…" : summary ? "Regenerate" : "Summarize"}
          </Button>
        </CardAction>
      </CardHeader>

      {/*
        The card is a header alone until there is something to put in it, so an
        untouched ticket does not carry an empty panel down the page.
      */}
      {(isPending || isError || summary) && (
        <CardContent>
          {isPending && <SummarySkeleton />}

          {/*
            Both a missing model (503) and a failed one (502) arrive as an
            `ApiRequestError` whose message the API writes to be shown as-is,
            so there is nothing to translate. Rendered in place of the summary
            rather than over the page: nothing else on the ticket is affected,
            and the previous summary is gone because it described a state this
            attempt cannot confirm is still current.
          */}
          {isError && !isPending && (
            <p role="alert" className="text-sm text-destructive">
              {error instanceof Error
                ? error.message
                : "Could not summarize this ticket. Please try again."}
            </p>
          )}

          {/*
            `whitespace-pre-wrap` for the reason the email and the replies have
            it: the model answers in plain text, and its line breaks and
            bullets are the only structure it has.
          */}
          {!isPending && !isError && summary && (
            <div className="whitespace-pre-wrap break-words">{summary}</div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

/** Three lines' worth, so the thread below does not jump when the answer lands. */
function SummarySkeleton() {
  return (
    <div className="space-y-2" aria-busy="true" aria-live="polite">
      <span className="sr-only">Summarizing this ticket…</span>
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}
