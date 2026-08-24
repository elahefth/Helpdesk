import { describe, expect, it } from "bun:test";
import { isDuplicateEmail } from "./users.ts";

/**
 * PATCH /api/users/:id turns a unique-violation on `email` into a 409 rather
 * than letting it reach the error handler as a 500. Which error it inspects is
 * the whole trick, and it is not the one the driver throws.
 *
 * These are hand-built shapes rather than errors from a live query, because the
 * suite runs with DATABASE_URL stripped. They are copied from what Bun's driver
 * and Drizzle actually produced against Postgres 17 — `errno` carries the
 * SQLSTATE (`code` is Bun's own constant and useless for this), and Drizzle
 * re-throws inside a DrizzleQueryError that keeps the original on `cause`.
 */
const pgUniqueViolation = () =>
  Object.assign(new Error("duplicate key value violates unique constraint"), {
    code: "ERR_POSTGRES_SERVER_ERROR",
    errno: "23505",
    constraint: "user_email_unique",
  });

const drizzleWrapped = (cause: unknown) =>
  Object.assign(new Error('Failed query: update "user" set ...'), { cause });

describe("isDuplicateEmail", () => {
  it("recognises the driver's own error", () => {
    expect(isDuplicateEmail(pgUniqueViolation())).toBe(true);
  });

  // The regression this exists for: reading errno/constraint off the thrown
  // object alone passes the test above and still 500s on every real duplicate,
  // because Drizzle never rethrows the driver's error unwrapped.
  it("recognises it through Drizzle's wrapper", () => {
    expect(isDuplicateEmail(drizzleWrapped(pgUniqueViolation()))).toBe(true);
  });

  it("ignores a unique violation on some other constraint", () => {
    const other = Object.assign(pgUniqueViolation(), {
      constraint: "session_token_unique",
    });
    expect(isDuplicateEmail(drizzleWrapped(other))).toBe(false);
  });

  it("ignores a different SQLSTATE on the same constraint", () => {
    const notNull = Object.assign(pgUniqueViolation(), { errno: "23502" });
    expect(isDuplicateEmail(drizzleWrapped(notNull))).toBe(false);
  });

  it.each([
    ["a plain error", new Error("boom")],
    ["null", null],
    ["undefined", undefined],
    ["a string", "23505"],
  ])("does not mistake %s for one", (_label, value) => {
    expect(isDuplicateEmail(value)).toBe(false);
  });

  // A cyclic cause is not a shape Drizzle produces; the cap is there so a
  // future wrapper that does cannot hang a request thread.
  it("terminates on a cyclic cause chain", () => {
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(isDuplicateEmail(cyclic)).toBe(false);
  });
});
