import { describe, expect, it } from "bun:test";
import { AI_HANDLED_AUTO_RESOLUTIONS } from "./domain.ts";
import {
  createUserBodySchema,
  inboundEmailBodySchema,
  listTicketsQuerySchema,
  ticketStatsQuerySchema,
  updateUserBodySchema,
} from "./api.ts";

/**
 * The email normalisation these cover is not cosmetic, and it is the reason
 * this file exists at all.
 *
 * Better Auth lowercases an address when it stores one at sign-up, and its
 * `findUserByEmail` lowercases the address it is handed before comparing it to
 * the column. A row whose email carries a capital is therefore unreachable by
 * every sign-in, and a password reset does not help — the lookup fails before a
 * password is checked, so the account is locked out permanently.
 *
 * Creating a user goes through Better Auth and is normalised on the way past.
 * Editing one writes the column directly, so the normalisation has to live here
 * instead: in the schema both routes parse with, and both forms resolve against.
 */
const VALID = {
  name: "Ada Admin",
  email: "ada@helpdesk.test",
  password: "correct-horse",
};

describe("email normalisation", () => {
  it.each([
    ["createUserBodySchema", createUserBodySchema],
    ["updateUserBodySchema", updateUserBodySchema],
  ])("%s lowercases the address", (_label, schema) => {
    const parsed = schema.parse({ ...VALID, email: "Ada@Helpdesk.TEST" });
    expect(parsed.email).toBe("ada@helpdesk.test");
  });

  it.each([
    ["createUserBodySchema", createUserBodySchema],
    ["updateUserBodySchema", updateUserBodySchema],
  ])("%s trims before it stores", (_label, schema) => {
    const parsed = schema.parse({ ...VALID, email: "  Ada@Helpdesk.test  " });
    expect(parsed.email).toBe("ada@helpdesk.test");
  });

  it("still rejects an address that is malformed in any case", () => {
    const parsed = updateUserBodySchema.safeParse({
      ...VALID,
      email: "NOT-AN-EMAIL",
    });
    expect(parsed.success).toBe(false);
  });
});

/**
 * The other half of the edit contract: blank means "leave the password alone".
 * All three spellings have to reach the route as `undefined`, because that is
 * the single case it branches on.
 */
describe("updateUserBodySchema password", () => {
  it.each([
    ["omitted", undefined],
    ["blank", ""],
    ["whitespace only", "   "],
  ])("treats a %s password as unchanged", (_label, password) => {
    const body = { name: VALID.name, email: VALID.email };
    const parsed = updateUserBodySchema.parse(
      password === undefined ? body : { ...body, password },
    );
    // The route branches on this, and JSON.stringify drops an undefined value,
    // so the key never reaches the wire either. Asserting the key is *absent*
    // from the parsed object would be wrong: Zod's transform leaves it present
    // and undefined when the input carried one.
    expect(parsed.password).toBeUndefined();
    expect(JSON.parse(JSON.stringify(parsed))).toEqual({
      name: VALID.name,
      email: VALID.email,
    });
  });

  it("keeps a real password, trimmed", () => {
    const parsed = updateUserBodySchema.parse({
      ...VALID,
      password: "  correct-horse  ",
    });
    expect(parsed.password).toBe("correct-horse");
  });

  // "Unchanged" is the empty string, not any short string.
  it("still enforces the floor on a non-empty password", () => {
    const parsed = updateUserBodySchema.safeParse({
      ...VALID,
      password: "1234567",
    });
    expect(parsed.success).toBe(false);
  });
});

/**
 * The inbound-email contract. Ingestion is the one write nobody is signed in
 * for, and the schema is where a malformed or lossy delivery is supposed to be
 * caught — so the normalisations it performs are worth pinning.
 */
describe("inboundEmailBodySchema", () => {
  const EMAIL = {
    from: "ada.student@example.com",
    to: "support@helpdesk.test",
    subject: "Cannot log in",
    text: "I have reset my password twice.",
  };

  it.each([
    ["from", "Ada.Student@Example.COM"],
    ["to", "Support@Helpdesk.TEST"],
  ])("lowercases %s", (field, value) => {
    const parsed = inboundEmailBodySchema.parse({ ...EMAIL, [field]: value });
    expect(parsed[field as "from" | "to"]).toBe(value.toLowerCase());
  });

  // The route compares `to` against SUPPORT_EMAIL, which env.ts lowercases too.
  // Without both sides normalised a provider that capitalises the address would
  // have every one of its deliveries answered 422.
  it("normalises the recipient the route matches on", () => {
    const parsed = inboundEmailBodySchema.parse({
      ...EMAIL,
      to: "  Support@Helpdesk.test ",
    });
    expect(parsed.to).toBe("support@helpdesk.test");
  });

  it.each([
    ["blank", ""],
    ["whitespace only", "   "],
  ])(
    "gives a %s subject a placeholder rather than rejecting it",
    (_l, subject) => {
      // Real mail arrives with no subject often enough that a 400 here would lose
      // tickets, and the column is NOT NULL.
      const parsed = inboundEmailBodySchema.parse({ ...EMAIL, subject });
      expect(parsed.subject).toBe("(no subject)");
    },
  );

  it.each([
    ["blank", ""],
    ["whitespace only", "  \n  "],
  ])("rejects a %s body", (_label, text) => {
    // An email with nothing in it is not a ticket anyone can answer.
    expect(inboundEmailBodySchema.safeParse({ ...EMAIL, text }).success).toBe(
      false,
    );
  });

  // Strict, and this is the case it exists for: a plain z.object would strip
  // the unknown key, store an email whose body went missing, and answer 201.
  it("rejects an unknown field instead of stripping it", () => {
    const parsed = inboundEmailBodySchema.safeParse({
      ...EMAIL,
      bodyText: "the real message, under a name the schema does not know",
    });
    expect(parsed.success).toBe(false);
  });

  it.each([
    ["omitted", undefined],
    ["blank", ""],
    ["whitespace only", "   "],
  ])("treats a %s sender name as absent", (_label, fromName) => {
    // A source that always sends the field, empty, must not store an empty
    // string — the table would render a nameless gap instead of falling back
    // to the address.
    const parsed = inboundEmailBodySchema.parse(
      fromName === undefined ? EMAIL : { ...EMAIL, fromName },
    );
    expect(parsed.fromName).toBeUndefined();
  });

  it("keeps a real sender name, trimmed", () => {
    const parsed = inboundEmailBodySchema.parse({
      ...EMAIL,
      fromName: "  Ada Student  ",
    });
    expect(parsed.fromName).toBe("Ada Student");
  });

  // Unlike the address, the display name is not lowercased: it is a person's
  // name, and "ada student" is not how anyone writes theirs.
  it("preserves the case of the sender name", () => {
    const parsed = inboundEmailBodySchema.parse({
      ...EMAIL,
      fromName: "Ada O'Brien-Smith",
    });
    expect(parsed.fromName).toBe("Ada O'Brien-Smith");
  });

  it("leaves messageId, receivedAt and category optional", () => {
    const parsed = inboundEmailBodySchema.parse(EMAIL);
    expect(parsed.messageId).toBeUndefined();
    expect(parsed.receivedAt).toBeUndefined();
    // Nothing classifies, so an email that did not state a category has none —
    // rather than being guessed into one the UI could not tell from a decision.
    expect(parsed.category).toBeUndefined();
  });

  it("keeps a category the source actually stated", () => {
    const parsed = inboundEmailBodySchema.parse({
      ...EMAIL,
      category: "refund_request",
    });
    expect(parsed.category).toBe("refund_request");
  });
});

/**
 * The one query parameter on the ticket list whose default hides rows, and the
 * only place that decision is written down.
 *
 * It lives in the schema rather than in the route so that every caller inherits
 * it — the SPA, a `curl`, and the count query that produces the page numbers.
 * A default applied in the handler would be one the response's `total` could
 * disagree with, which is a page counter that lies.
 *
 * Pinned here because the failure is silent in the direction that matters: a
 * default that drifted to `all` would put every ticket the assistant is
 * midway through answering back into the queue, where an agent answers the
 * student a second time. Nothing on screen would look wrong.
 */
describe("listTicketsQuerySchema handledBy", () => {
  it("hides the assistant's tickets unless asked otherwise", () => {
    expect(listTicketsQuerySchema.parse({}).handledBy).toBe("human");
  });

  it("takes the other two handlers as given", () => {
    expect(listTicketsQuerySchema.parse({ handledBy: "ai" }).handledBy).toBe(
      "ai",
    );
    expect(listTicketsQuerySchema.parse({ handledBy: "all" }).handledBy).toBe(
      "all",
    );
  });

  /**
   * A handler the domain does not have is a 400 rather than a silent fall back
   * to the default — the same treatment `status` gets. The SPA does fall back,
   * deliberately, but it does so by parsing the URL itself; what reaches the
   * API is always one of the three.
   */
  /**
   * Which states count as the assistant's, and the two that deliberately do
   * not. `escalated` and `failed` both mean the assistant is finished and a
   * human has the ticket — putting either in this list would hide from the
   * queue exactly the tickets that were handed to it, which is the worst
   * possible reading of "don't show tickets the AI is handling".
   */
  it("counts only in-flight and answered tickets as the assistant's", () => {
    expect([...AI_HANDLED_AUTO_RESOLUTIONS].sort()).toEqual([
      "pending",
      "resolved",
    ]);
  });

  it("refuses a handler that is not one of the three", () => {
    expect(
      listTicketsQuerySchema.safeParse({ handledBy: "robot" }).success,
    ).toBe(false);
  });
});

/**
 * The dashboard's time zone, which decides which calendar day each ticket is
 * counted on. It reaches Postgres as an argument to `timezone(…)`, so an
 * unchecked value is a 500 rather than a 400 — and a *wrong* one is worse than
 * either, because the chart still renders and every bar is off by a day.
 */
describe("ticketStatsQuerySchema", () => {
  it("defaults to UTC so a caller that names no zone still gets one", () => {
    expect(ticketStatsQuerySchema.parse({}).tz).toBe("UTC");
  });

  it("accepts an IANA zone", () => {
    expect(ticketStatsQuerySchema.parse({ tz: "Asia/Tehran" }).tz).toBe(
      "Asia/Tehran",
    );
  });

  /**
   * The check is `Intl`'s, which reads the same IANA database Postgres ships —
   * so anything that passes here is a zone the query can actually use.
   */
  it("refuses something that is not a zone", () => {
    expect(
      ticketStatsQuerySchema.safeParse({ tz: "Mars/Olympus_Mons" }).success,
    ).toBe(false);
    expect(
      ticketStatsQuerySchema.safeParse({ tz: "'; drop table ticket --" })
        .success,
    ).toBe(false);
  });
});
