import { useMemo, useState } from "react";
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
  TICKET_STATUSES,
  type TicketCategory,
  type TicketSortKey,
  type TicketStatus,
  type TicketSummary,
} from "@helpdesk/shared";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
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
 * Newest first, which is the only default a support queue can have: the thing
 * that arrived while you were reading the last one is the thing you have not
 * seen. It matches `listTicketsQuerySchema`'s own default, so the first request
 * carries no sort params at all.
 */
const DEFAULT_SORT: SortingState = [{ id: "createdAt", desc: true }];

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
    cell: ({ row }) => (
      <span className="font-medium">{row.original.subject}</span>
    ),
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
      const category = row.original.category;
      // The null is the feature — nothing classifies — so it renders as a
      // stated absence rather than an empty cell that reads like a bug. The
      // accessor above flattens it to "" because that value is never rendered
      // or compared here; Postgres decides where the unclassified rows go.
      return category ? (
        <Badge variant="outline">{CATEGORY_LABELS[category]}</Badge>
      ) : (
        <span className="text-muted-foreground">unclassified</span>
      );
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
  const [status, setStatus] = useState<TicketStatus | "all">("all");
  const [category, setCategory] = useState<TicketCategory | "all">("all");
  const [sorting, setSorting] = useState<SortingState>(DEFAULT_SORT);

  // `sorting` is an array TanStack replaces on every toggle, so it cannot go
  // into a query key directly — a new array with identical contents would
  // refetch the whole list on any unrelated re-render.
  const sort = sorting[0];
  const sortKey = (sort?.id ?? "createdAt") as TicketSortKey;
  const sortOrder = sort?.desc === false ? "asc" : "desc";

  const {
    data,
    isPending,
    isError,
    error,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ["tickets", { status, category, sortKey, sortOrder }],
    queryFn: ({ pageParam }) =>
      listTickets({
        ...(status === "all" ? {} : { status }),
        ...(category === "all" ? {} : { category }),
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
  });

  // Memoised because TanStack Table treats a new `data` identity as new rows;
  // flatMap on every render would rebuild the row model each time.
  const tickets = useMemo(
    () => data?.pages.flatMap((page) => page.data) ?? [],
    [data],
  );

  const table = useTable({
    features,
    data: tickets,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
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

      {isPending && <TicketsTableSkeleton table={table} />}

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

type TicketTable = ReactTable<typeof features, TicketSummary>;

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
