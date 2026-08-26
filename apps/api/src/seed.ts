import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { USER_ROLES, userRoleSchema } from "@helpdesk/shared";
import { createAuth } from "./auth.ts";
import { closeDb, getDb } from "./db/client.ts";
import { user } from "./db/schema.ts";

/**
 * Creates a staff account. Sign-up over HTTP is closed (see the databaseHooks
 * gate in auth.ts), so this is the supported way to make the first admin —
 * Better Auth is driven in-process, where that gate deliberately does not fire.
 *
 * Credentials come from SEED_ADMIN_* in .env, overridable per-flag:
 *   bun run seed:admin
 *   bun run seed:admin -- --email=me@helpdesk.test --name="Eli" --role=agent
 *
 * Re-running is safe: an existing account keeps its password and only has its
 * role corrected. Changing a password is a deliberate act, not a side effect
 * of seeding.
 */

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    password: { type: "string" },
    name: { type: "string" },
    role: { type: "string" },
  },
  strict: true,
});

const argsSchema = z.object({
  email: z.string().email("must be a valid email address"),
  // Better Auth's own floor is 8; being explicit gives a better error than a
  // failed API call three steps later.
  password: z.string().min(8, "must be at least 8 characters"),
  name: z.string().min(1, "must not be empty"),
  role: userRoleSchema,
});

const parsed = argsSchema.safeParse({
  email: values.email ?? process.env.SEED_ADMIN_EMAIL,
  password: values.password ?? process.env.SEED_ADMIN_PASSWORD,
  name: values.name ?? process.env.SEED_ADMIN_NAME ?? "Admin",
  role: values.role ?? "admin",
});

if (!parsed.success) {
  console.error("Cannot seed — invalid input:");
  console.error(z.prettifyError(parsed.error));
  console.error(
    `\nSet SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD in .env, or pass` +
      ` --email/--password.\nValid roles: ${USER_ROLES.join(", ")}`,
  );
  process.exit(1);
}

const { email, password, name, role } = parsed.data;

const db = getDb();
if (!db) {
  console.error("Cannot seed — DATABASE_URL is not set.");
  process.exit(1);
}

const auth = createAuth(db);

try {
  const [existing] = await db
    .select({ id: user.id, role: user.role })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);

  if (existing) {
    if (existing.role === role) {
      console.log(`✓ ${email} already exists with role "${role}" — no change.`);
    } else {
      await db.update(user).set({ role }).where(eq(user.id, existing.id));
      console.log(
        `✓ ${email} already existed — role changed from "${existing.role}" to "${role}".`,
      );
    }
    console.log("  Password left untouched.");
  } else {
    const created = await auth.api.signUpEmail({
      body: { email, password, name },
    });

    // `role` is input: false on the user model, so sign-up cannot set it —
    // that is what stops a self-registering user handing themselves "admin".
    // Seeding is trusted, so it writes the role directly afterwards.
    await db.update(user).set({ role }).where(eq(user.id, created.user.id));

    console.log(`✓ Created ${email} with role "${role}".`);
    console.log(`  id: ${created.user.id}`);
  }
} catch (error) {
  console.error(
    "Seeding failed:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
} finally {
  await closeDb();
}
