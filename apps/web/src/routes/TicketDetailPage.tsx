import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useParams } from "react-router";
import {
  canTransition,
  CATEGORY_LABELS,
  TICKET_CATEGORIES,
  TICKET_STATUS_LABELS,
  TICKET_STATUS_TRANSITIONS,
  TICKET_STATUSES,
  type TicketDetail,
  type UpdateTicketBody,
  type User,
} from "@helpdesk/shared";
import { ArrowLeft } from "lucide-react";
import {
  ApiRequestError,
  getTicket,
  listAssignees,
  updateTicket,
} from "../lib/api.ts";
import { useSession } from "../lib/auth-client.ts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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

/**
 * Full timestamp, unlike the list's date-only `formatCreated`.
 *
 * The queue is scanned, so a date is all a row can carry without crowding the
 * columns; a detail page is read, and "when exactly" is one of the few
 * questions it exists to answer.
 */
const formatMoment = (iso: string) => new Date(iso).toLocaleString();

/** The two selects' stand-in for null — a Base UI Select value must be a string. */
const NONE = "none";

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
  const location = useLocation();

  // The queue's own address, handed over by the link that opened this ticket.
  // Its filters, sort and page are all in that query string, so returning to it
  // returns to the row the reader clicked rather than to page 1 of everything.
  // A ticket reached by a pasted link or a reload carries no state and falls
  // back to the bare queue — and the shape is checked rather than trusted,
  // because history state survives a reload and is not ours to assume about.
  const from = (location.state as { from?: unknown } | null)?.from;
  const to = typeof from === "string" && from.startsWith("/") ? from : "/";

  return (
    <Link
      to={to}
      className="inline-flex items-center gap-1.5 rounded-sm text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ArrowLeft aria-hidden="true" className="size-4" />
      Back to tickets
    </Link>
  );
}

/** The From header as one line, falling back to the address as everything does. */
function sender(ticket: TicketDetail): string {
  return ticket.studentName
    ? `${ticket.studentName} (${ticket.studentEmail})`
    : ticket.studentEmail;
}

/**
 * The page proper: the email on the left, what can be changed about it on the
 * right.
 *
 * The split is the layout doing a job rather than filling space. Everything in
 * the left column is a fact about a message that has already been sent and
 * cannot be edited; everything in the right column is a decision someone on the
 * support team makes. Mixing them is how a reader ends up unsure which parts of
 * a page they are allowed to touch.
 *
 * The sidebar drops under the article below `lg`, where two columns would leave
 * the body a ribbon.
 */
function TicketView({ ticket }: { ticket: TicketDetail }) {
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <article className="space-y-6">
        <header className="space-y-1">
          {/*
            The subject is the page's heading, and `h2` continues the layout's
            `h1` wordmark — the same level TicketListPage's "Tickets" uses, so
            the document outline does not gain a level by navigating.
          */}
          <h2 className="text-2xl font-semibold tracking-tight">
            {ticket.subject}
          </h2>
          <p className="text-muted-foreground">From: {sender(ticket)}</p>
          <p className="text-muted-foreground">
            Created: {formatMoment(ticket.createdAt)}
          </p>
          {/*
            Updated, and it moves: every change made in the sidebar restamps it,
            so this line is the page's own record that the save landed.
          */}
          <p className="text-muted-foreground">
            Updated: {formatMoment(ticket.updatedAt)}
          </p>
        </header>

        <Card>
          <CardHeader>
            <CardTitle>Message</CardTitle>
            <CardDescription>
              From {ticket.studentName ?? ticket.studentEmail}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {/*
              `whitespace-pre-wrap` because this is the plain-text email, and its
              line breaks are the only structure it has — collapsed, a paragraph
              and a signature become one run-on block. `break-words` keeps a
              pasted URL from widening the card past the viewport.
            */}
            <div className="whitespace-pre-wrap break-words">{ticket.body}</div>
          </CardContent>
        </Card>
      </article>

      <TicketControls ticket={ticket} />
    </div>
  );
}

/**
 * Everything about this ticket that a human decides: its status, its category,
 * and who owns it.
 *
 * One mutation behind all three, not three. They write the same row through the
 * same route, and a single in-flight flag is what keeps two of them from being
 * changed at once — two PATCHes racing would be resolved by order of *arrival*,
 * and the loser's field would be silently reverted by the winner's response.
 *
 * None of this is a permission boundary. The API is: `PATCH /api/tickets/:id`
 * is open to any signed-in staff by the same deliberate choice, and it re-checks
 * the status move regardless of what this sidebar offered.
 */
function TicketControls({ ticket }: { ticket: TicketDetail }) {
  const queryClient = useQueryClient();
  const { data: session } = useSession();

  const { data: assignees, isPending: isLoadingAssignees } = useQuery({
    queryKey: ["assignees"],
    queryFn: listAssignees,
    // The staff list changes when an admin adds or removes someone, which is
    // rare next to how often a ticket is opened. Five minutes keeps every visit
    // to every ticket from re-fetching it.
    staleTime: 5 * 60_000,
  });

  const { mutate, isPending, isError, error } = useMutation({
    mutationFn: (body: UpdateTicketBody) => updateTicket(ticket.id, body),
    onSuccess: (updated) => {
      // The PATCH answers with the whole updated ticket, so *this* page's cache
      // is written rather than invalidated: an invalidate would re-fetch what
      // the response already carried, and show a loading page in between.
      queryClient.setQueryData(["ticket", ticket.id], updated);

      // The queue is a different cache entry and this row is in it, wearing the
      // status the reader just changed. Without this, going back shows the old
      // one — the pages walked are still cached, and `staleTime` keeps them for
      // half a minute.
      //
      // Invalidated rather than patched in place, and the difference is not
      // cosmetic: resolving a ticket while the status filter reads "open" takes
      // it out of the queue entirely, and changing the column the queue is
      // sorted by moves it to a different page. Only the server knows what
      // takes its place, and `total` — the page counter's divisor — moves with
      // it. The key is the prefix, so every filter and sort combination the
      // reader has visited goes stale together.
      //
      // Nothing refetches now: the queue is unmounted, so its queries are
      // inactive and are simply marked stale, then re-fetched when they next
      // render — which is the moment the reader arrives back on them.
      void queryClient.invalidateQueries({ queryKey: ["tickets"] });
    },
  });

  const staff = assignees?.data ?? [];

  /**
   * The assignee options, with the current one folded in when the staff list
   * does not carry them.
   *
   * That case is real rather than defensive: a soft-deleted account stays
   * assigned to its tickets — the user row survives a delete precisely so a
   * ticket can still name who handled it — but `GET /api/assignees` omits it,
   * because new work should not be handed to someone who has left. Base UI
   * renders the trigger's label out of `items`, so without the merge an owned
   * ticket would show an empty box and read as unassigned.
   */
  const assigneeItems = [
    { label: "Unassigned", value: NONE },
    ...staff.map((person) => ({
      label: assigneeLabel(person, session?.user.id),
      value: person.id,
    })),
    ...(ticket.assignee && !staff.some((p) => p.id === ticket.assignee?.id)
      ? [
          {
            label: assigneeLabel(ticket.assignee, session?.user.id),
            value: ticket.assignee.id,
          },
        ]
      : []),
  ];

  const statusItems = TICKET_STATUSES.map((status) => ({
    label: TICKET_STATUS_LABELS[status],
    value: status,
    // Disabled rather than absent: a reader who wonders why they cannot resolve
    // a closed ticket is answered by seeing the option greyed out, where a
    // vanished one just looks like a list that changes shape. The current
    // status stays selectable so the trigger has something to render.
    disabled: status !== ticket.status && !canTransition(ticket.status, status),
  }));

  const categoryItems = [
    { label: "None", value: NONE },
    ...TICKET_CATEGORIES.map((category) => ({
      label: CATEGORY_LABELS[category],
      value: category,
    })),
  ];

  // Read off the transition table rather than spelled `=== "closed"`: the fact
  // that closed is the terminal status is the domain's to state, and a literal
  // here would keep claiming it after someone gave closed a way out. A status
  // with no legal moves leaves every option but the current one disabled, and a
  // select where nothing can be picked is better spelled as a disabled control
  // with the reason beside it.
  const isTerminal = TICKET_STATUS_TRANSITIONS[ticket.status].length === 0;

  return (
    <aside className="space-y-4 lg:w-72">
      <Control label="Status" id="status">
        <TicketSelect
          id="status"
          items={statusItems}
          value={ticket.status}
          disabled={isPending || isTerminal}
          onChange={(value) =>
            mutate({ status: value as TicketDetail["status"] })
          }
        />
        {isTerminal && (
          <p className="text-sm text-muted-foreground">
            A {ticket.status} ticket cannot change status.
          </p>
        )}
      </Control>

      <Control label="Category" id="category">
        <TicketSelect
          id="category"
          items={categoryItems}
          value={ticket.category ?? NONE}
          disabled={isPending}
          onChange={(value) =>
            mutate({
              category:
                value === NONE
                  ? null
                  : (value as NonNullable<TicketDetail["category"]>),
            })
          }
        />
      </Control>

      <Control label="Assigned To" id="assignee">
        <TicketSelect
          id="assignee"
          items={assigneeItems}
          value={ticket.assignee?.id ?? NONE}
          // The staff list has to be loaded before a choice means anything.
          disabled={isPending || isLoadingAssignees}
          onChange={(value) =>
            mutate({ assigneeId: value === NONE ? null : value })
          }
        />
      </Control>

      {isPending && (
        <p className="text-sm text-muted-foreground" aria-live="polite">
          Saving…
        </p>
      )}

      {/*
        Inline rather than the page-level Alert: the ticket itself loaded fine,
        and what failed is one of these controls. `role="alert"` so it is
        announced — a select that silently snaps back to its previous value is
        indistinguishable from a misclick.
      */}
      {isError && !isPending && (
        <p role="alert" className="text-sm text-destructive">
          Could not save: {(error as Error).message}
        </p>
      )}
    </aside>
  );
}

/** A sidebar field: the label above its control, as in the mock. */
function Control({
  label,
  id,
  children,
}: {
  label: string;
  id: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

interface SelectItemSpec {
  label: string;
  value: string;
  disabled?: boolean;
}

/**
 * The three sidebar selects are the same control three times, so they are one
 * component — the alternative is three copies of the Base UI scaffolding, which
 * is where a trigger quietly stops matching its listbox.
 */
function TicketSelect({
  id,
  items,
  value,
  disabled,
  onChange,
}: {
  id: string;
  items: SelectItemSpec[];
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Select
      items={items}
      value={value}
      // Base UI types the value as nullable because a Select can be cleared;
      // none of these can be. "Unassigned" and "None" are items rather than
      // empty states, so taking a value off is a choice a reader makes rather
      // than a control they have to work out how to clear.
      onValueChange={(next: string | null) => {
        if (!next || next === value) return;
        onChange(next);
      }}
      disabled={disabled}
    >
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {items.map((item) => (
            <SelectItem
              key={item.value}
              value={item.value}
              disabled={item.disabled}
            >
              {item.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

/**
 * Marks your own row in the picker. "You" rather than your name because the
 * question a reader is answering is "is this mine", and matching a name against
 * their own is work the label can do for them.
 */
function assigneeLabel(staff: User, sessionUserId: string | undefined): string {
  return staff.id === sessionUserId ? `${staff.name} (you)` : staff.name;
}

/**
 * Shaped like the real page — heading, meta lines, message card, and the three
 * sidebar controls — so the layout does not jump when the ticket arrives.
 */
function TicketDetailSkeleton() {
  return (
    <div
      className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_18rem]"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Loading ticket…</span>
      <div className="space-y-6">
        <div className="space-y-2">
          <Skeleton className="h-8 w-96 max-w-full" />
          <Skeleton className="h-4 w-72 max-w-full" />
          <Skeleton className="h-4 w-56" />
          <Skeleton className="h-4 w-56" />
        </div>
        <Card>
          <CardHeader className="space-y-2">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-4 w-40" />
          </CardHeader>
          <CardContent className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </CardContent>
        </Card>
      </div>
      <div className="space-y-4 lg:w-72">
        {["Status", "Category", "Assigned To"].map((label) => (
          <div key={label} className="space-y-1.5">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-9 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
