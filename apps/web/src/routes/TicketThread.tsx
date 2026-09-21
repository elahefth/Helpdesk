import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  createTicketReplyBodySchema,
  TICKET_REPLY_MAX_LENGTH,
  type CreateTicketReplyBody,
  type ListTicketRepliesResponse,
  type TicketReply,
} from "@helpdesk/shared";
import { Sparkles } from "lucide-react";
import {
  createTicketReply,
  listTicketReplies,
  polishTicketReply,
} from "../lib/api.ts";
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
    getValues,
    setValue,
    setError,
    clearErrors,
    control,
    formState: { errors, isSubmitting },
  } = useForm<CreateTicketReplyBody>({
    resolver: zodResolver(createTicketReplyBodySchema),
    defaultValues: { body: "" },
  });

  /**
   * The polisher: the draft in the box goes to a language model and the tidier
   * version it returns replaces it.
   *
   * A mutation with no cache writes at all, unlike the send below — nothing was
   * created, so there is nothing to file. Its `error` is rendered on its own
   * rather than pushed into the form's `root`, which keeps a failed polish from
   * looking like a failed send and keeps either one from clearing the other's
   * message.
   */
  const polish = useMutation({
    mutationFn: (body: string) => polishTicketReply(ticketId, { body }),
    onSuccess: ({ body }) => {
      // `shouldDirty` so the box reads as edited, and `shouldValidate` because
      // the rewrite is new text against the same rules — a model that answered
      // with something unsendable should say so here rather than at the send.
      setValue("body", body, { shouldDirty: true, shouldValidate: true });
    },
  });

  /**
   * Polishing is a rewrite of what is in the box, so it needs something in the
   * box. Checked here rather than by letting the API answer 400, because the
   * round trip would tell the agent something they can be told immediately —
   * and the message is the field's own, in the place they are already looking.
   */
  const onPolish = () => {
    const draft = getValues("body").trim();

    if (!draft) {
      setError("body", { message: "Write a draft before polishing it." });
      return;
    }

    clearErrors("body");
    polish.mutate(draft);
  };

  // One flag for both buttons: a send while a rewrite is in flight would race
  // the `setValue` above and could publish the draft the agent asked to have
  // replaced.
  const busy = isSubmitting || polish.isPending;

  /**
   * Whether there is anything to send.
   *
   * Not `formState.isValid`, which would need `mode: "onChange"` and would move
   * *every* message on this form from the submit to the keystroke — a much
   * larger change than disabling one button, and one that scolds an agent
   * halfway through their first word.
   *
   * `useWatch` rather than the `watch` beside it in the same API, and the
   * difference is invisible until you run the linter: `watch` subscribes in a
   * way the React Compiler cannot follow, so it answers
   * `react-hooks/incompatible-library` and skips compiling **the whole
   * component** — a warning rather than an error, which is exactly how it would
   * have stayed. `useWatch` is a hook and subscribes through the `control`, so
   * the compiler keeps the component.
   *
   * Trimmed, because the schema trims: untrimmed, a box holding two spaces
   * offers a Send that the resolver then refuses, which is the round trip the
   * disabled state exists to avoid. The `?? ""` is for the type — the field has
   * a default and is never actually undefined.
   */
  const empty = (useWatch({ control, name: "body" }) ?? "").trim().length === 0;

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
              // Disabled while a rewrite is in flight as well as while sending:
              // whatever is typed in the meantime is about to be overwritten by
              // the response, and losing a sentence that way is invisible.
              disabled={busy}
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
            student yet.{" "}
            {/*
              Said here rather than in a tooltip on the button: a rewrite
              replaces what an agent wrote, and "read it before you send it" is
              the one thing they need to know before pressing it, not after.
            */}
            Polish rewrites your draft with AI — read it over before sending.
          </p>

          {errors.root && (
            <p role="alert" className="text-sm text-destructive">
              {errors.root.message}
            </p>
          )}

          {/*
            The polisher's own failures, separate from the send's. Both a
            missing model (503) and a model that failed (502) arrive as an
            `ApiRequestError` whose message the API writes to be shown as-is,
            so there is nothing to translate here — and the draft is untouched
            either way, which is what makes this a note rather than a blocker.
          */}
          {polish.isError && (
            <p role="alert" className="text-sm text-destructive">
              {polish.error instanceof Error
                ? polish.error.message
                : "Could not polish the draft. Please try again."}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {/*
              Before the send, and deliberately so: it is a step on the way to
              sending, and putting it after would read as something you do to a
              reply already gone. `type="button"` because it is inside the form
              and the default would submit it — sending the unpolished draft
              with one click on the button meant to improve it.
            */}
            <Button
              type="button"
              variant="outline"
              onClick={onPolish}
              disabled={busy}
            >
              <Sparkles aria-hidden="true" />
              {polish.isPending ? "Polishing…" : "Polish"}
            </Button>

            {/*
              Disabled on an empty box rather than answered with "write a reply
              first" after the click. The message was never news — the box is
              directly above it and its placeholder says what goes in — so the
              press only existed to be refused. `reset()` on a successful send
              empties the box, so the button goes back to disabled by itself.
            */}
            <Button type="submit" disabled={busy || empty}>
              {isSubmitting ? "Sending…" : "Send reply"}
            </Button>
          </div>
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
