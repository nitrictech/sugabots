ALTER TABLE "user" ADD COLUMN "referral_code" text;--> statement-breakpoint
ALTER TABLE "user" DROP COLUMN "referral_link_version";--> statement-breakpoint
CREATE UNIQUE INDEX "user_referral_code_idx" ON "user" ("referral_code");