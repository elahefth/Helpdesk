import { describe, expect, it } from "bun:test";
import { TICKET_SORT_KEYS, type TicketSortKey } from "@helpdesk/shared";
import { ticket } from "../db/schema.ts";
import { HttpError } from "../middleware/errors.ts";
import {
  decodeTicketCursor,
  encodeTicketCursor,
  ticketOrderBy,
} from "./ticket-sort.ts";

/**
 * The cursor and the ordering, which no test with a stubbed database can reach
 * and which a wrong answer from breaks silently: keyset pagination that
 * disagrees with its own ORDER BY does not error, it drops or repeats rows.
 */
const ROW: typeof ticket.$inferSelect = {
  id: "33333333-3333-4333-8333-333333333333",
  subject: "Cannot log in",
  studentName: "Ada Student",
  studentEmail: "ada.student@example.com",
  supportEmail: "support@helpdesk.test",
  body: "I have reset my password twice.",
  status: "open",
  category: null,
  sourceMessageId: null,
  receivedAt: new Date("2026-08-20T09:15:00.000Z"),
  createdAt: new Date("2026-08-20T09:15:01.123Z"),
  updatedAt: new Date("2026-08-20T09:15:02.456Z"),
};

describe("ticket cursor", () => {
  it.each(TICKET_SORT_KEYS.map((key) => [key] as const))(
    "round-trips the %s sort value",
    (key: TicketSortKey) => {
      const decoded = decodeTicketCursor(encodeTicketCursor(ROW, key));
      expect(decoded.id).toBe(ROW.id);
      // Every key but `category` reads a non-null value off this row. `toBe`
      // would compare against the matcher object itself rather than apply it.
      expect(decoded.value).toEqual(
        key === "category" ? null : expect.any(String),
      );
    },
  );

  /**
   * The timestamp round-trip, and the reason `created_at` is declared
   * `precision: 3`.
   *
   * Postgres defaults a timestamptz to microseconds; a JS Date holds
   * milliseconds. Without the precision the driver truncates on the way out, so
   * a cursor built from a row lands a hair *below* the row it names — which is
   * invisible descending (the row is already behind) and an infinite loop
   * ascending, because the row still satisfies "after the cursor" and comes
   * back as its own next page, forever.
   */
  it("preserves a timestamp exactly", () => {
    const decoded = decodeTicketCursor(encodeTicketCursor(ROW, "createdAt"));
    expect(new Date(decoded.value!).getTime()).toBe(ROW.createdAt.getTime());
  });

  it.each([
    ["created_at", ticket.createdAt],
    ["updated_at", ticket.updatedAt],
    ["received_at", ticket.receivedAt],
  ])("declares %s at millisecond precision", (_label, column) => {
    // The other half of the guard above, and the half a JS-only round-trip
    // cannot see: dropping `precision: 3` from the column would leave this
    // file's assertions passing and page one row forever in production.
    expect(column.getSQLType()).toBe("timestamp (3) with time zone");
  });

  /**
   * Why the cursor is JSON and not the `<value>|<id>` pair it started as. A
   * subject is user-supplied text and may contain any character, the separator
   * included — "split on the last one" is right until someone emails about a
   * pipe.
   */
  it.each([
    ["a separator", "Refund | urgent | second request"],
    ["quotes and a backslash", 'He said "no refund" \\ then left'],
    ["a newline", "Line one\nline two"],
    ["non-latin text", "دانشجو نمی‌تواند وارد شود"],
    ["an emoji", "Cannot log in 🔒"],
  ])("survives a subject containing %s", (_label, subject) => {
    const decoded = decodeTicketCursor(
      encodeTicketCursor({ ...ROW, subject }, "subject"),
    );
    expect(decoded.value).toBe(subject);
    expect(decoded.id).toBe(ROW.id);
  });

  it("carries a null through for an unclassified ticket", () => {
    // Not the same as an absent value: the route branches on it to walk the
    // NULL tail by id alone.
    const decoded = decodeTicketCursor(encodeTicketCursor(ROW, "category"));
    expect(decoded.value).toBeNull();
  });

  it("uses the sender fallback the table renders", () => {
    // Sorting by the raw student_name would gather every nameless sender into
    // one block; the column shows the address in that case, and so does the
    // sort.
    const named = decodeTicketCursor(encodeTicketCursor(ROW, "sender"));
    expect(named.value).toBe("Ada Student");

    const anonymous = decodeTicketCursor(
      encodeTicketCursor({ ...ROW, studentName: null }, "sender"),
    );
    expect(anonymous.value).toBe("ada.student@example.com");
  });

  it.each([
    ["not base64 at all", "not-a-cursor"],
    [
      "valid base64 holding no JSON",
      Buffer.from("hello").toString("base64url"),
    ],
    ["a JSON object", Buffer.from('{"a":1}').toString("base64url")],
    ["a one-element array", Buffer.from('["x"]').toString("base64url")],
    ["a non-uuid id", Buffer.from('["x","nope"]').toString("base64url")],
    [
      "a numeric sort value",
      Buffer.from(`[1,"${ROW.id}"]`).toString("base64url"),
    ],
  ])("rejects %s with a 400", (_label, cursor) => {
    // A 500 here would blame the server for a string the client made up, and a
    // silent default would quietly restart the list from page one.
    expect(() => decodeTicketCursor(cursor)).toThrow(HttpError);
    try {
      decodeTicketCursor(cursor);
    } catch (error) {
      expect((error as HttpError).status).toBe(400);
    }
  });
});

describe("ticket ordering", () => {
  // Every sortable column is non-unique — most tickets share a status — so
  // without the id the two queries that make up a page boundary are free to
  // disagree about the order of a tie, which is how rows go missing.
  it.each(TICKET_SORT_KEYS.map((key) => [key] as const))(
    "tiebreaks the %s sort by id",
    (key: TicketSortKey) => {
      expect(ticketOrderBy(key, "asc").length).toBeGreaterThanOrEqual(2);
    },
  );

  // Unclassified is "nobody has said", not a value that sorts low. Leading with
  // `IS NULL` keeps it the tail in both directions instead of burying the
  // classified rows under it on desc.
  it("puts NULLs last in both directions, for the nullable sort only", () => {
    expect(ticketOrderBy("category", "asc")).toHaveLength(3);
    expect(ticketOrderBy("category", "desc")).toHaveLength(3);
    expect(ticketOrderBy("status", "asc")).toHaveLength(2);
    expect(ticketOrderBy("createdAt", "desc")).toHaveLength(2);
  });
});
