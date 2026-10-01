import { describe, expect, it } from "bun:test";
import { TICKET_PREVIEW_LENGTH, ticketDetailSchema } from "@helpdesk/shared";
import type { ticket, user } from "../db/schema.ts";
import {
  ticketPreview,
  toTicketDetail,
  toTicketSummary,
} from "./ticket-mappers.ts";

/**
 * The row-to-wire projection, which fails in a place a long way from here when
 * it is wrong: the SPA parses every response with these schemas, so a `Date`
 * left unformatted or a NULL role passed through is a throw in the browser
 * rather than an error in the API.
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
  classification: "skipped",
  autoResolution: "skipped",
  assignedToId: null,
  resolvedAt: null,
  sourceMessageId: null,
  receivedAt: new Date("2026-08-20T09:15:00.000Z"),
  createdAt: new Date("2026-08-20T09:15:01.000Z"),
  updatedAt: new Date("2026-08-21T10:00:00.000Z"),
};

const STAFF: typeof user.$inferSelect = {
  id: "44444444-4444-4444-8444-444444444444",
  name: "Cass Agent",
  email: "cass@helpdesk.test",
  emailVerified: false,
  image: null,
  role: "agent",
  deletedAt: null,
  createdAt: new Date("2026-01-05T09:00:00.000Z"),
  updatedAt: new Date("2026-01-05T09:00:00.000Z"),
};

describe("toTicketDetail", () => {
  it("produces a body the shared schema accepts", () => {
    // The real assertion of the whole mapper: parse rather than compare, so a
    // field added to the contract fails here instead of three layers away.
    expect(() =>
      ticketDetailSchema.parse(toTicketDetail({ ...ROW }, STAFF)),
    ).not.toThrow();
  });

  it("resolves the assignee to a person, not an id", () => {
    const detail = toTicketDetail({ ...ROW, assignedToId: STAFF.id }, STAFF);

    expect(detail.assignee).toEqual({
      id: STAFF.id,
      name: "Cass Agent",
      email: "cass@helpdesk.test",
      role: "agent",
    });
  });

  it("spells an unassigned ticket null", () => {
    expect(toTicketDetail({ ...ROW }, null).assignee).toBeNull();
  });

  /**
   * `role` is nullable in the generated auth schema even though the column
   * defaults to 'agent'. `userSchema` requires it, so an unguarded NULL would
   * throw inside the SPA's response parse — which is why the guard is here and
   * not left to the caller.
   */
  it("reads a null role as agent", () => {
    const detail = toTicketDetail({ ...ROW }, { ...STAFF, role: null });

    expect(detail.assignee?.role).toBe("agent");
    expect(() => ticketDetailSchema.parse(detail)).not.toThrow();
  });

  /**
   * A soft-deleted assignee is still the assignee. The user row survives a
   * delete precisely so a ticket can name who handled it, so redrawing an owned
   * ticket as unassigned would throw that away — the reassignment is a human's
   * to make.
   */
  it("keeps a deleted assignee on the ticket", () => {
    const departed = { ...STAFF, deletedAt: new Date("2026-06-01T00:00:00Z") };

    expect(toTicketDetail({ ...ROW }, departed).assignee?.id).toBe(STAFF.id);
  });

  it("carries the summary fields through unchanged", () => {
    const row = { ...ROW };

    expect(toTicketDetail(row, null)).toMatchObject(toTicketSummary(row));
  });
});

describe("ticketPreview", () => {
  it("flattens the greeting's line breaks into one line", () => {
    expect(ticketPreview("Hi,\n\nI cannot log in.\n\nAda")).toBe(
      "Hi, I cannot log in. Ada",
    );
  });

  it("cuts a long email at the preview length", () => {
    const preview = ticketPreview("word ".repeat(100));

    expect(preview.length).toBeLessThanOrEqual(TICKET_PREVIEW_LENGTH);
    expect(preview.endsWith(" ")).toBe(false);
  });

  // Cut by UTF-16 unit, the emoji straddling the boundary would leave a lone
  // surrogate, which the browser renders as a replacement box.
  it("never splits a character in half", () => {
    const body = `${"a".repeat(TICKET_PREVIEW_LENGTH - 1)}😀 tail`;
    const preview = ticketPreview(body);

    expect(preview.endsWith("😀")).toBe(true);
  });

  it("is on the summary the list sends", () => {
    expect(toTicketSummary({ ...ROW }).preview).toBe(
      "I have reset my password twice.",
    );
  });
});
