ALTER TABLE "workspace" ADD COLUMN "setup_completed_at" timestamp with time zone;--> statement-breakpoint
-- Every workspace made before this was recorded counts as set up, as of when it was made.
UPDATE "workspace" SET "setup_completed_at" = "created_at";--> statement-breakpoint
ALTER TABLE "user" DROP COLUMN "onboarding_completed_at";
