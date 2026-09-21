/**
 * Loads the committed fixture corpus into the dev database.
 *
 * Two passes, and the split is the honest part:
 *
 * 1. **Delivery goes through `POST /api/inbound-email`**, exactly as a mail
 *    provider would. This is not ceremony — it means the seeded queue is made
 *    of tickets the real ingestion path produced, so anything the endpoint
 *    normalises (lowercased addresses, the "(no subject)" fallback, the
 *    duplicate guard) is true of the corpus too. `receivedAt` is part of that
 *    payload, so the arrival times are real ingestion, not a fix-up.
 *
 * 2. **`created_at`, `updated_at` and `status` are then written directly.**
 *    Nothing over HTTP can set them: ingestion stamps `created_at` with the
 *    row's default and every ticket is born `open`, and there is no
 *    status-change endpoint yet. Reaching around the API for those three
 *    columns is the alternative to a corpus where all hundred tickets were
 *    created this afternoon and none has ever been resolved — which would make
 *    the date sort and the status filter untestable by eye. When a
 *    `PATCH /api/tickets/:id` lands, the status half of this belongs there.
 *
 * Idempotent: every fixture carries a deterministic Message-ID, so the endpoint
 * answers 200 with the existing ticket on a rerun rather than creating a
 * second, and the backdating pass is a set of absolute values rather than a
 * relative shift.
 *
 * Classification is **off** by default, and that is the third place this script
 * deliberately differs from a real delivery. The fixtures' categories are data:
 * the ~18% left null are there so the category sort has a NULLS-last tail to
 * prove itself on, and letting the classifier fill them in would spend a model
 * call per unclassified fixture to destroy the property the corpus exists to
 * demonstrate — differently on every run, since a model is not a fixture. Pass
 * `--classify` to watch the real thing work on a hundred real emails.
 *
 *   bun run seed:tickets
 *   bun run seed:tickets -- --reset      # delete every ticket first
 *   bun run seed:tickets -- --classify   # let the AI classifier see them
 */
import { eq, sql } from "drizzle-orm";
import { inboundEmailBodySchema, type TicketStatus } from "@helpdesk/shared";
import { closeDb, getDb } from "../db/client.ts";
import { ticket } from "../db/schema.ts";
import { env } from "../env.ts";
import { TICKET_FIXTURES, type TicketFixture } from "./ticket-fixtures.ts";

const apiUrl = `http://localhost:${env.PORT}`;
const reset = process.argv.includes("--reset");
const classify = process.argv.includes("--classify");

/** `<seed-007@fixtures.helpdesk.test>` — stable across runs, which is the point. */
function messageIdFor(index: number): string {
  return `<seed-${String(index + 1).padStart(3, "0")}@fixtures.helpdesk.test>`;
}

/**
 * Anchored to today's midnight rather than to `Date.now()`, so two runs on the
 * same day produce the same timestamps and the corpus does not drift a few
 * seconds later every time someone reseeds.
 *
 * The per-ticket minute offset spreads arrivals across a working day. It is
 * derived from the index rather than random, for the same reason.
 */
function timestampFor(fixture: TicketFixture, index: number): Date {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);

  const at = new Date(midnight);
  at.setDate(at.getDate() - fixture.daysAgo);
  // 09:00 plus up to ~8 hours, stepped so same-day tickets still differ.
  at.setHours(9, (index * 37) % 480, (index * 17) % 60, 0);
  return at;
}

/**
 * When a ticket was last touched. Equal to creation for anything still open —
 * nobody has done anything to it — and later for the rest, which is what gives
 * the `updatedAt` sort a shape of its own rather than a copy of `createdAt`.
 */
function updatedAtFor(
  createdAt: Date,
  status: TicketStatus,
  index: number,
): Date {
  if (status === "open") return createdAt;
  const worked = new Date(createdAt);
  worked.setHours(
    worked.getHours() + (status === "resolved" ? 6 : 30) + (index % 19),
  );
  // Never in the future, however old the fixture is.
  return worked > new Date() ? new Date() : worked;
}

const db = getDb();
if (!db) {
  console.error("DATABASE_URL is not set — run with: bun run seed:tickets");
  process.exit(1);
}

// Fail before delivering a hundred emails into a void, rather than after.
const health = await fetch(`${apiUrl}/healthz`).catch(() => null);
if (!health?.ok) {
  console.error(`No API on ${apiUrl}. Start it with: bun run dev:api`);
  process.exit(1);
}

if (reset) {
  const deleted = await db.delete(ticket).returning({ id: ticket.id });
  console.error(`Deleted ${deleted.length} existing ticket(s).`);
}

const secret = env.INBOUND_EMAIL_SECRET;
let created = 0;
let existing = 0;

for (const [index, fixture] of TICKET_FIXTURES.entries()) {
  const receivedAt = timestampFor(fixture, index);

  // Parsed with the same schema the route parses with, so a malformed fixture
  // is a message on this terminal rather than a 400 to read out of a log.
  const body = inboundEmailBodySchema.parse({
    from: fixture.email,
    ...(fixture.name ? { fromName: fixture.name } : {}),
    to: env.SUPPORT_EMAIL,
    subject: fixture.subject,
    text: fixture.body,
    messageId: messageIdFor(index),
    receivedAt: receivedAt.toISOString(),
    ...(fixture.category ? { category: fixture.category } : {}),
  });

  const response = await fetch(`${apiUrl}/api/inbound-email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret ? { "x-inbound-secret": secret } : {}),
      // See the header's own note in routes/inbound-email.ts: a bulk replay of
      // mail whose categories are already decided should not pay for a model
      // call per message, nor rewrite a committed corpus's shape.
      ...(classify ? {} : { "x-skip-classification": "1" }),
      // Always, with no flag to turn it off — unlike classification above.
      // Letting the assistant see a hundred committed fixtures would write a
      // hundred replies to addresses out of a fixture file and resolve a
      // hundred tickets, taking the corpus's status spread with them. See the
      // header's own note in routes/inbound-email.ts.
      "x-skip-auto-resolve": "1",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    console.error(`\n${fixture.subject}: ${response.status}`);
    console.error(
      JSON.stringify(await response.json().catch(() => null), null, 2),
    );
    process.exit(1);
  }

  if (response.status === 201) created += 1;
  else existing += 1;

  // The backdating pass. `updatedAt` is set explicitly in the same statement as
  // everything else because the column carries an `$onUpdate` — leaving it out
  // would have Drizzle stamp it with now() and undo the point of the exercise.
  const createdAt = receivedAt;
  await db
    .update(ticket)
    .set({
      status: fixture.status,
      createdAt,
      updatedAt: updatedAtFor(createdAt, fixture.status, index),
    })
    .where(eq(ticket.sourceMessageId, body.messageId!));

  if ((index + 1) % 20 === 0) {
    console.error(`  … ${index + 1}/${TICKET_FIXTURES.length}`);
  }
}

const [summary] = await db
  .select({
    total: sql<number>`count(*)::int`,
    open: sql<number>`count(*) filter (where ${ticket.status} = 'open')::int`,
    resolved: sql<number>`count(*) filter (where ${ticket.status} = 'resolved')::int`,
    closed: sql<number>`count(*) filter (where ${ticket.status} = 'closed')::int`,
    unclassified: sql<number>`count(*) filter (where ${ticket.category} is null)::int`,
    nameless: sql<number>`count(*) filter (where ${ticket.studentName} is null)::int`,
    oldest: sql<string>`min(${ticket.createdAt})::text`,
    newest: sql<string>`max(${ticket.createdAt})::text`,
  })
  .from(ticket);

console.error(
  `\n${created} created, ${existing} already present (idempotent rerun).`,
);
console.error(
  `${summary?.total} tickets: ${summary?.open} open, ${summary?.resolved} resolved, ${summary?.closed} closed`,
);
console.error(
  `${summary?.unclassified} unclassified, ${summary?.nameless} with no sender name`,
);
console.error(
  `spanning ${summary?.oldest?.slice(0, 10)} → ${summary?.newest?.slice(0, 10)}`,
);

await closeDb();
