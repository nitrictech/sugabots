ALTER TABLE "computer" ADD COLUMN "intent_id" uuid;--> statement-breakpoint
ALTER TABLE "computer" ADD COLUMN "intent_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "computer" ADD CONSTRAINT "computer_intent_check" CHECK (("intent_id" is null) = ("intent_expires_at" is null));