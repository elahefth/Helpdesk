import { asc, desc, sql, type SQL } from "drizzle-orm";
import type { TicketSortKey } from "@helpdesk/shared";
import { ticket } from "../db/schema.ts";
import { HttpError } from "../middleware/errors.ts";
import { ticketSummarySchema } from "@helpdesk/shared";

type TicketRow = typeof ticket.$inferSelect;

/**
 * Everything that varies between the sortable columns, in one table, so the
 * query builder below has no per-column branches.
 *
 * `expression` is what both the ORDER BY and the keyset predicate use, and they
 * must stay the same expression or the two disagree about where a page ended.
 * `valueOf` reconstructs the same value from a row for the cursor, and `bind`
 * turns it back into a parameter Postgres can compare against the column.
 */
interface SortSpec {
  expression: SQL;
  /** Whether the expression can be NULL, which changes the keyset predicate. */
  nullable: boolean;
  valueOf: (row: TicketRow) => string | null;
  bind: (value: string) => SQL;
}

const text = (value: string): SQL => sql`${value}`;

const SORTS: Record<TicketSortKey, SortSpec> = {
  subject: {
    expression: sql`${ticket.subject}`,
    nullable: false,
    valueOf: (row) => row.subject,
    bind: text,
  },
  /**
   * The same fallback the table renders, so the order on screen matches the
   * column the user clicked. `student_email` is NOT NULL, so the coalesce can
   * never be null however many senders arrive without a display name.
   */
  sender: {
    expression: sql`coalesce(${ticket.studentName}, ${ticket.studentEmail})`,
    nullable: false,
    valueOf: (row) => row.studentName ?? row.studentEmail,
    bind: text,
  },
  /**
   * Postgres orders an enum by its declaration order, not alphabetically, so
   * this sorts open → resolved → closed. That is the lifecycle, which is more
   * useful than closed → open → resolved, and it is the reason the column is a
   * real enum rather than a text column with a check constraint.
   *
   * The cast is not decoration: an untyped parameter compared against an enum
   * inside a row-value comparison is where Postgres stops being able to infer
   * the type and raises instead.
   */
  status: {
    expression: sql`${ticket.status}`,
    nullable: false,
    valueOf: (row) => row.status,
    bind: (value) => sql`${value}::ticket_status`,
  },
  category: {
    expression: sql`${ticket.category}`,
    // The only nullable sort — nothing classifies, so most rows are NULL.
    nullable: true,
    valueOf: (row) => row.category,
    bind: (value) => sql`${value}::ticket_category`,
  },
  createdAt: {
    expression: sql`${ticket.createdAt}`,
    nullable: false,
    valueOf: (row) => row.createdAt.toISOString(),
    bind: (value) => sql`${new Date(value)}`,
  },
  updatedAt: {
    expression: sql`${ticket.updatedAt}`,
    nullable: false,
    valueOf: (row) => row.updatedAt.toISOString(),
    bind: (value) => sql`${new Date(value)}`,
  },
};

export type SortOrder = "asc" | "desc";

/**
 * The cursor is `[sortValue, id]` as JSON, base64url'd — `sortValue` is null
 * only when the sort column is.
 *
 * JSON rather than the `<value>|<id>` pair this started as: a subject may
 * contain any character at all, including the separator, and "split on the last
 * one" stops being right the moment the sort key is user-supplied text.
 *
 * Base64 for the reason the user list gives: it keeps the sort key from
 * hardening into a de-facto public API, so changing what a cursor holds is not
 * a breaking change for a client that stored one.
 */
export interface TicketCursor {
  value: string | null;
  id: string;
}

export function encodeTicketCursor(
  row: TicketRow,
  sort: TicketSortKey,
): string {
  const payload: [string | null, string] = [SORTS[sort].valueOf(row), row.id];
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeTicketCursor(cursor: string): TicketCursor {
  // Buffer.from drops invalid base64 silently rather than throwing, and
  // JSON.parse throws a SyntaxError that would surface as a 500, so both the
  // shape and the parse are checked here. This is the validation, not a second
  // opinion on it.
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw HttpError.badRequest("Malformed cursor");
  }

  if (!Array.isArray(parsed) || parsed.length !== 2) {
    throw HttpError.badRequest("Malformed cursor");
  }

  const [value, id] = parsed as [unknown, unknown];
  const parsedId = ticketSummarySchema.shape.id.safeParse(id);
  if (!parsedId.success || (value !== null && typeof value !== "string")) {
    throw HttpError.badRequest("Malformed cursor");
  }

  return { value, id: parsedId.data };
}

/**
 * The ORDER BY, tiebroken by `id`.
 *
 * The tiebreaker is not optional: no sortable column here is unique, and two
 * tickets sharing a subject — or a status, which most of them do — would
 * otherwise come back in whatever order the plan happened to produce, which is
 * free to differ between the two queries that make up a page boundary. That is
 * how keyset pagination silently drops and repeats rows.
 *
 * A nullable column additionally leads with `IS NULL`, so unclassified tickets
 * are the tail in *both* directions rather than flipping to the head on desc.
 * NULL there is "nobody has said", not a value that sorts low, and burying the
 * classified rows under it would make the desc sort useless.
 */
export function ticketOrderBy(sort: TicketSortKey, order: SortOrder): SQL[] {
  const spec = SORTS[sort];
  const direction = order === "asc" ? asc : desc;

  return [
    ...(spec.nullable ? [asc(sql`${spec.expression} is null`)] : []),
    direction(spec.expression),
    direction(ticket.id),
  ];
}

/**
 * "Everything after the cursor row", in the ordering above.
 *
 * The non-null case is a row-value comparison — `(sort, id) < (value, id)` —
 * rather than the `sort < v OR (sort = v AND id < id)` it expands to. Postgres
 * can drive a composite index straight from the tuple form; the OR form
 * usually degrades to a filter, and the difference shows up as a sequential
 * scan on page two.
 *
 * For a nullable column the tuple form alone is wrong twice over, and both are
 * silent. A row whose column is NULL makes the comparison NULL rather than
 * false, so the NULL tail would be unreachable — page two of a category sort
 * would simply end early. And once the cursor is *inside* that tail there is no
 * value to compare against at all, so it becomes an id-only walk.
 */
export function ticketAfterCursor(
  sort: TicketSortKey,
  order: SortOrder,
  cursor: TicketCursor,
): SQL {
  const spec = SORTS[sort];
  const comparison = order === "asc" ? sql`>` : sql`<`;
  const id = sql`${cursor.id}::uuid`;

  if (cursor.value === null) {
    // Only reachable on a nullable column: `valueOf` returns null for nothing
    // else. The cursor is in the NULL tail, so every remaining row is too.
    return sql`${spec.expression} is null and ${ticket.id} ${comparison} ${id}`;
  }

  const after = sql`(${spec.expression}, ${ticket.id}) ${comparison} (${spec.bind(cursor.value)}, ${id})`;

  // The tail sorts after every non-null value in both directions, so it is
  // always still ahead when the cursor holds one.
  return spec.nullable ? sql`(${spec.expression} is null or ${after})` : after;
}
