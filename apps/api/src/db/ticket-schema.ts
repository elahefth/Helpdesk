import { sql } from "drizzle-orm";
import {
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import {
  TICKET_CATEGORIES,
  TICKET_CLASSIFICATIONS,
  TICKET_STATUSES,
} from "@helpdesk/shared";
import { user } from "./auth-schema.ts";

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
export const ticketClassificationEnum = pgEnum(
  "ticket_classification",
  TICKET_CLASSIFICATIONS,
);

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
     * What the automatic classifier did with this row — see
     * `TICKET_CLASSIFICATIONS` for what each value means.
     *
     * **The default is `skipped`, not `pending`, and that is load-bearing.**
     * Every ticket that existed before this column did gets the default on
     * migration, and `pending` would have marked the whole back catalogue as
     * waiting on a classifier that is never going to run — a hundred rows
     * reading "Classifying…" forever, and, worse, a hundred rows the boot
     * sweep in `ticket-classification.ts` would dutifully pick up and spend a
     * model call on. `skipped` says the true thing about them: nobody asked.
     * Ingestion writes `pending` explicitly, in the same INSERT that creates
     * the row, so a ticket is never briefly-default before being marked.
     *
     * No index, on the policy this file already applies to `assigned_to_id`:
     * the one query that filters on it is the boot sweep, which runs once per
     * process against a table this size. A "show me what failed" filter in the
     * queue is what would justify one.
     */
    classification: ticketClassificationEnum("classification")
      .default("skipped")
      .notNull(),

    /**
     * The staff member who owns this ticket, or NULL for the unassigned pool
     * every ticket arrives in — nothing routes, so an owner is always a human
     * decision and a default would be a guess wearing one's clothes.
     *
     * `on delete set null` rather than `cascade` (which would delete tickets)
     * or `restrict` (which would make a user undeletable). It should never
     * fire: DELETE /api/users/:id is a soft delete and marks the row instead,
     * so the constraint covers only the case where someone removes a row by
     * hand. That route does the same thing by hand for the case that actually
     * happens — it clears this column for every ticket the deleted account
     * owned, in the transaction that marks the row. An assignee is a claim on
     * work nobody is going to do once its owner cannot sign in, unlike
     * `ticket_reply.author_id`, which records something that already happened
     * and therefore stays.
     *
     * No index, on the same reasoning the search's `ilike` carries: nothing
     * queries by this column yet. The queue neither shows nor filters by the
     * assignee, so an index here would be a write cost bought against a query
     * plan that does not exist. An "assigned to" filter is what justifies one.
     */
    assignedToId: uuid("assigned_to_id").references(() => user.id, {
      onDelete: "set null",
    }),

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
     * arrived today.
     */
    receivedAt: timestamp("received_at", {
      withTimezone: true,
      precision: 3,
    }).notNull(),

    /**
     * `withTimezone`, unlike the generated auth tables. Those are
     * `timestamp without time zone`, which the driver round-trips through the
     * host's local offset — harmless for display, and exactly wrong for a
     * keyset cursor, where an hour of drift silently skips or repeats rows at
     * every page boundary. The ticket list pages on these columns, so they are
     * timestamptz and the comparison is unambiguous.
     *
     * **`precision: 3` is load-bearing for the same pagination**, and its
     * absence fails in a way that looks nothing like a precision problem.
     * Postgres defaults to microseconds; a JS `Date` holds milliseconds, so the
     * driver truncates on the way out and a cursor built from a row is a hair
     * *below* the row it names. Descending, that hair is harmless — the row is
     * already past. Ascending, the row still satisfies "after the cursor", so
     * it is returned again, and again: the list pages forever on one row. That
     * is what `apps/api/src/routes/ticket-sort.test.ts` pins, and why the
     * column stores only what a Date can represent rather than the query
     * rounding at every comparison and giving up the index.
     */
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 })
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

/**
 * A staff reply on a ticket's thread.
 *
 * The ticket's own `body` is the email that created it and is not part of this
 * table — one delivered email is still one ticket, and the thread is what the
 * support team has said back. So the detail page renders `ticket.body` first
 * and these under it, rather than the two being rows of one uniform message
 * table. That table is what a *student* reply would need (an author who is not
 * a `user`, a direction, a source message id), and nothing ingests one yet:
 * `POST /api/inbound-email` always opens a new ticket. Merging the two now
 * would be a schema shaped for an integration nobody has written.
 *
 * Nothing here is delivered anywhere. There is no email provider in this repo,
 * so writing a reply records what was said and does not send it — the same gap
 * `dev/send-inbound-email.ts` stands in for on the way in.
 */
export const ticketReply = pgTable(
  "ticket_reply",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),

    /**
     * `cascade`, unlike `ticket.assigned_to_id`'s `set null`, and the asymmetry
     * is the difference between a reference and a part. A reply is only ever
     * about one ticket and means nothing without it, so a deleted ticket must
     * not leave its thread behind as unreachable rows. Nothing deletes a ticket
     * today; this says what happens when something does.
     */
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => ticket.id, { onDelete: "cascade" }),

    /**
     * Who wrote it. NOT NULL and with no `onDelete` clause — so the default,
     * NO ACTION — which are two halves of one rule: a reply always names its
     * author. `set null` would be the assignee's answer and is wrong here,
     * because "somebody on the team said this" is not something a thread can
     * usefully record, and `cascade` would delete what was said along with the
     * person who said it.
     *
     * It should never fire either way: `DELETE /api/users/:id` is a soft delete
     * and the row survives precisely so past work can still name who did it. A
     * departed colleague keeps their replies and keeps their byline, the same
     * way they stay assigned to their tickets.
     */
    authorId: uuid("author_id")
      .notNull()
      .references(() => user.id),

    /** The reply text, verbatim apart from a trim. Plain text, like the email. */
    body: text("body").notNull(),

    /**
     * `timestamptz` with `precision: 3`, matching `ticket` rather than the
     * generated auth tables. The thread is ordered by it, so the reasons are
     * the same ones spelled out on `ticket.createdAt` — a naive timestamp
     * round-tripped through the host's offset and a microsecond column
     * truncated into a JS `Date` both go wrong silently.
     *
     * There is no `updatedAt`, and its absence is the shape of the feature: a
     * reply is a thing that was said, so there is no route that edits one. Add
     * the column when there is an editor to justify it.
     */
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // The only query there is: one ticket's thread, oldest first. `id` rides
    // along as the tiebreaker for the same reason it does in the queue's
    // indexes — two replies posted in the same millisecond are not ordered by
    // `created_at` alone, and a thread that reshuffles between reloads reads as
    // a bug in the conversation.
    index("ticket_reply_ticket_id_created_at_id_idx").on(
      table.ticketId,
      table.createdAt,
      table.id,
    ),
  ],
);
