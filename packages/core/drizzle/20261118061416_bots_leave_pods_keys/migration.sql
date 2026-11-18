ALTER TABLE "agent" DROP CONSTRAINT "agent_pod_workspace_fkey";--> statement-breakpoint
ALTER TABLE "pod" DROP CONSTRAINT "pod_owner_workspace_member_fkey";--> statement-breakpoint
ALTER TABLE "artifact" DROP CONSTRAINT "artifact_pod_workspace_fkey";--> statement-breakpoint
ALTER TABLE "thread" DROP CONSTRAINT "thread_origin_message_id_message_id_fkey";--> statement-breakpoint
ALTER TABLE "pod" DROP CONSTRAINT "pod_kind_check";--> statement-breakpoint
ALTER TABLE "pod" DROP CONSTRAINT "pod_personal_owner_check";--> statement-breakpoint
ALTER TABLE "pod" DROP CONSTRAINT "pod_personal_slug_check";--> statement-breakpoint
DROP INDEX "artifact_pod_updated_at_idx";--> statement-breakpoint
DROP INDEX "thread_pod_host_created_at_idx";--> statement-breakpoint
DROP INDEX "thread_pod_host_updated_at_idx";--> statement-breakpoint
DROP INDEX "thread_origin_message_idx";--> statement-breakpoint
DROP INDEX "thread_bot_channel_idx";--> statement-breakpoint
DROP INDEX "agent_pod_id_idx";--> statement-breakpoint
DROP INDEX "personal_pod_owner_idx";--> statement-breakpoint
DROP INDEX "pod_workspace_id_idx";--> statement-breakpoint
-- Their bots have left them, so a Personal pod has nothing left in it.
DELETE FROM "pod" WHERE "kind" = 'personal';--> statement-breakpoint
ALTER TABLE "model_request" DROP COLUMN "pod_id";--> statement-breakpoint
ALTER TABLE "agent" DROP COLUMN "pod_id";--> statement-breakpoint
ALTER TABLE "agent" DROP COLUMN "provisioned_key";--> statement-breakpoint
ALTER TABLE "pod" DROP COLUMN "owner_id";--> statement-breakpoint
ALTER TABLE "pod" DROP COLUMN "kind";--> statement-breakpoint
ALTER TABLE "artifact" DROP COLUMN "pod_id";--> statement-breakpoint
ALTER TABLE "thread" DROP COLUMN "origin_message_id";--> statement-breakpoint
ALTER TABLE "artifact" ALTER COLUMN "created_in_thread_id" SET NOT NULL;--> statement-breakpoint
-- Dropping `kind` took the partial index that named it.
DROP INDEX IF EXISTS "pod_slug_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "pod_slug_idx" ON "pod" ("workspace_id","slug");--> statement-breakpoint
CREATE INDEX "artifact_thread_updated_at_idx" ON "artifact" ("created_in_thread_id","updated_at");--> statement-breakpoint
CREATE INDEX "thread_pod_updated_at_idx" ON "thread" ("pod_id","updated_at");--> statement-breakpoint
CREATE INDEX "thread_host_updated_at_idx" ON "thread" ("host_agent_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_name_idx" ON "agent" ("workspace_id",lower("name")) WHERE "system_agent_key" is null and "assistant_of" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_handle_idx" ON "agent" ("workspace_id","handle") WHERE "system_agent_key" is null and "assistant_of" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_assistant_idx" ON "agent" ("workspace_id","assistant_of") WHERE "assistant_of" is not null;--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_assistant_workspace_member_fkey" FOREIGN KEY ("workspace_id","assistant_of") REFERENCES "workspace_member"("workspace_id","user_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "artifact" DROP CONSTRAINT "artifact_created_in_thread_id_thread_id_fkey", ADD CONSTRAINT "artifact_created_in_thread_id_thread_id_fkey" FOREIGN KEY ("created_in_thread_id") REFERENCES "thread"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "thread" ADD CONSTRAINT "thread_pod_valid" CHECK (("type" = 'pod_chat') = ("pod_id" is not null));--> statement-breakpoint
ALTER TABLE "thread" ADD CONSTRAINT "thread_direct_valid" CHECK (("type" = 'direct') = ("direct_key" is not null));--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_visibility_check" CHECK ("visibility" in ('public', 'private'));--> statement-breakpoint
ALTER TABLE "pod" ADD CONSTRAINT "pod_visibility_check" CHECK ("visibility" in ('public', 'private'));--> statement-breakpoint
ALTER TABLE "thread" DROP CONSTRAINT "thread_type_valid", ADD CONSTRAINT "thread_type_valid" CHECK ("type" in ('conversation', 'pod_chat', 'collaboration', 'routine', 'routine_feed', 'system_agent', 'direct'));--> statement-breakpoint
ALTER TABLE "thread" DROP CONSTRAINT "thread_host_valid", ADD CONSTRAINT "thread_host_valid" CHECK (("type" in ('pod_chat', 'direct')) = ("host_agent_id" is null));--> statement-breakpoint
-- Every pod is a channel now, so a new owner or admin joins every one.
CREATE OR REPLACE FUNCTION add_new_administrator_to_shared_pods() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	PERFORM lock_pod_membership(NEW."workspace_id");
	INSERT INTO "pod_member" ("workspace_id", "pod_id", "user_id")
	SELECT NEW."workspace_id", "id", NEW."user_id"
	FROM "pod"
	WHERE "workspace_id" = NEW."workspace_id"
	ON CONFLICT ("pod_id", "user_id") DO NOTHING;
	RETURN NULL;
END;
$$;