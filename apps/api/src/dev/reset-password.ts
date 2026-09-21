import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { createAuth } from "../auth.ts";
import { closeDb, getDb } from "../db/client.ts";
import { session, user } from "../db/schema.ts";
import { setStaffPassword } from "../routes/users.ts";

/**
 * Sets a staff account's password from the command line.
 *
 * This exists because the console has no password reset and deliberately so:
 * there is no mail provider to send a reset link through, and an unauthenticated
 * "reset my password" endpoint without one is a way to lock other people out
 * rather than a way back in. `PATCH /api/users/:id` is the in-app answer and it
 * is admin-gated — which leaves exactly one hole, and it is the one that
 * matters: the last admin forgetting their own password. Nobody left can reach
 * the route that would fix it.
 *
 * So the way back in is the way the first account was made — in-process, from a
 * shell on the machine that holds the database. That is the same trust boundary
 * `seed.ts` runs on, and it is the honest one: whoever can run this can already
 * read `DATABASE_URL`.
 *
 * Separate from `seed:admin` rather than a flag on it, because `seed.ts`
 * deliberately never touches an existing account's password — re-running a seed
 * must not be a way to silently change credentials. Overwriting one is a
 * deliberate act, so it gets a command that says so:
 *
 *   bun run reset:password -- --email=admin@helpdesk.test --password='new-one'
 *
 * It hashes through `setStaffPassword`, the same function the PATCH route uses,
 * so a password set here verifies against the login form — and it ends the
 * account's sessions for the same reason that route does.
 */

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    password: { type: "string" },
  },
  strict: true,
});

const argsSchema = z.object({
  // Lowercased, because that is how the column is written and how Better Auth
  // looks an address up. A capital here would find nothing and report the
  // account missing — see the email notes in packages/shared/src/api.ts.
  email: z
    .string()
    .email("must be a valid email address")
    .transform((value) => value.toLowerCase()),
  // Better Auth's own floor is 8. Checked here so a too-short password fails
  // before anything is written rather than inside the adapter.
  password: z.string().min(8, "must be at least 8 characters"),
});

const parsed = argsSchema.safeParse({
  email: values.email,
  password: values.password,
});

if (!parsed.success) {
  console.error("Cannot reset — invalid input:");
  console.error(z.prettifyError(parsed.error));
  console.error(
    "\nUsage:\n" +
      "  bun run reset:password -- --email=admin@helpdesk.test --password='new-password'",
  );
  process.exit(1);
}

const { email, password } = parsed.data;

const db = getDb();
if (!db) {
  console.error("Cannot reset — DATABASE_URL is not set.");
  process.exit(1);
}

const auth = createAuth(db);

try {
  const [target] = await db
    .select({
      id: user.id,
      name: user.name,
      role: user.role,
      deletedAt: user.deletedAt,
    })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);

  if (!target) {
    console.error(`No account with the email ${email}.`);
    console.error("Run `bun run seed:admin` to create the first admin.");
    process.exitCode = 1;
  } else if (target.deletedAt) {
    // Refused rather than done anyway. `databaseHooks.session.create.before` in
    // auth.ts turns away a deleted account at sign-in whatever its password is,
    // so writing one here would report success and change nothing an operator
    // could observe — which is the worst of the three possible answers.
    console.error(
      `${email} was deleted on ${target.deletedAt.toISOString()} and cannot sign in.`,
    );
    console.error(
      "Clear user.deleted_at for that row first if the account should come back.",
    );
    process.exitCode = 1;
  } else {
    await setStaffPassword(auth, target.id, password);

    // The same bargain PATCH /api/users/:id makes: a password change has to end
    // the sessions it was meant to shut out. Deleting the rows is enough
    // precisely because auth.ts sets no cookieCache, so the next request
    // re-reads this table and fails.
    const ended = await db
      .delete(session)
      .where(eq(session.userId, target.id))
      .returning({ id: session.id });

    console.log(
      `✓ Password set for ${email} (${target.name}, ${target.role}).`,
    );
    if (ended.length > 0) {
      console.log(`  Ended ${ended.length} existing session(s).`);
    }
    console.log("  Sign in at the WEB_ORIGIN in .env — currently:");
    console.log(`  ${process.env.WEB_ORIGIN ?? "http://localhost:5173"}`);
  }
} catch (error) {
  console.error(
    "Reset failed:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
} finally {
  await closeDb();
}
