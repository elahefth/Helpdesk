import { describe, expect, it } from "bun:test";
import { listTicketsQuerySchema } from "@helpdesk/shared";
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
