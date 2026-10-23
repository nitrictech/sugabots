ALTER TABLE "agent" ADD COLUMN "a2a_url" text;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "a2a_secret_header" text;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "a2a_secret_encrypted" text;--> statement-breakpoint
ALTER TABLE "turn" ALTER COLUMN "model" DROP NOT NULL;