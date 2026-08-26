import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  createTicketReplyBodySchema,
  TICKET_REPLY_MAX_LENGTH,
  type CreateTicketReplyBody,
  type ListTicketRepliesResponse,
  type TicketReply,
} from "@helpdesk/shared";
import { createTicketReply, listTicketReplies } from "../lib/api.ts";
import { useSession } from "../lib/auth-client.ts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";

/**
 * The React Query key for one ticket's thread.
 *
 * Nested under the ticket's own key rather than a sibling `["replies", id]`,
 * so an invalidate of `["ticket", id]` would take the thread with it — the
 * relationship is real (a thread belongs to exactly one ticket) and spelling it
 * in the key is what keeps a future cache-wide sweep from missing half of it.
 * Nothing invalidates that prefix today; the sidebar writes the exact ticket
 * key, deliberately, so changing a status does not refetch the conversation.
 */
const repliesKey = (ticketId: string) => ["ticket", ticketId, "replies"];

/** Same full timestamp the page's header lines use. */
const formatMoment = (iso: string) => new Date(iso).toLocaleString();

/**
 * A ticket's conversation: what the support team has said back, and the box to
 * say something else.
 *
 * It sits under the email rather than beside it because it continues the
 * article — the email is the first thing in the thread, and the replies are the
 * rest of it. Putting the form at the bottom, after the last reply, is the same
 * decision: you write a reply having read the ones before it.
 *
 * A separate query from the ticket, which is what keeps the two independent:
 * posting a reply does not refetch the ticket, and changing a status in the
 * sidebar does not refetch the thread.
 */
export function TicketThread({ ticketId }: { ticketId: string }) {
  const { data, isPending, isError, error } = useQuery({
    queryKey: repliesKey(ticketId),
    queryFn: () => listTicketReplies(ticketId),
  });

  const replies = data?.data ?? [];

  return (
    <section className="space-y-4" aria-labelledby="thread-heading">
      <h3 id="thread-heading" className="text-lg font-semibold tracking-tight">
        Replies
      </h3>

      {isPending && <ThreadSkeleton />}

      {/*
        The thread failing is not the ticket failing — the email above it is on
        screen and still readable — so this is an inline alert rather than the
        page-level one, and the form below stays mounted: a reply can be written
        and sent even when the history could not be listed.
      */}
      {isError && (
        <Alert variant="destructive">
          <AlertTitle>Could not load the replies</AlertTitle>
          <AlertDescription>{(error as Error).message}</AlertDescription>
        </Alert>
      )}

      {data && replies.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No replies yet. Yours will be the first.
        </p>
      )}

      {replies.map((reply) => (
        <ReplyCard key={reply.id} reply={reply} />
      ))}

      <ReplyForm ticketId={ticketId} />
    </section>
  );
}

/**
 * One reply.
 *
 * Deliberately the same `Card` the email above it is in, rather than a chat
 * bubble alternating sides: every reply here has a staff author, so there are
 * no two sides to alternate between. When a student's reply can arrive — which
 * needs an inbound thread this repo does not have yet — that is the moment the
 * shape should change, and it should change for a reason the reader can see.
 */
function ReplyCard({ reply }: { reply: TicketReply }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span>{reply.author.name}</span>
          <span className="text-sm font-normal text-muted-foreground">
            {formatMoment(reply.createdAt)}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {/*
          `whitespace-pre-wrap` for the reason the email body has it: this is
          plain text, and its line breaks are the only structure it has.
        */}
        <div className="whitespace-pre-wrap break-words">{reply.body}</div>
      </CardContent>
    </Card>
  );
}

/**
 * The reply box.
 *
 * `react-hook-form` against the same schema the API parses the body with, like
 * the user dialogs, so "too long" and "write something first" are rejected with
 * the same message on both sides of the request rather than by two rules that
 * drift.
 */
function ReplyForm({ ticketId }: { ticketId: string }) {
  const queryClient = useQueryClient();
  const { data: session } = useSession();

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<CreateTicketReplyBody>({
    resolver: zodResolver(createTicketReplyBodySchema),
    defaultValues: { body: "" },
  });

  const { mutateAsync } = useMutation({
    mutationFn: (values: CreateTicketReplyBody) =>
      createTicketReply(ticketId, values),
    onSuccess: (created) => {
      // Appended rather than invalidated, which is the opposite of what the
      // sidebar does with the queue and for a reason worth stating: the
      // response *is* the new row, in the shape the list holds, and it goes at
      // the end because the thread is ordered oldest-first and this reply was
      // written last. An invalidate would round-trip for something already in
      // hand and blank the conversation while it did.
      //
      // The cost is a colleague's reply written in the meantime, which this
      // does not pull in. The thread refetches on the next mount, so the gap
      // closes when the reader returns — the same staleness the ticket itself
      // carries, rather than a new kind.
      queryClient.setQueryData<ListTicketRepliesResponse>(
        repliesKey(ticketId),
        (previous) =>
          previous
            ? { data: [...previous.data, created] }
            : // No cached thread means the list request failed or has not
              // landed; the reply still exists, so seed the entry with it
              // rather than dropping what was just written on the floor.
              { data: [created] },
      );
    },
  });

  const onSubmit = async (values: CreateTicketReplyBody) => {
    try {
      await mutateAsync(values);
    } catch (error) {
      // Attached to the form rather than the field: nothing about what was
      // typed is wrong — the request failed — and the text stays in the box so
      // a retry does not mean typing it again.
      setError("root", {
        message:
          error instanceof Error
            ? error.message
            : "Could not send the reply. Please try again.",
      });
      return;
    }

    // Only after the write landed, so a failed send never clears the box.
    reset();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {/*
            Whose reply this will be, from the session rather than a picker: the
            API signs it with the account that is signed in, and a form that
            implied otherwise would be offering a choice the server ignores.
          */}
          Reply{session?.user.name ? ` as ${session.user.name}` : ""}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form
          // noValidate hands validation to Zod, so the message under the box is
          // the app's rather than the browser's bubble.
          noValidate
          onSubmit={(event) => void handleSubmit(onSubmit)(event)}
          className="space-y-3"
        >
          <Field>
            <FieldLabel htmlFor="reply-body">Your reply</FieldLabel>
            <Textarea
              id="reply-body"
              rows={5}
              maxLength={TICKET_REPLY_MAX_LENGTH}
              placeholder="Write your reply to the student…"
              aria-invalid={errors.body ? true : undefined}
              aria-describedby={errors.body ? "reply-body-error" : undefined}
              disabled={isSubmitting}
              {...register("body")}
            />
            <FieldError id="reply-body-error" errors={[errors.body]} />
          </Field>

          {/*
            Said plainly rather than left for someone to discover: there is no
            email provider in this repo, so a reply is recorded and not
            delivered. An agent who believes they have written to a student when
            they have not is the expensive version of this gap.
          */}
          <p className="text-sm text-muted-foreground">
            Replies are recorded on the ticket. Nothing is emailed to the
            student yet.
          </p>

          {errors.root && (
            <p role="alert" className="text-sm text-destructive">
              {errors.root.message}
            </p>
          )}

          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Sending…" : "Send reply"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/** Two reply-shaped cards, so the form does not jump up the page and back. */
function ThreadSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading replies…</span>
      {[0, 1].map((key) => (
        <Card key={key}>
          <CardHeader>
            <Skeleton className="h-5 w-48" />
          </CardHeader>
          <CardContent className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
