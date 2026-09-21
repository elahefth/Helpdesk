CREATE TYPE "public"."ticket_auto_resolution" AS ENUM('skipped', 'pending', 'resolved', 'escalated', 'failed');--> statement-breakpoint
ALTER TABLE "ticket" ADD COLUMN "auto_resolution" "ticket_auto_resolution" DEFAULT 'skipped' NOT NULL;--> statement-breakpoint
CREATE INDEX "ticket_auto_resolution_idx" ON "ticket" USING btree ("auto_resolution");