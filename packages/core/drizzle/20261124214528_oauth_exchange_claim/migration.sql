ALTER TABLE "connector" ADD COLUMN "oauth_exchange_id" uuid;--> statement-breakpoint
ALTER TABLE "connector" ADD COLUMN "oauth_exchange_until" timestamp with time zone;