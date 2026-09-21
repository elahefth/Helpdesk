import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  createColumnHelper,
  flexRender,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type ColumnDef,
  type ReactTable,
  type SortingState,
} from "@tanstack/react-table";
import {
  CATEGORY_LABELS,
  TICKET_CATEGORIES,
  TICKET_PAGE_SIZE,
  TICKET_STATUSES,
  ticketCategorySchema,
  ticketSortKeySchema,
  ticketStatusSchema,
  type TicketCategory,
  type TicketSortKey,
  type TicketStatus,
  type TicketSummary,
} from "@helpdesk/shared";
import { ArrowDown, ArrowUp, ChevronsUpDown, Search, X } from "lucide-react";
import { listTickets } from "../lib/api.ts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
 * Everything that decides which rows are on screen, as one object.
 *
 * It lives in the URL rather than in `useState`, because this component
 * unmounts every time a reader opens a ticket. State held in the component dies
 * with it, so coming back from a ticket landed on page 1 of an unfiltered queue
 * no matter where the reader had been standing. In the query string it survives
 * the round trip and a reload, it makes the browser's own Back button restore
 * the page rather than reset it, and a position in the queue becomes something
 * an agent can paste to a colleague.
 *
 * `createdAt` desc is newest-first, the only default a support queue can have:
 * the thing that arrived while you were reading the last one is the thing you
 * have not seen. It matches `listTicketsQuerySchema`'s own default, which is
 * why an untouched queue sends no sort params at all.
 */
type QueueState = {
  status: TicketStatus | "all";
  category: TicketCategory | "all";
  search: string;
  sortKey: TicketSortKey;
  sortOrder: "asc" | "desc";
  /** Zero-based here, one-based in the URL — `?page=1` is the first page. */
  pageIndex: number;
};

const DEFAULT_QUEUE: QueueState = {
  status: "all",
  category: "all",
  search: "",
  sortKey: "createdAt",
  sortOrder: "desc",
  pageIndex: 0,
};

/**
 * Reads the params through the shared schemas, and falls back rather than
 * throwing: a hand-edited or stale URL should show the queue, not an error
 * screen. Every request is then built from the *parsed* value, so a bogus
 * `?status=pending` can never reach the API.
 */
function readQueueState(params: URLSearchParams): QueueState {
  const page = Number(params.get("page"));

  return {
    status: ticketStatusSchema.safeParse(params.get("status")).data ?? "all",
    category:
      ticketCategorySchema.safeParse(params.get("category")).data ?? "all",
    search: params.get("q")?.trim() ?? "",
    sortKey:
      ticketSortKeySchema.safeParse(params.get("sort")).data ??
      DEFAULT_QUEUE.sortKey,
    sortOrder: params.get("order") === "asc" ? "asc" : "desc",
    pageIndex: Number.isInteger(page) && page > 1 ? page - 1 : 0,
  };
}

/**
 * The inverse, omitting anything still at its default — an untouched queue
 * stays at a plain "/", and the address only ever names what the reader changed.
 */
function writeQueueState(state: QueueState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.status !== "all") params.set("status", state.status);
  if (state.category !== "all") params.set("category", state.category);
  if (state.search) params.set("q", state.search);
  if (state.sortKey !== DEFAULT_QUEUE.sortKey)
    params.set("sort", state.sortKey);
  if (state.sortOrder !== DEFAULT_QUEUE.sortOrder) {
    params.set("order", state.sortOrder);
  }
  if (state.pageIndex > 0) params.set("page", String(state.pageIndex + 1));
  return params;
}

/**
 * TanStack Table v9 is opt-in per feature — nothing is in the bundle unless it
 * is named here. `rowSortingFeature` brings the sort *state* and the header
 * toggles; the deliberate omission is `sortedRowModel`.
 *
 * That omission, not `manualSorting` below, is what actually keeps the client
 * from re-sorting: with no sorted row model registered, `getRowModel()` is the
 * core model and there is nothing to re-order rows with. Adding
 * `createSortedRowModel()` here would start sorting the page in the browser on
 * top of the order Postgres already applied — which
 * `TicketListPage.test.tsx`'s "renders server order verbatim" case is there to
 * catch, because that is the one edit that breaks it.
 *
 * Declared at module scope, as the helper's own docs require: rebuilding it per
 * render would hand `useTable` a new feature set every time.
 */
const features = tableFeatures({ rowSortingFeature });

const columnHelper = createColumnHelper<typeof features, TicketSummary>();

/**
 * Column ids are `TicketSortKey`s, so a header click becomes a query parameter
 * with nothing in between to keep in sync.
 *
 * Every column is an accessor column, including the ones whose cell renders
 * from `row.original` and ignores the accessed value entirely. That is not
 * redundancy: v9 gates `column.getCanSort()` on `!!column.accessorFn`, so a
 * display column cannot be sorted at all — and here the accessor's *only* job
 * is to make the column sortable, because the sorting itself happens in
 * Postgres.
 *
 * The `: unknown` return annotations are load-bearing, and `unknown` rather
 * than `string` for a reason that is easy to fight for an hour. Left to
 * inference each column gets its own `TValue` — `subject` a string, `status` a
 * literal union — and the array becomes a union `useTable` cannot resolve to
 * one column type. `unknown` is the wildcard the table's own internals use, and
 * it has to be the annotation rather than just the array's type argument:
 * `cell` receives a `CellContext<…, TValue>`, and a function *parameter* is
 * contravariant, so a cell typed for `string` will not accept the
 * `Cell<…, unknown>` that `getAllCells()` hands back.
 *
 * Nothing is lost by it. Every cell renders from `row.original`, and the
 * comparison that would need a real value happens in Postgres.
 */
const columns: ColumnDef<typeof features, TicketSummary, unknown>[] = [
  columnHelper.accessor((row): unknown => row.subject, {
    id: "subject" satisfies TicketSortKey,
    header: "Subject",
    cell: ({ row }) => <SubjectCell ticket={row.original} />,
  }),
  columnHelper.accessor((row): unknown => row.studentName ?? row.studentEmail, {
    id: "sender" satisfies TicketSortKey,
    header: "Sender",
    cell: ({ row }) => <Sender ticket={row.original} />,
  }),
  columnHelper.accessor((row): unknown => row.status, {
    id: "status" satisfies TicketSortKey,
    header: "Status",
    cell: ({ row }) => (
      <Badge variant={row.original.status === "open" ? "default" : "secondary"}>
        {row.original.status}
      </Badge>
    ),
  }),
  columnHelper.accessor((row): unknown => row.category ?? "", {
    id: "category" satisfies TicketSortKey,
    header: "Category",
    cell: ({ row }) => {
      const { category, classification } = row.original;
      // The null still renders as a stated absence rather than an empty cell
      // that reads like a bug. The accessor above flattens it to "" because
      // that value is never rendered or compared here; Postgres decides where
      // the unclassified rows go.
      if (category) {
        return <Badge variant="outline">{CATEGORY_LABELS[category]}</Badge>;
      }
      // The other reason a category can be missing, and the one the reader
      // cannot otherwise tell from the permanent kind: classification runs
      // after ingestion answers, so a ticket that arrived seconds ago has no
      // category *yet*. Saying so is what stops a working classifier from
      // looking like an absent one — and it is temporary, which the poll on the
      // query below is what makes true on screen.
      if (classification === "pending") {
        return (
          <span className="text-muted-foreground" aria-live="polite">
            classifying…
          </span>
        );
      }
      return <span className="text-muted-foreground">unclassified</span>;
    },
  }),
  columnHelper.accessor((row): unknown => row.createdAt, {
    id: "createdAt" satisfies TicketSortKey,
    header: "Created",
    cell: ({ row }) => (
      <span className="text-muted-foreground">
        {formatCreated(row.original.createdAt)}
      </span>
    ),
  }),
];

/**
 * The support queue.
 *
 * TanStack Table in `manualSorting` mode: it owns the column model, the header
 * toggle and the sort state, and it is told not to reorder anything itself. It
 * cannot — the SPA holds one page of a cursor-paginated list, so sorting the
 * rows in hand would sort a sample and present it as the queue. `sorting` goes
 * into the query key, which restarts the list from a fresh cursor under the new
 * ORDER BY.
 *
 */
export function TicketListPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const queue = useMemo(() => readQueueState(searchParams), [searchParams]);
  const { status, category, search, sortKey, sortOrder, pageIndex } = queue;

  /**
   * Every control that changes the ordering or the set of rows also sends the
   * reader back to page 1, because the page they were on does not survive it:
   * page 3 of the open tickets is not page 3 of all of them, and a cursor from
   * one ordering names a position in a list the next ordering does not have.
   * Leaving `pageIndex` alone would show page 3 of a two-page result as empty.
   *
   * Paging is the one change that keeps its index, so it goes through
   * `goToPage` instead.
   */
  const applyFilters = useCallback(
    (patch: Partial<QueueState>, replace = false) => {
      setSearchParams(writeQueueState({ ...queue, ...patch, pageIndex: 0 }), {
        replace,
      });
    },
    [queue, setSearchParams],
  );

  const goToPage = useCallback(
    (index: number) => {
      setSearchParams(writeQueueState({ ...queue, pageIndex: index }));
    },
    [queue, setSearchParams],
  );

  // Base UI types the value as nullable — a Select can be cleared — but neither
  // of these can be: both carry an explicit "all" item and no clear affordance.
  const handleStatusChange = (value: TicketStatus | "all" | null) => {
    applyFilters({ status: value ?? "all" });
  };

  const handleCategoryChange = (value: TicketCategory | "all" | null) => {
    applyFilters({ category: value ?? "all" });
  };

  /**
   * Two pieces of state for one box: what has been typed, and what has been
   * searched for.
   *
   * They are separate because the input has to stay responsive per keystroke
   * while the query must not — one request per character would put eight
   * in flight for "refund", each with its own cursor, and the last to arrive
   * wins regardless of which was asked last. `search` comes off the URL and
   * only moves when typing pauses; it is what reaches the query key.
   */
  const [searchInput, setSearchInput] = useState(search);

  /**
   * The URL is the source of truth for the term, so a Back or a restored link
   * that changes `q` has to pull the box along with it — otherwise the debounce
   * below reads the stale input as a fresh search and immediately undoes the
   * navigation.
   *
   * Adjusted during render rather than in an effect, which is what React
   * prescribes for state derived from something outside the component: an
   * effect would paint the stale term first and correct it on a second pass,
   * and it is the pattern `react-hooks/set-state-in-effect` exists to push you
   * off. `syncedTerm` is the previous `search` — without it this cannot tell a
   * navigation from its own debounce landing.
   *
   * The trimmed comparison is what keeps the debounce's own commit from
   * rewriting the box: "refund " searches for "refund", and snatching the space
   * back out from under someone still typing is a jarring way to say so.
   */
  const [syncedTerm, setSyncedTerm] = useState(search);
  if (syncedTerm !== search) {
    setSyncedTerm(search);
    if (searchInput.trim() !== search) setSearchInput(search);
  }

  useEffect(() => {
    // Trimmed here as well as in the shared schema: this value is a query key,
    // and "refund" and "refund " would otherwise be two cache entries holding
    // identical results.
    const term = searchInput.trim();
    if (term === search) return;

    // Replaces rather than pushes: six keystrokes must not become six history
    // entries the Back button has to be clicked through. A search narrows the
    // queue, so the page the reader was on is gone with the rows that were on
    // it — `applyFilters` resets it for the same reason the two filters do.
    const timer = setTimeout(() => applyFilters({ search: term }, true), 300);

    return () => clearTimeout(timer);
  }, [searchInput, search, applyFilters]);

  // TanStack replaces this array on every toggle and would refetch the list on
  // any unrelated re-render if it went into a query key; the URL's two scalars
  // are what the query key holds, and this is derived back from them.
  const sorting = useMemo<SortingState>(
    () => [{ id: sortKey, desc: sortOrder === "desc" }],
    [sortKey, sortOrder],
  );

  const {
    data,
    isError,
    error,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ["tickets", { status, category, search, sortKey, sortOrder }],
    queryFn: ({ pageParam }) =>
      listTickets({
        ...(status === "all" ? {} : { status }),
        ...(category === "all" ? {} : { category }),
        ...(search ? { q: search } : {}),
        // Omitted when they match the server's own defaults, so the common
        // request stays `/api/tickets` rather than carrying a redundant pair.
        ...(sortKey === "createdAt" && sortOrder === "desc"
          ? {}
          : { sort: sortKey, order: sortOrder }),
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: undefined as string | undefined,
    // `nextCursor` is null on the last page; undefined is what switches
    // hasNextPage off.
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    /**
     * Poll, but only while there is something on screen that is going to
     * change on its own.
     *
     * Classification happens after ingestion answers, so a ticket can sit in
     * the queue reading "classifying…" with the answer arriving a few seconds
     * later and nothing to fetch it. Without this the row stays that way until
     * the reader navigates or the window regains focus, which is the version
     * where a working feature looks stuck.
     *
     * Gated on the page actually being *looked at* rather than on any page
     * loaded: this is an infinite query, so a refetch re-fetches every page
     * walked so far, and a pending row three pages back would put that on a
     * five-second timer for nothing. In practice the window is the few seconds
     * after an email lands; the rest of the time this is `false` and the query
     * behaves exactly as it did.
     */
    refetchInterval: (query) =>
      query.state.data?.pages[pageIndex]?.data.some(
        (row) => row.classification === "pending",
      )
        ? 5_000
        : false,
  });

  /**
   * One page, not every page fetched so far.
   *
   * `useInfiniteQuery` accumulates — that is its whole purpose — and this is
   * where the accumulation stops being what the screen shows. Every page the
   * user has walked through stays in `data.pages`, which is exactly what makes
   * Prev instant and free: going back is an index change, not a request. Only
   * Next can need the network, and only the first time.
   *
   * Memoised because TanStack Table treats a new `data` identity as new rows,
   * and would rebuild the row model on every unrelated render otherwise.
   */
  const tickets = useMemo(
    () => data?.pages[pageIndex]?.data ?? [],
    [data, pageIndex],
  );

  const pagesLoaded = data?.pages.length ?? 0;

  // `total` is the same on every page — it counts what matches the filters, not
  // what is on screen — so reading it off the first is not a shortcut.
  const total = data?.pages[0]?.total ?? 0;
  const pageCount = Math.ceil(total / TICKET_PAGE_SIZE);

  /**
   * A page index from the URL can name a page that is not in hand, and the
   * cursor is the only thing that can say what to do about it.
   *
   * Cursor pagination cannot jump — page 3's cursor is only known once page 2
   * has come back — so a cold arrival at `?page=3` walks forward one request at
   * a time. That is the price of the address being restorable at all, and it is
   * paid on a reload or a pasted link; a reader returning from a ticket finds
   * those pages in the query cache and this does nothing.
   *
   * When the walk runs out of cursors the index is clamped to the last real
   * page and the URL corrected in place, which covers `?page=99` and the case
   * that happens by itself: a queue that shrank while the reader was away.
   * Resolving a ticket from its detail page marks these pages stale, so the
   * queue refetches on the way back — and a refetch stops at the first page
   * whose `nextCursor` is null, so `data.pages` shrinks to what is really
   * there and this lands the reader on the end of the queue rather than on an
   * empty table reading "no tickets match that filter".
   *
   * `replace`, because a corrected address is not somewhere Back should return
   * to. Clamping on `pageCount` instead would decide the same destination
   * earlier without saving a single request — reaching the last page still
   * means walking to it.
   */
  useEffect(() => {
    if (!data || pageIndex < pagesLoaded) return;

    if (hasNextPage) {
      if (!isFetchingNextPage) void fetchNextPage();
      return;
    }

    setSearchParams(
      writeQueueState({ ...queue, pageIndex: Math.max(0, pagesLoaded - 1) }),
      { replace: true },
    );
  }, [
    data,
    pageIndex,
    pagesLoaded,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    queue,
    setSearchParams,
  ]);

  /**
   * Covers the first load and the walk above alike: a page the cache has not
   * reached yet has no rows, and rendering the empty-state card for it would
   * tell the reader their filter matched nothing when the page is simply still
   * on its way. Not while erroring — the alert is the honest answer there.
   */
  const isPageLoading = !isError && pageIndex >= pagesLoaded;

  const firstRow = pageIndex * TICKET_PAGE_SIZE + 1;
  const lastRow = Math.min(firstRow + tickets.length - 1, total);

  // A page that has not been fetched yet is one `fetchNextPage` away, because
  // pages are only ever walked one at a time. `hasNextPage` is the cursor's
  // answer and `pageCount` is the count's; they agree, and trusting the cursor
  // here means Next is never offered for a page the server cannot produce.
  const isLastPage = pageIndex >= pageCount - 1;
  const canGoNext = !isLastPage && (pageIndex + 1 < pagesLoaded || hasNextPage);

  const goNext = () => {
    if (!canGoNext) return;
    // Already fetched — Prev then Next costs nothing.
    if (pageIndex + 1 < pagesLoaded) {
      goToPage(pageIndex + 1);
      return;
    }
    // Fetched before the index moves, so the page in hand stays on screen under
    // a "Loading…" button rather than blinking through the skeleton.
    void fetchNextPage().then(() => goToPage(pageIndex + 1));
  };

  const table = useTable({
    features,
    data: tickets,
    columns,
    state: { sorting },
    // Not `setSorting` directly: a new ordering makes the current page index
    // meaningless, and TanStack hands the updater straight through.
    onSortingChange: (updater) => {
      const next = typeof updater === "function" ? updater(sorting) : updater;
      const first = next[0];
      applyFilters({
        sortKey:
          (first?.id as TicketSortKey | undefined) ?? DEFAULT_QUEUE.sortKey,
        sortOrder: first?.desc === false ? "asc" : "desc",
      });
    },
    // States the intent, and is the belt to the omitted sortedRowModel's
    // braces: on its own it changes nothing here, because there is no sorted
    // row model for it to switch off. It earns its place the day someone adds
    // one — the server sorts, and a page of a cursor-paginated list re-sorted
    // in the browser is a sample presented as the queue.
    manualSorting: true,
    // The API takes one `sort` and one `order`, so a shift-click must not be
    // able to build a state the server has no way to honour.
    enableMultiSort: false,
    // A third click would otherwise clear the sort entirely, which here means
    // "fall back to createdAt desc" — a header cycling through two orders and
    // then somebody else's column reads as a bug.
    enableSortingRemoval: false,
  });

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-semibold tracking-tight">Tickets</h2>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor="search" className="text-muted-foreground">
          Search
        </Label>
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            id="search"
            // `type="search"`, so a browser that offers a native clear control
            // and Escape-to-clear does — the button below is the guarantee, not
            // the only way.
            type="search"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Subject, sender or message…"
            className="w-64 pr-8 pl-8"
          />
          {searchInput && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setSearchInput("")}
              className="absolute top-1/2 right-2 -translate-y-1/2 rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          )}
        </div>

        <Label htmlFor="status" className="ml-4 text-muted-foreground">
          Status
        </Label>
        <Select
          items={STATUS_ITEMS}
          value={status}
          onValueChange={handleStatusChange}
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
          onValueChange={handleCategoryChange}
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

      {isPageLoading && <TicketsTableSkeleton table={table} />}

      {isError && (
        <Alert variant="destructive">
          <AlertTitle>Could not load tickets</AlertTitle>
          <AlertDescription>{(error as Error).message}</AlertDescription>
        </Alert>
      )}

      {data && !isPageLoading && tickets.length === 0 && (
        <Card className="border-dashed">
          <CardContent className="py-10 text-center">
            {/*
              Naming the search rather than "that filter" when one is active:
              the reader's next move is to edit or clear the term, and being
              told a filter is at fault sends them to the wrong control.
            */}
            <p className="font-medium">
              {search
                ? `No tickets match “${search}”`
                : "No tickets match that filter"}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {search ? (
                "Searches cover the subject, the sender and the message body."
              ) : (
                <>
                  Tickets appear here when email arrives at the support address.
                  Deliver one with <code>bun run email:send</code>.
                </>
              )}
            </p>
          </CardContent>
        </Card>
      )}

      {data && tickets.length > 0 && (
        <div className="space-y-4">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <TicketsTableHead table={table} />
              <tbody className="divide-y">
                {table.getRowModel().rows.map((row) => (
                  <tr key={row.id}>
                    {row.getAllCells().map((cell) => (
                      <td key={cell.id} className="py-3 pr-4 last:pr-0">
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext(),
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <nav
            aria-label="Ticket pages"
            className="flex flex-wrap items-center justify-between gap-3"
          >
            {/*
              The range, not just the page number. "Page 3 of 10" tells a reader
              where they are; "21–30 of 100" tells them how much is left, which
              is the question someone working a queue actually has.
            */}
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {firstRow}–{lastRow} of {total}
            </p>

            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => goToPage(Math.max(0, pageIndex - 1))}
                disabled={pageIndex === 0}
              >
                ‹ Prev
              </Button>
              <span className="text-sm tabular-nums text-muted-foreground">
                Page {pageIndex + 1} of {pageCount}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={goNext}
                // Disabled while the next page is in flight, so a second click
                // cannot queue a second fetch and skip a page on arrival.
                disabled={!canGoNext || isFetchingNextPage}
              >
                {isFetchingNextPage ? "Loading…" : "Next ›"}
              </Button>
            </div>
          </nav>
        </div>
      )}
    </section>
  );
}

type TicketTable = ReactTable<typeof features, TicketSummary>;

/**
 * The subject is the row's handle: it is what a reader recognises the ticket
 * by, so it is what opens it. A whole-row click would take the sender address
 * and the status badge with it and leave no way to select text in the row; an
 * anchor keeps middle-click, cmd-click and "copy link" working, which is how a
 * ticket gets handed to someone else.
 *
 * `state` carries the queue's own address across, and that is what the detail
 * page's "Back to tickets" returns to. The browser's Back button gets the same
 * thing from the URL for free; the in-page link is a fresh navigation to "/"
 * and would otherwise drop the reader on page 1 of an unfiltered queue.
 */
function SubjectCell({ ticket }: { ticket: TicketSummary }) {
  const location = useLocation();

  return (
    <Link
      to={`/tickets/${ticket.id}`}
      state={{ from: `${location.pathname}${location.search}` }}
      className="rounded-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {ticket.subject}
    </Link>
  );
}

/**
 * The From header, as one cell.
 *
 * `studentName` is null for mail that carried a bare address and for every
 * ticket ingested before the column existed, so the address is the fallback
 * rather than the second line. The server's `sender` sort orders by this exact
 * fallback, so the column sorts the way it reads.
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

/**
 * Every header is a sort toggle, because every column here maps to a
 * `TicketSortKey`.
 *
 * `aria-sort` on the `<th>` is the part that is not decoration: without it a
 * screen reader is told the table is sorted by nothing, and the arrow glyph is
 * the only thing carrying the state. The button label says which way the next
 * click will sort rather than which way it is sorted now — a control is named
 * for what it does.
 */
function TicketsTableHead({ table }: { table: TicketTable }) {
  return (
    <thead>
      {table.getHeaderGroups().map((headerGroup) => (
        <tr
          key={headerGroup.id}
          className="border-b text-left text-muted-foreground"
        >
          {headerGroup.headers.map((header) => {
            const direction = header.column.getIsSorted();
            const Icon =
              direction === "asc"
                ? ArrowUp
                : direction === "desc"
                  ? ArrowDown
                  : ChevronsUpDown;

            return (
              <th
                key={header.id}
                scope="col"
                className="py-2 pr-4 font-medium last:pr-0"
                aria-sort={
                  direction === "asc"
                    ? "ascending"
                    : direction === "desc"
                      ? "descending"
                      : "none"
                }
              >
                <button
                  type="button"
                  onClick={header.column.getToggleSortingHandler()}
                  className="-mx-1 flex items-center gap-1 rounded-sm px-1 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  {flexRender(
                    header.column.columnDef.header,
                    header.getContext(),
                  )}
                  <Icon
                    aria-hidden="true"
                    className={direction ? "size-3.5" : "size-3.5 opacity-40"}
                  />
                  <span className="sr-only">
                    {direction === "asc"
                      ? ", sort descending"
                      : ", sort ascending"}
                  </span>
                </button>
              </th>
            );
          })}
        </tr>
      ))}
    </thead>
  );
}

/**
 * Placeholder rows shaped like the real table so the header and column widths
 * do not shift when the first page arrives. It renders the real `<thead>`,
 * which means the sort controls stay live during a refetch — clicking a second
 * column while the first is still loading works rather than being a dead area.
 */
function TicketsTableSkeleton({ table }: { table: TicketTable }) {
  const widths = ["w-56", "w-40", "w-16", "w-28", "w-20"];

  return (
    <div className="overflow-x-auto" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading tickets…</span>
      <table className="w-full text-sm">
        <TicketsTableHead table={table} />
        <tbody className="divide-y">
          {Array.from({ length: 5 }, (_, rowIndex) => (
            <tr key={rowIndex}>
              {widths.map((width, cellIndex) => (
                <td key={cellIndex} className="py-3 pr-4 last:pr-0">
                  <Skeleton className={`h-4 ${width}`} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
