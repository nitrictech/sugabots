-- Who each sign-in signs in as, so a member leaving a workspace can take
-- theirs with them: who made a connector's OAuth sign-in or a model provider's
-- subscription sign-in, and who installed a GitHub app on their own GitHub
-- account. Until now nothing recorded these, so the best evidence fills them in.
ALTER TABLE "connector" ADD COLUMN "signed_in_by_id" uuid;--> statement-breakpoint
ALTER TABLE "connector" ADD COLUMN "installed_by_id" uuid;--> statement-breakpoint
ALTER TABLE "model_provider" ADD COLUMN "signed_in_by_id" uuid;--> statement-breakpoint
ALTER TABLE "connector" ADD CONSTRAINT "connector_signed_in_by_id_member_id_fkey" FOREIGN KEY ("signed_in_by_id") REFERENCES "member"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "connector" ADD CONSTRAINT "connector_installed_by_id_member_id_fkey" FOREIGN KEY ("installed_by_id") REFERENCES "member"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "model_provider" ADD CONSTRAINT "model_provider_signed_in_by_id_member_id_fkey" FOREIGN KEY ("signed_in_by_id") REFERENCES "member"("id") ON DELETE SET NULL;--> statement-breakpoint
-- A connector's sign-in recorded no signer, and its tokens are sealed, so
-- whoever added it is taken to have signed it in, as adding a built-in
-- connector does in one step. A record with no tokens in it, of a sign-in
-- still under way or refused, is taken to be theirs too.
UPDATE "connector" SET "signed_in_by_id" = "created_by_id"
WHERE "auth_kind" = 'oauth' AND "oauth_encrypted" IS NOT NULL;--> statement-breakpoint
-- Signing a model provider in made the signer who connected it, which only a
-- key given since, irrelevant to a provider that signs in, changes.
UPDATE "model_provider" SET "signed_in_by_id" = "connected_by_id"
WHERE "oauth_tokens_encrypted" IS NOT NULL;--> statement-breakpoint
-- A project's app is private, so it is installed only on the account that
-- owns it, and one a GitHub user owns was made on their own account by the
-- member who added it.
UPDATE "connector" SET "installed_by_id" = "created_by_id"
WHERE "kind" = 'github'
	AND "settings" -> 'owner' ->> 'type' = 'User'
	AND "settings" ->> 'installationId' IS NOT NULL;
