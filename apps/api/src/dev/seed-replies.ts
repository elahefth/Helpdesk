import { parseArgs } from "node:util";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { closeDb, getDb } from "../db/client.ts";
import { ticket, ticketReply, user } from "../db/schema.ts";
import { REPLY_FIXTURES } from "./reply-fixtures.ts";

/**
 * Loads one long conversation onto a ticket, so there is something in the
 * database that behaves like a ticket somebody has been working for a
 * fortnight.
 *
 *   bun run seed:replies -- --ticket=<uuid>
 *   bun run seed:replies -- --ticket=<uuid> --reset --agent=agent@helpdesk.test
 *
 * ## The thing to know before reading further
 *
 * **`ticket_reply.author_id` is NOT NULL and references `user`, so this schema
 * has no way to store a message from a student.** That is deliberate and
 * documented — a reply table with a student author needs a direction, a source
 * message id and an author who is not a `user`, which is a message table shaped
 * for an ingestion path nobody has written. Inbound mail always opens a *new*
 * ticket; it never lands in a thread.
 *
 * So an alternating conversation cannot be seeded honestly without inventing
 * something. What this script invents is a **stand-in user row for the
 * student**, marked deleted at the moment it is created, and it is worth
 * saying exactly why that is the safe choice rather than a fudge:
 *
 * - `GET /api/assignees` and `GET /api/users` both filter `isNull(deletedAt)`,
 *   so the student never appears in the assignee picker or the admin
 *   directory. A ticket cannot be handed to them by accident.
 * - `databaseHooks.session.create.before` in `auth.ts` refuses a session to a
 *   deleted account, so the row cannot sign in. It is also created with no
 *   `account` row at all, so there is no password to sign in *with* — the
 *   deletion is the second lock, not the only one.
 * - The thread's own query inner-joins `user` and deliberately does **not**
 *   filter `deletedAt`, precisely so a departed author keeps their byline.
 *   That is what makes the student's turns render.
 *
 * In other words the stand-in is invisible everywhere a staff account would be
 * visible, and visible in the one place a name is needed. The honest limitation
 * is that the *SPA cannot tell the two apart*: there is no direction column, so
 * a student's turn renders in the same card as an agent's, and the thread reads
 * as a conversation because of the names and the words rather than because the
 * app knows. Making the UI show a real inbound/outbound distinction is the
 * schema change this script is deliberately not making.
 *
 * ## Why it writes directly rather than through the API
 *
 * `dev/seed-tickets.ts` posts to the real endpoint and only reaches around it
 * to backdate rows. This one cannot: `POST /api/tickets/:id/replies` takes its
 * author from the session, which is the whole point of that route, and there is
 * no session a student could ever hold. The timestamps would need the direct
 * write regardless — every fixture is deliberately in the past, and the route
 * stamps `now()`.
 */

const { values } = parseArgs({
  options: {
    ticket: { type: "string" },
    agent: { type: "string" },
    reset: { type: "boolean" },
  },
  strict: true,
});

const argsSchema = z.object({
  ticketId: z.string().uuid("must be a ticket UUID"),
  agentEmail: z
    .string()
    .email()
    .transform((value) => value.toLowerCase())
    .optional(),
  reset: z.boolean().default(false),
});

const parsed = argsSchema.safeParse({
  ticketId: values.ticket,
  agentEmail: values.agent,
  reset: values.reset ?? false,
});

if (!parsed.success) {
  console.error("Cannot seed replies — invalid input:");
  console.error(z.prettifyError(parsed.error));
  console.error(
    "\nUsage:\n" +
      "  bun run seed:replies -- --ticket=<uuid> [--agent=<email>] [--reset]",
  );
  process.exit(1);
}

const { ticketId, agentEmail, reset } = parsed.data;

const db = getDb();
if (!db) {
  console.error("Cannot seed replies — DATABASE_URL is not set.");
  process.exit(1);
}

/**
 * The student's stand-in author, found or created.
 *
 * Keyed on a `student.` prefixed address rather than the student's real one,
 * and that is not decoration. `user.email` is UNIQUE, and a real student who
 * later becomes staff would collide with this row — and because a deleted
 * user keeps its email, `POST /api/users` would refuse to create their actual
 * account, with a message about a deleted user that nobody could explain.
 * The prefix keeps the stand-in in a namespace no real account uses.
 *
 * `deletedAt` is stamped in the same insert rather than by a later update, so
 * there is no window in which a live, password-less account exists.
 */
async function findOrCreateStudentAuthor(name: string | null, email: string) {
  const standInEmail = `student.${email}`;

  const [existing] = await db!
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, standInEmail))
    .limit(1);

  if (existing) return existing.id;

  const [created] = await db!
    .insert(user)
    .values({
      name: name ?? email,
      email: standInEmail,
      emailVerified: false,
      // Never a live account, not for an instant. See the header.
      deletedAt: new Date(),
      role: "agent",
    })
    .returning({ id: user.id });

  if (!created) throw new Error("could not create the student stand-in");
  return created.id;
}

try {
  const [target] = await db
    .select({
      id: ticket.id,
      subject: ticket.subject,
      studentName: ticket.studentName,
      studentEmail: ticket.studentEmail,
      createdAt: ticket.createdAt,
    })
    .from(ticket)
    .where(eq(ticket.id, ticketId))
    .limit(1);

  if (!target) {
    console.error(`No ticket with id ${ticketId}.`);
    process.exit(1);
  }

  // The agent side of the conversation. Named explicitly, or the oldest live
  // staff account — deterministic either way, because a thread whose author
  // changes between runs is a fixture that is not one.
  const [agent] = await db
    .select({ id: user.id, name: user.name, email: user.email })
    .from(user)
    .where(
      and(
        isNull(user.deletedAt),
        agentEmail ? eq(user.email, agentEmail) : undefined,
      ),
    )
    .orderBy(asc(user.createdAt))
    .limit(1);

  if (!agent) {
    console.error(
      agentEmail
        ? `No live staff account with the email ${agentEmail}.`
        : "No live staff account to write the agent's half of the conversation.",
    );
    console.error("Run `bun run seed:admin` first.");
    process.exit(1);
  }

  const [existing] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(ticketReply)
    .where(eq(ticketReply.ticketId, ticketId));

  const already = existing?.count ?? 0;

  if (already > 0 && !reset) {
    // Refused rather than appended. Running this twice would interleave two
    // copies of the same conversation by timestamp, which is a thread that
    // reads as broken rather than as long — and unlike the ticket corpus there
    // is no unique column here to make a rerun idempotent on.
    console.error(
      `Ticket already has ${already} repl${already === 1 ? "y" : "ies"}.`,
    );
    console.error("Pass --reset to replace them with the seeded conversation.");
    process.exit(1);
  }

  if (already > 0) {
    await db.delete(ticketReply).where(eq(ticketReply.ticketId, ticketId));
    console.error(
      `Removed ${already} existing repl${already === 1 ? "y" : "ies"}.`,
    );
  }

  const studentAuthorId = await findOrCreateStudentAuthor(
    target.studentName,
    target.studentEmail,
  );

  const studentName = target.studentName ?? target.studentEmail;

  // Walked forward from the ticket's own creation, so the first answer comes
  // after the email that asked for it. `hoursAfter` is a gap, not an offset,
  // which is what keeps the sequence monotonic however the fixtures are edited.
  let at = target.createdAt.getTime();

  const rows = REPLY_FIXTURES.map((fixture) => {
    at += fixture.hoursAfter * 60 * 60 * 1000;
    const isAgent = fixture.from === "agent";
    return {
      ticketId,
      authorId: isAgent ? agent.id : studentAuthorId,
      // The sign-off names whoever is actually speaking, so the fixture text
      // stays independent of which accounts a given install happens to have.
      body: `${fixture.body}\n${isAgent ? agent.name : studentName}`,
      createdAt: new Date(at),
    };
  });

  const last = rows.at(-1);
  if (last && last.createdAt.getTime() > Date.now()) {
    console.error(
      `Refusing to seed: the conversation would end at ${last.createdAt.toISOString()}, in the future.`,
    );
    console.error("The ticket is too recent for a fortnight-long thread.");
    process.exit(1);
  }

  await db.insert(ticketReply).values(rows);

  /*
   * `ticket.updatedAt` is deliberately left alone, for the reason
   * POST /api/tickets/:id/replies leaves it alone: it is `$onUpdate`, and the
   * queue's default sort is on it, so touching the ticket here would jump a
   * seeded ticket to the top of the queue and misrepresent what the seeding
   * did. The thread is what changed, not the ticket.
   */

  const agentTurns = REPLY_FIXTURES.filter((f) => f.from === "agent").length;

  console.log(`✓ Seeded ${rows.length} replies on "${target.subject}".`);
  console.log(
    `  ${agentTurns} from ${agent.name} <${agent.email}>, ${rows.length - agentTurns} from ${studentName}.`,
  );
  console.log(
    `  ${rows[0]?.createdAt.toISOString().slice(0, 16).replace("T", " ")} → ${last?.createdAt.toISOString().slice(0, 16).replace("T", " ")}`,
  );
  console.log(`  http://localhost:5173/tickets/${ticketId}`);
} catch (error) {
  console.error(
    "Seeding replies failed:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
} finally {
  await closeDb();
}
