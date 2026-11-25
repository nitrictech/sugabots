ALTER TABLE "automation" ADD COLUMN "pause_after_failures_pending_at" timestamp with time zone;--> statement-breakpoint
UPDATE "automation" SET "pause_after_failures_pending_at" = "updated_at" WHERE "pause_after_failures_pending";--> statement-breakpoint
DROP INDEX "automation_pending_pause_idx";--> statement-breakpoint
ALTER TABLE "automation" DROP COLUMN "pause_after_failures_pending";--> statement-breakpoint
CREATE INDEX "automation_pending_pause_idx" ON "automation" ("id") WHERE "pause_after_failures_pending_at" is not null;
