ALTER TABLE "pod" RENAME TO "channel";--> statement-breakpoint
ALTER TABLE "pod_agent" RENAME TO "channel_bot";--> statement-breakpoint
ALTER TABLE "pod_member" RENAME TO "channel_member";--> statement-breakpoint
ALTER TABLE "thread" RENAME COLUMN "pod_id" TO "channel_id";--> statement-breakpoint
ALTER TABLE "notification_override" RENAME COLUMN "pod_id" TO "channel_id";--> statement-breakpoint
ALTER TABLE "channel_bot" RENAME COLUMN "pod_id" TO "channel_id";--> statement-breakpoint
ALTER TABLE "channel_member" RENAME COLUMN "pod_id" TO "channel_id";--> statement-breakpoint
ALTER TABLE "thread" RENAME CONSTRAINT "thread_pod_valid" TO "thread_channel_valid";--> statement-breakpoint
ALTER TABLE "channel" RENAME CONSTRAINT "pod_visibility_check" TO "channel_visibility_check";--> statement-breakpoint
ALTER INDEX "thread_pod_updated_at_idx" RENAME TO "thread_channel_updated_at_idx";--> statement-breakpoint
ALTER INDEX "thread_pod_chat_idx" RENAME TO "thread_channel_main_idx";--> statement-breakpoint
ALTER INDEX "notification_override_pod_idx" RENAME TO "notification_override_channel_idx";--> statement-breakpoint
ALTER INDEX "pod_slug_idx" RENAME TO "channel_slug_idx";--> statement-breakpoint
ALTER INDEX "pod_id_workspace_id_idx" RENAME TO "channel_id_workspace_id_idx";--> statement-breakpoint
ALTER INDEX "pod_agent_agent_id_idx" RENAME TO "channel_bot_agent_id_idx";--> statement-breakpoint
ALTER INDEX "pod_member_idx" RENAME TO "channel_member_idx";--> statement-breakpoint
ALTER INDEX "pod_member_user_id_idx" RENAME TO "channel_member_user_id_idx";--> statement-breakpoint
ALTER TABLE "thread" RENAME CONSTRAINT "thread_pod_workspace_fkey" TO "thread_channel_workspace_fkey";--> statement-breakpoint
ALTER TABLE "channel_bot" RENAME CONSTRAINT "pod_agent_pod_workspace_fkey" TO "channel_bot_channel_workspace_fkey";--> statement-breakpoint
ALTER TABLE "channel_bot" RENAME CONSTRAINT "pod_agent_agent_workspace_fkey" TO "channel_bot_agent_workspace_fkey";--> statement-breakpoint
ALTER TABLE "channel_member" RENAME CONSTRAINT "pod_member_pod_workspace_fkey" TO "channel_member_channel_workspace_fkey";--> statement-breakpoint
ALTER TABLE "channel_member" RENAME CONSTRAINT "pod_member_workspace_member_fkey" TO "channel_member_workspace_member_fkey";--> statement-breakpoint
DROP INDEX "notification_override_channel_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "notification_override_channel_idx" ON "notification_override" ("user_id","channel_id") WHERE "channel_id" is not null;--> statement-breakpoint
ALTER TABLE "notification_override" DROP CONSTRAINT "notification_override_one_place", ADD CONSTRAINT "notification_override_one_place" CHECK (num_nonnulls("channel_id", "agent_id") = 1);--> statement-breakpoint
ALTER TABLE "thread" DROP CONSTRAINT "thread_channel_valid", ADD CONSTRAINT "thread_channel_valid" CHECK (("type" = 'pod_chat') = ("channel_id" is not null));--> statement-breakpoint
-- Constraints Postgres named itself (primary keys, not-null constraints and the
-- foreign keys named for their columns) keep the old words in their names;
-- the ones a server has depend on its Postgres version, so each is renamed if it is there.
DO $$
DECLARE
	found record;
BEGIN
	FOR found IN
		SELECT conrelid::regclass AS on_table, conname AS name
		FROM pg_constraint
		WHERE connamespace = 'public'::regnamespace AND conname LIKE '%pod%'
	LOOP
		EXECUTE format(
			'ALTER TABLE %s RENAME CONSTRAINT %I TO %I',
			found.on_table,
			found.name,
			replace(replace(found.name, 'pod_agent', 'channel_bot'), 'pod', 'channel')
		);
	END LOOP;
END $$;--> statement-breakpoint
-- The triggers that put every owner and admin in every channel, and the lock
-- they share, read the tables by their old names, so they are made again.
DROP TRIGGER "shared_pod_administrators" ON "channel";--> statement-breakpoint
DROP TRIGGER "administrator_shared_pods" ON "workspace_member";--> statement-breakpoint
DROP FUNCTION add_administrators_to_new_shared_pod();--> statement-breakpoint
DROP FUNCTION add_new_administrator_to_shared_pods();--> statement-breakpoint
DROP FUNCTION lock_pod_membership(uuid);--> statement-breakpoint
-- Serialises every write that decides whether an administrator is in a channel. Without it, a channel made while somebody is promoted is missed by both: each insert runs before the other commits.
CREATE FUNCTION lock_channel_membership(workspace uuid) RETURNS void
LANGUAGE sql AS $$
	SELECT pg_advisory_xact_lock(hashtext('channel_membership:' || workspace::text));
$$;--> statement-breakpoint
-- The owner and admins are members of every channel, so `channel_member` is the whole list of who is in a channel.
CREATE FUNCTION add_administrators_to_new_channel() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	PERFORM lock_channel_membership(NEW."workspace_id");
	INSERT INTO "channel_member" ("workspace_id", "channel_id", "user_id")
	SELECT NEW."workspace_id", NEW."id", "user_id"
	FROM "workspace_member"
	WHERE "workspace_id" = NEW."workspace_id" AND "role" IN ('owner', 'admin')
	ON CONFLICT ("channel_id", "user_id") DO NOTHING;
	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER channel_administrators
AFTER INSERT ON "channel"
FOR EACH ROW EXECUTE FUNCTION add_administrators_to_new_channel();--> statement-breakpoint
-- Only adds: somebody demoted keeps the channels they are in, and leaves them one at a time.
CREATE FUNCTION add_new_administrator_to_channels() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	PERFORM lock_channel_membership(NEW."workspace_id");
	INSERT INTO "channel_member" ("workspace_id", "channel_id", "user_id")
	SELECT NEW."workspace_id", "id", NEW."user_id"
	FROM "channel"
	WHERE "workspace_id" = NEW."workspace_id"
	ON CONFLICT ("channel_id", "user_id") DO NOTHING;
	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER administrator_channels
AFTER INSERT OR UPDATE OF "role" ON "workspace_member"
FOR EACH ROW WHEN (NEW."role" IN ('owner', 'admin'))
EXECUTE FUNCTION add_new_administrator_to_channels();--> statement-breakpoint
-- The event a changed channel sends kept for clients that reconnect, by its new name.
UPDATE "event" SET "type" = 'channel.updated', "payload" = jsonb_set("payload", '{type}', '"channel.updated"')
WHERE "type" = 'pod.updated';
--> statement-breakpoint
-- A tool call's approval decided where it was raised is `conversation`'s to decide now.
UPDATE "event" SET "payload" = jsonb_set("payload", '{toolCall,approval,deciders}', '"conversation"')
WHERE "payload" #>> '{toolCall,approval,deciders}' = 'pod';
