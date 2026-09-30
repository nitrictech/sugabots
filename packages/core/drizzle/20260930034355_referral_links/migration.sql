ALTER TABLE "user" ADD COLUMN "referred_by" uuid;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "referral_code" text;--> statement-breakpoint
CREATE UNIQUE INDEX "user_referral_code_idx" ON "user" ("referral_code");--> statement-breakpoint
CREATE INDEX "user_referred_by_idx" ON "user" ("referred_by");--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_referred_by_user_id_fkey" FOREIGN KEY ("referred_by") REFERENCES "user"("id") ON DELETE SET NULL;