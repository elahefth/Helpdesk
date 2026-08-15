import { pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { USER_ROLES } from "@helpdesk/shared";

/**
 * Phase 1 lands the full domain model (tickets, messages, kb_articles,
 * ai_calls, outbound_messages). This file starts with `users` so migrations
 * and the Drizzle toolchain are wired and verifiable from day one.
 *
 * The enum values come from @helpdesk/shared — the database and the SPA
 * cannot drift apart.
 */

export const userRoleEnum = pgEnum("user_role", USER_ROLES);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: userRoleEnum("role").notNull().default("agent"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
});

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
