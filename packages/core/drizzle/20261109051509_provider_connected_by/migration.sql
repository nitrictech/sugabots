ALTER TABLE "model_provider" ADD COLUMN "connected_by_id" uuid;--> statement-breakpoint
ALTER TABLE "model_provider" ADD CONSTRAINT "model_provider_connected_by_id_user_id_fkey" FOREIGN KEY ("connected_by_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
-- Whoever added a provider is taken to have connected it, as for connections; the ones every workspace starts with were added by nobody.
UPDATE "model_provider" SET "connected_by_id" = "created_by_id";
