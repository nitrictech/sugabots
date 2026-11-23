ALTER TABLE "automation_trigger" DROP CONSTRAINT "automation_trigger_secret_valid", ADD CONSTRAINT "automation_trigger_secret_valid" CHECK ("secret_encrypted" is null or "kind" = 'webhook');--> statement-breakpoint
ALTER TABLE "automation_trigger" DROP CONSTRAINT "automation_trigger_digest_valid";--> statement-breakpoint
ALTER TABLE "automation_trigger" DROP COLUMN "secret_digest";--> statement-breakpoint
ALTER TABLE "computer" ALTER COLUMN "image" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "project_thread" ALTER COLUMN "started_by_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ALTER COLUMN "lead_bot_id" SET NOT NULL;--> statement-breakpoint
-- Checked at commit, which Drizzle can't declare: deleting a bot deletes its
-- default project, which it leads, in the same statement.
ALTER TABLE "project" DROP CONSTRAINT "project_lead_bot_id_bot_id_fkey", ADD CONSTRAINT "project_lead_bot_id_bot_id_fkey" FOREIGN KEY ("lead_bot_id") REFERENCES "bot"("id") DEFERRABLE INITIALLY DEFERRED;
