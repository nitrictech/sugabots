ALTER TABLE "user" ADD COLUMN "referred_by" uuid;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "referral_link_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "user_referred_by_idx" ON "user" ("referred_by");--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_referred_by_user_id_fkey" FOREIGN KEY ("referred_by") REFERENCES "user"("id") ON DELETE SET NULL;