CREATE TYPE "public"."ticket_category" AS ENUM('general_questions', 'technical', 'refund_request');--> statement-breakpoint
CREATE TYPE "public"."ticket_status" AS ENUM('open', 'resolved', 'closed');--> statement-breakpoint
CREATE TABLE "ticket" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"subject" text NOT NULL,
	"student_email" text NOT NULL,
	"support_email" text NOT NULL,
	"body" text NOT NULL,
	"status" "ticket_status" DEFAULT 'open' NOT NULL,
	"category" "ticket_category",
	"source_message_id" text,
	"received_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_source_message_id_unique" UNIQUE("source_message_id")
);
--> statement-breakpoint
CREATE INDEX "ticket_created_at_id_idx" ON "ticket" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "ticket_updated_at_id_idx" ON "ticket" USING btree ("updated_at","id");--> statement-breakpoint
CREATE INDEX "ticket_status_idx" ON "ticket" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ticket_student_email_idx" ON "ticket" USING btree ("student_email");