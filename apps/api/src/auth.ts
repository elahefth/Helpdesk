import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { USER_ROLES } from "@helpdesk/shared";
import { env, isProduction } from "./env.ts";
import type { Database } from "./db/client.ts";
import * as schema from "./db/schema.ts";

/**
 * A factory rather than a module-level singleton: `getDb()` is deliberately
 * lazy and may return undefined (see db/client.ts), and Better Auth needs a
 * concrete database. Taking the handle as an argument keeps the "API boots
 * without Postgres" contract intact.
 *
 * No secondaryStorage and no session.cookieCache — that is what puts sessions
 * in the `session` table rather than in the cookie, which is the whole point:
 * an admin revokes an agent by deleting a row.
 */
export function createAuth(db: Database) {
  return betterAuth({
    appName: "Helpdesk",
    basePath: "/api/auth",
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.WEB_ORIGIN],
    database: drizzleAdapter(db, { provider: "pg", schema }),
    emailAndPassword: { enabled: true },
    user: {
      additionalFields: {
        // `input: false` so a self-registering user cannot hand themselves
        // "admin". Values come from @helpdesk/shared so the API and the SPA
        // cannot drift.
        role: {
          type: [...USER_ROLES],
          defaultValue: "agent",
          input: false,
        },
      },
    },
    advanced: {
      // userSchema in @helpdesk/shared constrains `id` to a UUID; Better
      // Auth's default id format is not one.
      database: { generateId: "uuid" },
      useSecureCookies: isProduction,
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
