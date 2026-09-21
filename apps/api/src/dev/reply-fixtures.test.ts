import { describe, expect, it } from "bun:test";
import { REPLY_FIXTURES } from "./reply-fixtures.ts";

/** What the thread is made of, counted the way a reader would count it. */
const nonEmptyLines = (body: string) =>
  body.split("\n").filter((line) => line.trim() !== "").length;

/**
 * The fixture's shape is the whole of what it is for, and every way it degrades
 * is silent: a thread that renders perfectly, reads plausibly, and tests
 * nothing. Twelve short messages all from the agent would look like a seeded
 * conversation in the UI and would exercise none of what a long alternating one
 * does.
 */
describe("the seeded conversation", () => {
  it("is twenty messages long", () => {
    expect(REPLY_FIXTURES).toHaveLength(20);
  });

  /**
   * The student's opening message is not in here — it is `ticket.body`, the
   * email that created the ticket — so the thread begins with the answer to it
   * and the sides alternate from there.
   */
  it("alternates strictly, opening with the agent", () => {
    expect(REPLY_FIXTURES.map((f) => f.from)).toEqual(
      Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? "agent" : "student")),
    );
  });

  it("gives both sides the same number of turns", () => {
    const agent = REPLY_FIXTURES.filter((f) => f.from === "agent");
    expect(agent).toHaveLength(10);
    expect(REPLY_FIXTURES.length - agent.length).toBe(10);
  });

  /**
   * Ten lines is where a summary stops being an extract and starts being a
   * judgement about what mattered — which is the thing worth testing. Counted
   * without the blank lines, so paragraph spacing cannot pad a short message
   * into a long one.
   */
  it("gives every message at least ten non-empty lines", () => {
    // Reported as a pair so a failure names the message that is short rather
    // than only the number it fell to.
    const short = REPLY_FIXTURES.map((f, index) => ({
      index,
      lines: nonEmptyLines(f.body),
    })).filter((entry) => entry.lines < 10);

    expect(short).toEqual([]);
  });

  /**
   * A thread on a tidy cadence is one where nobody was waiting, and waiting is
   * most of what a support thread records. The irregularity is also what puts a
   * weekend-shaped hole in the middle of it.
   */
  it("leaves irregular gaps, none of them zero", () => {
    const gaps = REPLY_FIXTURES.map((f) => f.hoursAfter);
    expect(Math.min(...gaps)).toBeGreaterThan(0);
    // More than a handful of distinct gaps, rather than one repeated cadence.
    expect(new Set(gaps).size).toBeGreaterThan(8);
    // At least one pause long enough to read as "nobody looked at this
    // yesterday", which is the case the thread's own text refers to.
    expect(Math.max(...gaps)).toBeGreaterThanOrEqual(24);
  });

  /**
   * The arc matters as much as the shape. A conversation that resolves tidily
   * gives a summariser nothing to put under "Outstanding", so the last word is
   * a question nobody has answered.
   */
  it("ends on an unanswered question from the student", () => {
    const last = REPLY_FIXTURES.at(-1);
    expect(last?.from).toBe("student");
    expect(last?.body).toContain("?");
  });

  it("carries no sign-off name, so the seeder can add the real one", () => {
    // The fixture cannot know which accounts an install has, so it stops at
    // "Best wishes," and seed-replies.ts appends the author's own name.
    for (const fixture of REPLY_FIXTURES) {
      expect(fixture.body.trimEnd().endsWith(",")).toBe(true);
    }
  });
});
