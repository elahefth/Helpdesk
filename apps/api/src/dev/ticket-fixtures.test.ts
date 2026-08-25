import { describe, expect, it } from "bun:test";
import {
  TICKET_CATEGORIES,
  TICKET_STATUSES,
  inboundEmailBodySchema,
} from "@helpdesk/shared";
import { TICKET_FIXTURES } from "./ticket-fixtures.ts";

/**
 * The corpus exists to make sorting and filtering visible, and it stops doing
 * that quietly: a batch of new fixtures that are all `technical`, or all dated
 * this week, leaves every screen still working and every sort looking broken.
 * These pin the spread rather than the contents, so adding or rewording a
 * ticket is free and flattening the distribution is not.
 */
describe("ticket fixtures", () => {
  it("holds a hundred tickets", () => {
    expect(TICKET_FIXTURES).toHaveLength(100);
  });

  /**
   * The seeder delivers these through POST /api/inbound-email, so a fixture
   * that the shared schema rejects is a run that dies partway through with a
   * 400 — after writing some of the corpus and not the rest. Catching it here
   * costs nothing and makes the seeder's own parse a formality.
   */
  it("every fixture is a payload the ingestion endpoint accepts", () => {
    for (const fixture of TICKET_FIXTURES) {
      const parsed = inboundEmailBodySchema.safeParse({
        from: fixture.email,
        ...(fixture.name ? { fromName: fixture.name } : {}),
        to: "support@helpdesk.test",
        subject: fixture.subject,
        text: fixture.body,
        messageId: "<probe@fixtures.helpdesk.test>",
        ...(fixture.category ? { category: fixture.category } : {}),
      });
      // Named in the failure, or a hundred-line diff is all you get.
      expect([fixture.subject, parsed.success]).toEqual([
        fixture.subject,
        true,
      ]);
    }
  });

  it.each(TICKET_STATUSES.map((status) => [status] as const))(
    "has enough %s tickets to fill a page",
    (status) => {
      // The list's default page is 25. A status with fewer than that behind it
      // cannot show the difference between a filter and a short queue.
      expect(
        TICKET_FIXTURES.filter((f) => f.status === status).length,
      ).toBeGreaterThanOrEqual(20);
    },
  );

  it.each(TICKET_CATEGORIES.map((category) => [category] as const))(
    "has a workable number of %s tickets",
    (category) => {
      expect(
        TICKET_FIXTURES.filter((f) => f.category === category).length,
      ).toBeGreaterThanOrEqual(20);
    },
  );

  it("leaves a substantial share unclassified", () => {
    // Nothing in the pipeline classifies, so `null` is the honest majority
    // state; the corpus is a mix only because the category filter needs rows to
    // find. Too few and the NULLS-last ordering has nothing to prove itself on.
    const unclassified = TICKET_FIXTURES.filter((f) => f.category === null);
    expect(unclassified.length).toBeGreaterThanOrEqual(15);
  });

  it("includes senders with no display name", () => {
    // The `coalesce(student_name, student_email)` fallback that the Sender cell
    // and the sender sort both run on. With none of these, both look fine and
    // neither is exercised.
    expect(
      TICKET_FIXTURES.filter((f) => f.name === null).length,
    ).toBeGreaterThanOrEqual(5);
  });

  it("spreads subjects across the alphabet", () => {
    // If every subject started with "Question about…", sorting by subject would
    // be indistinguishable from sorting by the id tiebreaker alone.
    const initials = new Set(
      TICKET_FIXTURES.map((f) => f.subject[0]?.toUpperCase()),
    );
    expect(initials.size).toBeGreaterThanOrEqual(20);
  });

  it("spans months, unevenly, with same-day arrivals", () => {
    const days = TICKET_FIXTURES.map((f) => f.daysAgo);
    expect(Math.max(...days)).toBeGreaterThanOrEqual(120);
    expect(Math.min(...days)).toBeLessThanOrEqual(3);
    // Same-day tickets are what make the date sort's id tiebreaker reachable
    // from the UI rather than only from ticket-sort.test.ts.
    expect(new Set(days).size).toBeLessThan(days.length);
  });

  it("has repeat senders as well as one-offs", () => {
    // A student who writes twice is normal, and it is the only thing that makes
    // a sender sort group rows rather than merely order them.
    const byEmail = new Map<string, number>();
    for (const fixture of TICKET_FIXTURES) {
      byEmail.set(fixture.email, (byEmail.get(fixture.email) ?? 0) + 1);
    }
    expect([...byEmail.values()].filter((n) => n > 1).length).toBeGreaterThan(
      0,
    );
  });
});
