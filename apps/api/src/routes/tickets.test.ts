import { describe, expect, it } from "bun:test";
import {
  createTicketReplyBodySchema,
  listTicketsQuerySchema,
  polishTicketReplyBodySchema,
  TICKET_REPLY_MAX_LENGTH,
  updateTicketBodySchema,
} from "@helpdesk/shared";
import { searchPattern } from "./tickets.ts";

/**
 * The search term's journey from query string to LIKE pattern. Both halves fail
 * silently when they are wrong — a bad pattern returns rows rather than an
 * error, so nothing upstream notices.
 */
describe("searchPattern", () => {
  it("wraps an ordinary term for a substring match", () => {
    expect(searchPattern("refund")).toBe("%refund%");
  });

  /**
   * The characters LIKE reads as wildcards. Unescaped, a search for "%" matches
   * every ticket in the queue and "_" matches any single character — so the
   * results have nothing to do with what was typed, and the reader has no way
   * to tell.
   */
  it.each([
    ["a percent", "50%", "%50\\%%"],
    ["an underscore", "week_6", "%week\\_6%"],
    ["a backslash", "path\\to", "%path\\\\to%"],
    ["all three", "a%b_c\\d", "%a\\%b\\_c\\\\d%"],
  ])("escapes %s", (_label, term, expected) => {
    expect(searchPattern(term)).toBe(expected);
  });

  /**
   * Order matters, and getting it wrong is invisible: escaping `%` before `\`
   * would turn the `\` of the new `\%` into `\\%`, which is a literal backslash
   * followed by a wildcard — the opposite of what was asked for.
   */
  it("escapes the backslash first", () => {
    expect(searchPattern("\\%")).toBe("%\\\\\\%%");
  });

  it("leaves the characters LIKE does not treat specially alone", () => {
    expect(searchPattern("a@b.com")).toBe("%a@b.com%");
    expect(searchPattern("O'Brien")).toBe("%O'Brien%");
  });
});

describe("listTicketsQuerySchema search term", () => {
  it("trims a term", () => {
    expect(listTicketsQuerySchema.parse({ q: "  refund  " }).q).toBe("refund");
  });

  it.each([
    ["omitted", undefined],
    ["blank", ""],
    ["whitespace only", "   "],
  ])("treats a %s term as no search at all", (_label, q) => {
    // `q=` reaching the route as an empty pattern would be a search for
    // nothing, which matches every row by accident. Clearing the box has to
    // mean "no search", and this is where that is decided.
    const parsed = listTicketsQuerySchema.parse(q === undefined ? {} : { q });
    expect(parsed.q).toBeUndefined();
  });

  it("rejects a term longer than a subject line", () => {
    expect(
      listTicketsQuerySchema.safeParse({ q: "x".repeat(201) }).success,
    ).toBe(false);
  });

  it("keeps a term that is only punctuation", () => {
    // Escaped downstream, so this is a literal search and not a wildcard.
    expect(listTicketsQuerySchema.parse({ q: "%" }).q).toBe("%");
  });
});

/**
 * The one distinction the assignment route turns on, and the one a plain
 * `z.object` would erase.
 */
describe("updateTicketBodySchema", () => {
  it("reads an omitted assigneeId as leave it alone", () => {
    const parsed = updateTicketBodySchema.parse({});
    expect("assigneeId" in parsed).toBe(false);
  });

  /**
   * Absent and null must stay distinguishable: absent is "change nothing", null
   * is "hand it back to the unassigned pool". Collapsing them would leave an
   * agent who cannot take a ticket after all with no way to say so.
   */
  it("reads an explicit null as unassign", () => {
    expect(updateTicketBodySchema.parse({ assigneeId: null })).toEqual({
      assigneeId: null,
    });
  });

  it("accepts a uuid", () => {
    const id = "44444444-4444-4444-8444-444444444444";
    expect(updateTicketBodySchema.parse({ assigneeId: id }).assigneeId).toBe(
      id,
    );
  });

  it("rejects an id that cannot name a row", () => {
    expect(() =>
      updateTicketBodySchema.parse({ assigneeId: "cass@helpdesk.test" }),
    ).toThrow();
  });

  /**
   * The reason it is `strictObject`. A plain object would strip the misspelling
   * and answer 200 for a request that assigned nobody, which is the failure
   * that looks exactly like success.
   */
  it("accepts a status on its own", () => {
    expect(updateTicketBodySchema.parse({ status: "resolved" })).toEqual({
      status: "resolved",
    });
  });

  it("rejects a status the domain no longer has", () => {
    expect(() => updateTicketBodySchema.parse({ status: "pending" })).toThrow();
  });

  /**
   * "Unclassified" is a real answer and the one every ticket starts with, so
   * null has to be sendable — an absent key means "leave it alone", which is a
   * different instruction.
   */
  it("reads an explicit null category as unclassified", () => {
    expect(updateTicketBodySchema.parse({ category: null })).toEqual({
      category: null,
    });
  });

  /** A ticket always has a status, so there is nothing for null to mean. */
  it("refuses a null status", () => {
    expect(() => updateTicketBodySchema.parse({ status: null })).toThrow();
  });

  it("takes all three fields at once", () => {
    const id = "44444444-4444-4444-8444-444444444444";
    expect(
      updateTicketBodySchema.parse({
        status: "resolved",
        category: "technical",
        assigneeId: id,
      }),
    ).toEqual({ status: "resolved", category: "technical", assigneeId: id });
  });

  it("rejects a key it does not know rather than dropping it", () => {
    expect(() =>
      updateTicketBodySchema.parse({
        assignee: "44444444-4444-4444-8444-444444444444",
      }),
    ).toThrow();
  });
});

/**
 * The reply body, which is one field and three rules — and every one of them
 * fails silently if it is wrong: a whitespace-only reply is a blank bubble in a
 * thread nothing can delete, and an unbounded one is a row nothing can trim.
 */
describe("createTicketReplyBodySchema", () => {
  it("trims the reply", () => {
    expect(
      createTicketReplyBodySchema.parse({ body: "  Have you tried…  " }).body,
    ).toBe("Have you tried…");
  });

  it("keeps the line breaks inside it", () => {
    // Trimmed at the ends only. The interior newlines are the reply's only
    // structure, the same way they are the email's.
    const body = "Hi Ada,\n\nTry a password reset.\n\nThanks";
    expect(createTicketReplyBodySchema.parse({ body }).body).toBe(body);
  });

  it.each([
    ["empty", ""],
    ["whitespace only", "   \n  "],
  ])("rejects a %s reply", (_label, body) => {
    expect(createTicketReplyBodySchema.safeParse({ body }).success).toBe(false);
  });

  it("rejects a reply past the length ceiling", () => {
    expect(
      createTicketReplyBodySchema.safeParse({
        body: "x".repeat(TICKET_REPLY_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it("accepts one exactly at it", () => {
    expect(
      createTicketReplyBodySchema.safeParse({
        body: "x".repeat(TICKET_REPLY_MAX_LENGTH),
      }).success,
    ).toBe(true);
  });

  /**
   * The author comes from the session, never the payload. A body that could
   * name its own author would let anyone sign a reply with a colleague's name,
   * and a plain `z.object` would strip the attempt and answer 201 as though
   * nothing had been asked for.
   */
  it("refuses a body that names its own author", () => {
    const parsed = createTicketReplyBodySchema.safeParse({
      body: "Signed, somebody else",
      authorId: "44444444-4444-4444-8444-444444444444",
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses a key it does not know rather than dropping it", () => {
    // The failure this guards against looks exactly like success: `text` would
    // be stripped, `body` would be missing, and the caller would be told what
    // they got wrong only by luck.
    expect(
      createTicketReplyBodySchema.safeParse({ text: "Have you tried…" })
        .success,
    ).toBe(false);
  });
});

/**
 * The draft on its way to the polisher. It is held to the same rules a sent
 * reply is, and the ceiling is the half that matters: a draft this schema
 * accepted and `createTicketReplyBodySchema` then rejected would be a rewrite
 * the agent paid for and could not send.
 */
describe("polishTicketReplyBodySchema", () => {
  it("trims the draft", () => {
    expect(polishTicketReplyBodySchema.parse({ body: "  fix this  " })).toEqual(
      {
        body: "fix this",
      },
    );
  });

  it.each([
    ["an empty draft", ""],
    ["a whitespace-only draft", "   \n  "],
  ])("refuses %s — there is nothing to rewrite", (_label, body) => {
    expect(polishTicketReplyBodySchema.safeParse({ body }).success).toBe(false);
  });

  it("says what to do about an empty box, in the polisher's own words", () => {
    const result = polishTicketReplyBodySchema.safeParse({ body: "" });
    expect(result.error?.issues[0]?.message).toBe(
      "Write a draft before polishing it.",
    );
  });

  it("shares the sent reply's ceiling", () => {
    const atLimit = "x".repeat(TICKET_REPLY_MAX_LENGTH);
    expect(
      polishTicketReplyBodySchema.safeParse({ body: atLimit }).success,
    ).toBe(true);
    expect(
      polishTicketReplyBodySchema.safeParse({ body: `${atLimit}x` }).success,
    ).toBe(false);
    // The pairing is the point: neither side may drift from the other.
    expect(
      createTicketReplyBodySchema.safeParse({ body: atLimit }).success,
    ).toBe(true);
  });

  /**
   * Strict for the reason its neighbour is: a plain object would strip a
   * misspelled field and hand the model a rewrite of nothing, answered 200.
   */
  it("refuses a key it does not know rather than dropping it", () => {
    expect(
      polishTicketReplyBodySchema.safeParse({ body: "ok", tone: "formal" })
        .success,
    ).toBe(false);
  });
});
