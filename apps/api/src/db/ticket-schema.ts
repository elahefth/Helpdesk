import { sql } from "drizzle-orm";
import {
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { TICKET_CATEGORIES, TICKET_STATUSES } from "@helpdesk/shared";

/**
 * Hand-written, unlike auth-schema.ts — `@better-auth/cli generate` owns that
 * file and would drop anything added to it. This one is ours, so it lives
 * beside it rather than inside it.
 *
 * The enums are built from the shared tuples rather than restated, which is
 * what makes `packages/shared` the contract in the database too: adding a
 * status there and forgetting the migration is a diff drizzle-kit generates,
 * not a value the API can write and Postgres will refuse.
 */
export const ticketStatusEnum = pgEnum("ticket_status", TICKET_STATUSES);
export const ticketCategoryEnum = pgEnum("ticket_category", TICKET_CATEGORIES);

export const ticket = pgTable(
  "ticket",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),

    /** Normalised to "(no subject)" by the shared schema, never empty. */
    subject: text("subject").notNull(),

    /** The sender. Lowercased on the way in — see inboundEmailBodySchema. */
    studentEmail: text("student_email").notNull(),

    /**
     * The display name off the From header. Nullable: plenty of mail carries a
     * bare address, and it is not an identity — two people can send under the
     * same name, and one person can change theirs between emails. The address
     * is what `ticket_student_email_idx` groups by; this is only ever rendered.
     */
    studentName: text("student_name"),

    /**
     * The support address it was delivered to. Stored rather than assumed from
     * config: SUPPORT_EMAIL can change, and a ticket should still say which
     * mailbox it actually arrived at.
     */
    supportEmail: text("support_email").notNull(),

    /** The plain-text email body, verbatim apart from a trim. */
    body: text("body").notNull(),

    status: ticketStatusEnum("status").default("open").notNull(),

    /**
     * Nullable, and that is the feature: nothing classifies. Only a sender that
     * stated a category, or a human, ever sets it.
     */
    category: ticketCategoryEnum("category"),

    /**
     * The provider's Message-ID, UNIQUE so a redelivered webhook cannot create
     * a second ticket. Nullable because not every source has one, and Postgres
     * treats NULLs as distinct under a unique index — so unidentified mail is
     * simply never deduplicated, rather than colliding with the last one.
     */
    sourceMessageId: text("source_message_id").unique(),

    /**
     * When the mail was received, per the source. Distinct from `createdAt`:
     * replaying an archive weeks later must not make every ticket look like it
     * arrived today, and this is the column the queue is ordered by.
     */
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),

    /**
     * `withTimezone`, unlike the generated auth tables. Those are
     * `timestamp without time zone`, which the driver round-trips through the
     * host's local offset — harmless for display, and exactly wrong for a
     * keyset cursor, where an hour of drift silently skips or repeats rows at
     * every page boundary. The ticket list pages on these columns, so they are
     * timestamptz and the comparison is unambiguous.
     */
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    // The list's two sort orders. `id` is in each index for the same reason it
    // is in the cursor: timestamps are not unique, so the tiebreaker is part of
    // the ordering rather than an afterthought.
    index("ticket_created_at_id_idx").on(table.createdAt, table.id),
    index("ticket_updated_at_id_idx").on(table.updatedAt, table.id),
    index("ticket_status_idx").on(table.status),
    index("ticket_student_email_idx").on(table.studentEmail),
  ],
);
