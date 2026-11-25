ALTER TABLE "turn" ADD COLUMN "end_requested" text;--> statement-breakpoint
-- Why a turn was asked to end wasn't kept before; each one asked keeps that it was.
UPDATE "turn" SET "end_requested" = 'interrupted' WHERE "interrupt_requested";--> statement-breakpoint
ALTER TABLE "turn" DROP COLUMN "interrupt_requested";--> statement-breakpoint
ALTER TABLE "turn" ADD CONSTRAINT "turn_end_requested_valid" CHECK ("end_requested" in ('interrupted', 'run_ended', 'lost_reach', 'approval_expired'));
